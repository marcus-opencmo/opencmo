/**
 * The one send-back after a failed look check (P6 S4, round 0 → round 1).
 *
 * Renders are keyed on the document's hash (`renderRequestId`), so rendering again without a change
 * returns the same task and the same file: a send-back only helps when the squad can change the edit.
 * Today that is the long take's last assembly step (`finishVideo`), which attaches voice-overs and their
 * captions that finished after the render, the usual cause of a silent or caption-less export. Shorts are
 * cut from a finished edit and slideshows already passed their own reviewer, so nothing is redone for
 * them: the card is raised at once with the note. Saying "unchanged" is the honest answer, never a
 * render that would cost the founder's daily export limit for the same file.
 */

import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { finishVideo } from "./finish";
import { LookResultSchema, lookSendBack, type LookCardKind, type LookQuestionId, type LookSendBack } from "./look-check";
import { renderEdit } from "./render";
import type { StudioContext } from "./types";

/** What a send-back did: new renders to check as round 1, or nothing to redo (raise the card now). */
export type LookRedo = { kind: "rerendered"; taskIds: string[] } | { kind: "unchanged" };

/** Failures `finishVideo` can fix: a voice-over (sound, captions) that arrived after the render. */
const FIXED_BY_FINISH: readonly LookQuestionId[] = ["sound_present", "captions_inside", "text_readable"];

/** Whether a send-back is worth trying for this card kind and these failures (no I/O). */
export function redoable(sendBack: Pick<LookSendBack, "kind">, failed: readonly LookQuestionId[]): boolean {
  return sendBack.kind === "finished_video" && failed.some((id) => FIXED_BY_FINISH.includes(id));
}

export async function redoAfterLook(ctx: StudioContext, sendBack: LookSendBack, failed: readonly LookQuestionId[]): Promise<LookRedo> {
  if (!redoable(sendBack, failed)) return { kind: "unchanged" };
  const taskIds: string[] = [];
  for (const issue of sendBack.issues) {
    const finished = await finishVideo(ctx, issue.clipId);
    // Nothing attached: the document is the same, so a render would return the same file.
    if (finished.attached === 0) continue;
    taskIds.push(await renderEdit(ctx, issue.clipId));
  }
  return taskIds.length ? { kind: "rerendered", taskIds } : { kind: "unchanged" };
}

/** A send-back as A's `studio_look_sendbacks_claim` returns it (`look` is the round-0 task output). */
type Claimed = { check_id: string; ref_kind: "editor_project" | "short_batch" | "studio_step"; ref_id: string; user_id: string; order_id: string | null; look: unknown };

const CARD_OF: Record<Claimed["ref_kind"], LookCardKind> = { editor_project: "finished_video", short_batch: "shorts_batch", studio_step: "slideshow" };

/**
 * Claims the send-backs waiting and redoes each once. `contextFor` gives the squad's session for the founder
 * (the brain's RLS client). Nothing to redo → the card is raised now with the round-0 note, never left
 * waiting for SQL's hour-long give-up.
 */
export async function runLookSendBacks(admin: SupabaseClient, contextFor: (userId: string, orderId: string | null) => StudioContext, limit = 5): Promise<number> {
  const claimed = (await rpcOrThrow<Claimed[]>(admin, "studio_look_sendbacks_claim", { p_limit: limit })) ?? [];
  for (const row of claimed) {
    const result = LookResultSchema.safeParse(row.look);
    let redo: LookRedo = { kind: "unchanged" };
    if (result.success) {
      const sendBack = lookSendBack(CARD_OF[row.ref_kind], row.ref_id, result.data);
      const failed = [...new Set(result.data.files.flatMap((f) => f.answers.filter((a) => a.pass === false).map((a) => a.id)))];
      try {
        redo = await redoAfterLook(contextFor(row.user_id, row.order_id), sendBack, failed);
      } catch (error) {
        console.error("[look-redo]", row.check_id, error);
      }
    }
    if (redo.kind !== "unchanged") continue;
    // If this call fails, SQL's hour-long give-up still raises the card: the founder is never left without it.
    await rpcOrThrow(admin, "studio_look_sendback_unchanged", { p_check: row.check_id }).catch((error: unknown) => console.error("[look-redo] raise", row.check_id, error));
  }
  return claimed.length;
}
