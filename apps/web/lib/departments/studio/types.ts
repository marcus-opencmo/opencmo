/**
 * The Studio adapter's contract (P2 B0): the one way into Studio's Video agent team for the brain, the
 * Assistant, MCP and the UI (`docs/architecture/studio.md` §5, `brain.md` §7b).
 *
 * Every entry point runs under the founder's RLS session (`StudioContext.supabase`): a brain order
 * brings a short-lived user JWT as MCP does, and the service role never writes an editor document.
 * A priced step is planned first (price, nothing spent) and runs only on a decision: MCP carries the
 * prepared step in its signed confirm code, the brain and the UI store it as a `studio_steps` row
 * behind an approval card. The team owns how a video is made; callers only say what they want.
 */

import { z } from "zod";

import type { SupabaseClient } from "@/lib/api/handler";
import type { ToolOutcome } from "@/lib/agent/tools";
import { BRIEF_ASPECTS, SlideSchema, type VideoBrief } from "@/lib/cmo/writer/types";

/** Who calls Studio. `ui` is the founder's own buttons (Mark finished, Cut shorts) over `/api/v1/studio`. */
export const STUDIO_CALLERS = ["brain", "assistant", "mcp", "ui"] as const;
export type StudioCaller = (typeof STUDIO_CALLERS)[number];

export const STUDIO_ENTRIES = ["plan", "decide", "buildVideo", "cutShorts", "markFinished", "renderShort", "buildSlideshow", "buildPostImage"] as const;
export type StudioEntry = (typeof STUDIO_ENTRIES)[number];

/**
 * Who may call each entry point; the capability registry (`packages/contracts/capabilities.json`)
 * lists the same pairs. `buildVideo` and `renderShort` are the brain's: the founder and MCP make a
 * video with `create_video` through `plan`. Marking an edit finished is the founder's call only (a
 * finished-video card approved in the inbox reaches it through `approval_decide`, i.e. the UI). The
 * founder's `cutShorts` ("Cut shorts") only orders a `cut_shorts` order; the brain's runner cuts it.
 * Only the brain stores a planned step (`plan` with `store`): MCP signs it, the Assistant shows it.
 */
export const STUDIO_ACCESS: Record<StudioEntry, readonly StudioCaller[]> = {
  plan: ["brain", "assistant", "mcp"],
  decide: ["brain", "assistant", "mcp", "ui"],
  buildVideo: ["brain"],
  cutShorts: ["brain", "ui"],
  markFinished: ["ui"],
  renderShort: ["brain"],
  buildSlideshow: ["brain"],
  buildPostImage: ["brain"],
};

export const mayCall = (caller: StudioCaller, entry: StudioEntry): boolean => STUDIO_ACCESS[entry].includes(caller);

/**
 * The video brief is Writer's (`lib/cmo/writer/types.ts`, P3 B0): Writer writes it before a video and
 * `buildVideo` takes it, so both sides share one type.
 */
export { BRIEF_ASPECTS, VideoBriefSchema, type VideoBrief } from "@/lib/cmo/writer/types";

/** The Studio tools that are planned and decided (MCP's `PRICED` set). */
export type StudioTool = string;

/** A planned step, ready to run on approval: what MCP signs and `studio_steps.input` stores. */
export type PreparedStep = { clipId: string; tool: StudioTool; input: unknown };

/** `plan`'s answer. `priced` is the card; nothing is spent until `decide` approves it. */
export type StudioPlan =
  | {
      kind: "priced";
      credits: number;
      /** One line per change, as the in-app card lists them. */
      lines: string[];
      /** Card 1 of a long take: the Director's beats. */
      storyboard?: unknown;
      /** Card 2 of a long take: the keyframes to animate. */
      sheet?: unknown;
      prepared: PreparedStep;
      /** Set when the plan was stored (`store`): the `studio_steps` row whose card now waits. */
      stepId?: string;
    }
  /** The tool could not be planned: the founder (or the client) reads `message` and fixes the input. */
  | { kind: "invalid"; message: string }
  /** The price is more than the account holds: `message` says how to top up. Nothing is stored. */
  | { kind: "short"; message: string; credits: number };

export type PlanOptions = {
  /** Brain only: store the step and raise its card (`studio_step_raise`). */
  store?: boolean;
  /** With `store`: the step a redone keyframe replaces. */
  redoOf?: string;
  /**
   * With `store`: a storyboard step the founder sent back with one beat rewritten (`edit`). `create_video`
   * is planned again from that step (the input passed is ignored), under the step's own order.
   */
  editOf?: string;
};

/** A stored step (`studio_steps.id`), or one carried in a signed code (MCP). */
export type StepRef = { stepId: string } | { prepared: PreparedStep };

export type StudioAction =
  | { kind: "approve" }
  | { kind: "cancel" }
  /** Card 2 only: make keyframe `index` again; the step keeps waiting with a new card. */
  | { kind: "redo"; index: number };

export type StudioDecision = {
  outcome: ToolOutcome;
  /** Set when the step queued a generation: poll it (or the order waits on it). */
  generationId?: string;
  /** Set when the step queued exports (`request_export`): one `{ frame, task_id }` per file. */
  exports?: Record<string, unknown>[];
  /** True when the step changed the edit's document. */
  wrote: boolean;
  /** Card 1 approved: the step to raise (card 2) once the generations in `waitFor` are done. */
  next?: { tool: StudioTool; input: unknown; waitFor: string[] };
  /** What went wrong after the step itself succeeded (the Brand Kit could not be applied). */
  notes?: string[];
};


/** `buildVideo`'s answer: the blank edit made for the brief and the step that waits on card 1. */
export type BuiltVideo =
  | { kind: "waiting"; clipId: string; stepId: string; credits: number }
  | { kind: "invalid"; message: string };

/** One range the Shorts squad cuts, in the parent edit's timeline seconds. */
export type ShortRange = {
  start: number;
  end: number;
  /** The first spoken line, said in the first 3 s. */
  hook: string;
  title: string;
  /** Why this range: hook, flow, value (shown on the batch card). */
  reason: string;
};

export type OrderedShorts = { kind: "ordered"; orderId: string } | { kind: "refused"; message: string };

export type CutShorts =
  | { kind: "cut"; batchId: string; shorts: { shortId: string; clipId: string; range: ShortRange }[] }
  /** Not finished, finished at another document, or nothing worth cutting. */
  | { kind: "refused"; message: string };

export type MarkedFinished =
  | { kind: "finished"; finishedAt: string; hash: string }
  /** The founder saw another version than the one saved: nothing is marked. */
  | { kind: "stale"; message: string };

export type RenderedShort = { kind: "queued"; taskId: string } | { kind: "refused"; message: string };

/**
 * The Slideshow squad's brief (P5 B0, `studio.md` §7). The squads spend no credits (owner, 2026-10-30): they use the
 * founder's screenshots, captured pages and Brand Kit; an AI image is the founder's own `/image`, priced as always.
 */
export const SlideshowBriefSchema = z.object({
  idea: z.string().trim().min(3).max(500),
  /** Writer's `write_slides` output; SQL copies it into the order's brief. */
  slides: z.array(SlideSchema).min(5).max(10),
  aspect: z.enum(BRIEF_ASPECTS).default("9:16"),
});
export type SlideshowBrief = z.infer<typeof SlideshowBriefSchema>;

/** The Post image squad's brief (`studio.md` §8). With no source, the title sits on the Brand Kit background. */
export const PostImageBriefSchema = z.object({
  /** The `content_item` the image is attached to. */
  postId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  platform: z.string().min(1).max(40),
  source: z.union([z.object({ clipId: z.string().uuid(), time: z.number().min(0) }), z.object({ captureId: z.string().uuid() })]).optional(),
});
export type PostImageBrief = z.infer<typeof PostImageBriefSchema>;

/** Both tasks render one revision, so the MP4 and the PNG set show the same document. */
export type BuiltSlideshow =
  | { kind: "rendering"; clipId: string; mp4TaskId: string; stillsTaskId: string }
  | { kind: "invalid"; message: string };

export type BuiltPostImage = { kind: "rendering"; clipId: string; stillsTaskId: string } | { kind: "invalid"; message: string };

/**
 * `render_stills` (worker `render_stills_task.py`): one PNG per slide, drawn at its midpoint with text kept, and a zip
 * of the set. Objects stay at three path levels in `exports`: `<user>/<clip>/<task>-01.png`, `<user>/<clip>/<task>.zip`.
 */
export type RenderStillsInput = { editor_revision_id: string; source_hash: string; bucket: "exports"; object: string; still_prefix: string; manifest: unknown };
export type RenderStillsOutput = {
  stills: { index: number; object: string; bytes: number }[];
  zip: { object: string; bytes: number };
  /** The slide TikTok photo mode shows first; the hook. */
  cover_index: number;
  width: number;
  height: number;
  count: number;
  manifest: Record<string, unknown>;
};

/**
 * Who drives the call. `orderId` ties planned steps, shorts and renders to the brain's work order;
 * absent for the Assistant, MCP and the founder's buttons.
 */
export type StudioContext = {
  supabase: SupabaseClient;
  userId: string;
  caller: StudioCaller;
  orderId?: string;
};

export interface StudioAdapter {
  /** Price a Studio tool on an edit; nothing is spent. Stored behind a card only with `store` (brain). */
  plan(clipId: string, tool: StudioTool, input: unknown, options?: PlanOptions): Promise<StudioPlan>;
  /** Run, cancel or redo a planned step. A cancelled step releases any hold and changes nothing. */
  decide(step: StepRef, action: StudioAction): Promise<StudioDecision>;
  /** Brain only: a blank edit for the brief, the Director's plan, and card 1 raised as a `studio_steps` row. */
  buildVideo(brief: VideoBrief): Promise<BuiltVideo>;
  /**
   * Shorts from an edit marked finished at its current document. The brain cuts three, each its own
   * `short` edit; the founder ("Cut shorts") orders a `cut_shorts` order for the brain to cut.
   */
  cutShorts(clipId: string): Promise<CutShorts | OrderedShorts>;
  /** The founder marks the edit finished at the document hash they saw. */
  markFinished(clipId: string, hash: string): Promise<MarkedFinished>;
  /** Queue `render_document` for a short's own edit, with no editor open and no founder session. */
  renderShort(shortClipId: string): Promise<RenderedShort>;
  /** Brain only: a slideshow edit from Writer's slides, its MP4 and PNG set queued; the card comes when both are done. */
  buildSlideshow(brief: SlideshowBrief): Promise<BuiltSlideshow>;
  /** Brain only: an image for a post, from a frame or a captured page; SQL writes the deliverable when it is rendered. */
  buildPostImage(brief: PostImageBrief): Promise<BuiltPostImage>;
}
