/**
 * Writer's CMO runs (P3 W3; run contract in `docs/plans/cmo/2026-10-28-p3-sessions/A.md`, "A2: Writer's orders").
 * SQL starts each run for its work order (`writer_order_start`, never with `brain`), charges its credit and reads
 * what it returns:
 *
 *   write_video_brief  {idea, reason, seconds, aspect, platform} → { brief: VideoBrief, reason }; SQL copies the brief
 *                      into the `build_video` order that waits on it (the Director's input)
 *   write_caption      {clip_ids, profiles}                      → each caption saved with `cmo_save_caption` (it
 *                      refreshes the card and keeps a caption the founder edited) → { reason, saved, failed }
 *   write_slides       {idea, reason, count}                     → { slides, reason } (S3 in P5 orders it)
 *
 * Every kind goes through `createWriter().draft()`: the kind's fixed prompt, the founder's rules and voice as data,
 * code checks, one fix round.
 */

import { CAPTION_WRITERS, POST_WRITERS, type AgentId } from "../agents/registry";
import { insightBlock, nicheBlock } from "../jobs/context";
import { genModel } from "../jobs/edit-taxonomy";
import { fakeAllowed, LlmError } from "../jobs/llm";
import type { JobContext, JobOutput } from "../jobs/runner";
import { CAPTION_PROFILES, profileOf } from "../platforms";
import { captionText } from "./checks";
import { writerMemory } from "./context";
import { createWriter, writerPromptVersion, type WriterDeps } from "./draft";
import { BRIEF_ASPECTS, type VideoSource, type WriterContext, type WriterKind, type WriterProfile } from "./types";

/** The registry agent for a kind and profile: one per platform profile, one for briefs, one for slides. */
export function writerAgent(kind: WriterKind, profile: WriterProfile | null): AgentId {
  if (kind === "video_brief") return "brief_writer";
  if (kind === "slides") return "slides_writer";
  return (profile && (kind === "post" ? POST_WRITERS : CAPTION_WRITERS)[profile.id]) || (kind === "post" ? "x_writer" : "instagram_writer");
}

/** At most this many edits per caption run: a shorts batch has three, a finished video one. */
export const CAPTION_CLIPS_MAX = 6;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The writer for one run: the job's model call, a fix round only on OpenCMO's own brain, the model that answered. */
function runWriter(ctx: JobContext, labelSuffix = "") {
  const seen = { model: null as string | null };
  const deps: WriterDeps = {
    think: (opts) => ctx.think(opts),
    agentFor: writerAgent,
    canFix: !fakeAllowed() && ctx.brain === "opencmo",
    onUsage: (usage) => {
      seen.model = usage.model;
    },
    ...(labelSuffix ? { labelSuffix } : {}),
  };
  return { writer: createWriter(deps), gen: (kind: WriterKind) => ({ model: genModel(seen.model, ctx.brain, fakeAllowed()), prompt_version: writerPromptVersion(kind) }) };
}

async function readContext(ctx: JobContext, topic: "post" | "video", withInsight: boolean, withNiche = false): Promise<WriterContext> {
  const { store, run } = ctx;
  return ctx.step("read_doc", "Read your strategy and how you write", async () => {
    const [documents, memory, insight, niche] = await Promise.all([
      store.documents(run.user_id),
      writerMemory(store, run.user_id, topic),
      withInsight ? store.latestInsight(run.user_id) : null,
      withNiche ? store.latestNicheInsight(run.user_id) : null,
    ]);
    const research = withInsight ? insightBlock(insight) : "";
    const video = nicheBlock(niche);
    return {
      documents,
      ...memory,
      recent: [],
      ...(research ? { insight: research } : {}),
      ...(video ? { niche: video, nicheUrls: niche!.videos.map((v) => v.url) } : {}),
    };
  });
}

export async function writeVideoBrief(ctx: JobContext): Promise<JobOutput> {
  const input = ctx.run.input;
  const idea = text(input.idea, 300);
  if (idea.length < 3) throw new LlmError("This video has no idea to write a brief for.");
  const seconds = typeof input.seconds === "number" && Number.isFinite(input.seconds) ? Math.min(90, Math.max(5, Math.round(input.seconds))) : undefined;
  const aspect = (BRIEF_ASPECTS as readonly unknown[]).includes(input.aspect) ? (input.aspect as (typeof BRIEF_ASPECTS)[number]) : undefined;
  const reason = text(input.reason, 300);
  const context = await readContext(ctx, "video", true, true);
  const { writer } = runWriter(ctx);
  const out = await ctx.step(
    "write_brief",
    "Writing the video brief",
    () => writer.draft("video_brief", null, { idea, ...(reason ? { reason } : {}), ...(seconds ? { seconds } : {}), ...(aspect ? { aspect } : {}) }, context),
    (done) => `Brief: ${done.brief.hooks.length} hooks, ${done.brief.seconds} s, ${done.brief.aspect}`,
  );
  // Only links the research read: a URL the model wrote itself is dropped (P5 F8). SQL copies them into the video order.
  const known = new Set(context.nicheUrls ?? []);
  const sources = [...new Set(out.learnedFrom.filter((url) => known.has(url)))].slice(0, 6);
  return { brief: out.brief, reason: out.rationale, sources };
}

export async function writeSlides(ctx: JobContext): Promise<JobOutput> {
  const input = ctx.run.input;
  const idea = text(input.idea, 300);
  if (idea.length < 3) throw new LlmError("This slideshow has no idea to write.");
  const count = typeof input.count === "number" && Number.isInteger(input.count) ? Math.min(10, Math.max(5, input.count)) : undefined;
  const reason = text(input.reason, 300);
  const context = await readContext(ctx, "post", true);
  const { writer } = runWriter(ctx);
  const out = await ctx.step(
    "write_slides",
    "Writing the slides",
    () => writer.draft("slides", null, { idea, ...(reason ? { reason } : {}), ...(count ? { count } : {}) }, context),
    (done) => `${done.slides.length} slides`,
  );
  return { slides: out.slides, reason: out.rationale };
}

const CAPTION_CONCURRENCY = 3;

/** Runs `tasks` with at most `limit` at once. The first failure fails the whole and starts nothing more, as a loop would. */
async function inPool(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && next < tasks.length) {
      try {
        await tasks[next++]!();
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
}

/**
 * Captions for each edit and each profile the plan targets. One that fails our checks twice is left out (the card
 * shows the others); a run that saves none fails, and its credit is refunded.
 */
export async function writeCaption(ctx: JobContext): Promise<JobOutput> {
  const { store, run } = ctx;
  const clipIds = Array.isArray(run.input.clip_ids) ? [...new Set(run.input.clip_ids.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, CAPTION_CLIPS_MAX) : [];
  const allowed = new Set(CAPTION_PROFILES.map((p) => p.id));
  const wanted = Array.isArray(run.input.profiles) ? run.input.profiles.filter((id): id is string => typeof id === "string" && allowed.has(id)) : [];
  const profiles = [...new Set(wanted)].map((id) => profileOf(id)!);
  if (!clipIds.length || !profiles.length) throw new LlmError("There is no video or platform to write captions for.");

  const context = await readContext(ctx, "video", false);
  let saved = 0;
  const failed: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  for (const [index, clipId] of clipIds.entries()) {
    const video: VideoSource | null = await ctx.step(`read_video_${index}`, "Reading what the video says", () => store.videoSource(run.user_id, clipId), (v) => (v ? `${v.title} · ${Math.round(v.seconds)} s` : "Video not found"));
    if (!video) {
      failed.push(`A video is gone (${clipId}).`);
      continue;
    }
    const suffix = clipIds.length > 1 ? `_${index}` : "";
    for (const profile of profiles) {
      // A writer per caption, so each records the model that wrote it even while they run side by side.
      const { writer, gen } = runWriter(ctx, suffix);
      tasks.push(async () => {
        try {
          await ctx.step(`write_caption_${profile.id}${suffix}`, `Writing the ${profile.label}`, async () => {
            if (profile.kind === "youtube") {
              const out = await writer.draft("youtube", profile, { video }, context);
              await store.saveCaption(run.user_id, run.id, clipId, profile.id, captionText({ text: out.description, hashtags: out.hashtags }), out.title, gen("youtube"));
            } else {
              const out = await writer.draft("caption", profile, { video }, context);
              await store.saveCaption(run.user_id, run.id, clipId, profile.id, captionText(out), null, gen("caption"));
            }
            saved += 1;
          }, () => `${profile.label} on the card`);
        } catch (error) {
          // A check that failed twice drops this caption only; anything else (the store, the network) fails the run.
          if (!(error instanceof LlmError)) throw error;
          failed.push(`${profile.label}: ${error.message}`);
        }
      });
    }
  }
  // Up to 6 clips × 4 profiles is 24 captions, each one to three model calls: a few at a time keeps a run short. The founder's
  // Claude answers one inbox question at a time, so an inbox run asks in order.
  await inPool(tasks, ctx.brain === "opencmo" && !fakeAllowed() ? CAPTION_CONCURRENCY : 1);
  if (!saved) throw new LlmError(`No caption passed our checks. ${failed.join(" ")}`.slice(0, 480));
  const reason = `${saved} ${saved === 1 ? "caption" : "captions"} on the card${failed.length ? `; ${failed.length} left out` : ""}.`;
  return { reason, saved, failed };
}
