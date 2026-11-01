/**
 * The look check's contract (P6 B0, S4; `docs/architecture/studio.md` §9).
 *
 * Green renders are not proof a video is usable: the worst failures are silent (captions off-screen, a
 * black or frozen stretch, an export with no sound). So before a video, short or slideshow card is
 * raised, the worker task `look_check` reads the **full-size export** (never a `*.preview.mp4`), draws
 * up to 12 frames, and answers fixed questions: three by code (black, frozen, sound), one by moderation,
 * two by a vision judge (captions inside the frame, text readable).
 *
 * A failure goes back to the squad once (round 0 → round 1); the second result goes on the card as a
 * note, pass or fail, so the founder decides with the problem in view. Nothing here spends credits.
 */

import { z } from "zod";

/**
 * When the check runs (owner, 2026-10-31, `studio.md` §12 #6): only before a card. Draft renders in the
 * editor are never checked, so they stay as fast as before and cost nothing extra.
 */
export const LOOK_CHECK_RULE = "before_card" as const;

/** At most this many frames per file, the `look` endpoint's own cap (`look.py` `MAX_TIMES`). */
export const LOOK_MAX_FRAMES = 12;

/** How many times a failed check sends the work back to its squad before the card shows the note. */
export const LOOK_SEND_BACKS = 1;

/**
 * The fixed questions. `by` says who answers: code (ffmpeg filters, no model), the content check every frame
 * goes through (product rule: AI media only with moderation), or the vision judge. A slideshow skips the
 * frozen check (its slides hold on purpose).
 * Ids are shared with the worker (`look_check_task.py` `QUESTIONS`); keep both lists in step.
 */
export const LOOK_QUESTIONS = [
  { id: "no_black_frames", by: "code", ask: "No black stretch longer than half a second" },
  { id: "no_frozen_frames", by: "code", ask: "No frozen picture longer than four seconds" },
  { id: "sound_present", by: "code", ask: "The export has an audio track that is not silent" },
  { id: "content_allowed", by: "moderation", ask: "Every frame passes the content check" },
  { id: "captions_inside", by: "judge", ask: "Every caption sits fully inside the frame" },
  { id: "text_readable", by: "judge", ask: "On-screen text is readable: not garbled, cut off or too small" },
] as const;
export type LookQuestionId = (typeof LOOK_QUESTIONS)[number]["id"];
export const LOOK_QUESTION_IDS = LOOK_QUESTIONS.map((q) => q.id) as [LookQuestionId, ...LookQuestionId[]];

/** The cards that wait on a look check, and the ref each card is raised for (`STUDIO_REF_KIND`). */
export const LOOK_CARD_KINDS = ["finished_video", "shorts_batch", "slideshow"] as const;
export type LookCardKind = (typeof LOOK_CARD_KINDS)[number];

export const LookAnswerSchema = z
  .object({
    id: z.enum(LOOK_QUESTION_IDS),
    /** `null`: not answered (no vision key, judge error). Never counts as a fail. */
    pass: z.boolean().nullable(),
    /** One English sentence for the founder; empty on a pass. */
    why: z.string().max(200),
    /** Seconds into the file where the problem shows, when there is one place. */
    at: z.number().min(0).optional(),
  })
  .strict();
export type LookAnswer = z.infer<typeof LookAnswerSchema>;

/** One checked file. A shorts batch has one per short, a long take or slideshow one. */
export const LookFileResultSchema = z
  .object({
    /** Storage path in the `exports` bucket: the full-size `<task>.mp4`, never `*.preview.mp4`. */
    path: z.string().min(1).refine((p) => !p.endsWith(".preview.mp4"), "The look check reads the full-size export"),
    /** The clip the file belongs to (a short's own clip for a batch), so a send-back redoes only it. */
    clipId: z.string().uuid(),
    pass: z.boolean(),
    answers: z.array(LookAnswerSchema).max(LOOK_QUESTIONS.length),
    frameTimes: z.array(z.number().min(0)).max(LOOK_MAX_FRAMES),
  })
  .strict();
export type LookFileResult = z.infer<typeof LookFileResultSchema>;

/** The worker's answer, stored on the task's output and in the card's snapshot. */
export const LookResultSchema = z
  .object({
    pass: z.boolean(),
    /** 0: first check; 1: after the one send-back. Round 1 always reaches the card. */
    round: z.number().int().min(0).max(LOOK_SEND_BACKS),
    files: z.array(LookFileResultSchema).min(1).max(20),
    /** The card's note: one or two English sentences, empty on a pass. No model names. */
    note: z.string().max(200),
  })
  .strict();
export type LookResult = z.infer<typeof LookResultSchema>;

/** The worker task's input (`tasks.payload` of a `look_check` task), written by the SQL rules. */
export const LookCheckInputSchema = z
  .object({
    ref_kind: z.enum(["editor_project", "short_batch", "studio_step"]),
    ref_id: z.string().uuid(),
    round: z.number().int().min(0).max(LOOK_SEND_BACKS),
    files: z
      .array(z.object({ path: z.string().min(1), clip_id: z.string().uuid() }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type LookCheckInput = z.infer<typeof LookCheckInputSchema>;

/**
 * What a squad gets when its work comes back (round 0 failed): the failed files and the founder-readable
 * reasons. The squad redoes only those files, once; then the new render is checked as round 1.
 */
export type LookSendBack = {
  kind: LookCardKind;
  refId: string;
  round: 1;
  issues: { clipId: string; path: string; reasons: string[] }[];
};

/** Round 0 failed: the squad gets one more go. Round 1, or a pass: the card is raised with the result. */
export function lookNextStep(result: LookResult): "raise_card" | "send_back" {
  return !result.pass && result.round < LOOK_SEND_BACKS ? "send_back" : "raise_card";
}

/** The send-back a failed round-0 result asks for. */
export function lookSendBack(kind: LookCardKind, refId: string, result: LookResult): LookSendBack {
  return {
    kind,
    refId,
    round: 1,
    issues: result.files
      .filter((f) => !f.pass)
      .map((f) => ({
        clipId: f.clipId,
        path: f.path,
        reasons: f.answers.filter((a) => a.pass === false).map((a) => a.why || askOf(a.id)),
      })),
  };
}

const askOf = (id: LookQuestionId): string => LOOK_QUESTIONS.find((q) => q.id === id)?.ask ?? id;

/**
 * The card's note from a result: what failed, where, in plain words. Empty on a pass. Written by the
 * worker too; this is the reference the TS side and its checks use.
 */
export function lookNote(result: Pick<LookResult, "files">): string {
  const failed = result.files.flatMap((f) =>
    f.answers.filter((a) => a.pass === false).map((a) => (a.at !== undefined ? `${a.why || askOf(a.id)} (at ${fmt(a.at)})` : a.why || askOf(a.id))),
  );
  if (failed.length === 0) return "";
  const head = `Look check: ${failed.slice(0, 2).join("; ")}`;
  const more = failed.length > 2 ? ` and ${failed.length - 2} more` : "";
  return `${head}${more}.`.slice(0, 200);
}

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
