/**
 * One approval card (S3, `Cards.dc.html`): ten kinds, one anatomy.
 *
 * Head: department and kind. Body: the thing itself (`body`, one shape per kind). Foot: price, account, time.
 * The Dashboard queue shows `title` collapsed and `summary` + `meta` open; `/app/inbox/[id]` shows the full body.
 * A0 (`approvals` table) is the source of the common fields; the body comes from the row the card points at.
 */

import { z } from "zod";

import { profileOf } from "../cmo/platforms";

import { DepartmentSchema, PlatformSchema, QuoteSchema, SalesRuleSchema, ScorePartSchema, WhereSchema, day, iso } from "./common";

export const CARD_KINDS = [
  "post",
  "reply",
  "goal",
  "script",
  "price",
  "finished_video",
  "shorts_batch",
  "slideshow",
  "schedule",
  "correction",
] as const;
export const CardKindSchema = z.enum(CARD_KINDS);
export type CardKind = z.infer<typeof CardKindSchema>;

/** Same values as `approvals.status` (brain plan W1-2). */
/** `held`: past the daily card budget, waiting for a later day (P6 A4); never in the queue. */
export const CARD_STATUSES = ["waiting", "held", "approved", "edited", "skipped", "expired", "cancelled"] as const;
export const CardStatusSchema = z.enum(CARD_STATUSES);

/**
 * Why a card cannot simply be approved right now; the card shows the text in its state strip.
 * `decided_elsewhere`: approved or skipped on another device (`decidedVia`).
 */
export const CardProblemSchema = z.object({
  kind: z.enum(["expired", "decided_elsewhere", "needs_credits", "failed"]),
  text: z.string().max(200),
});

/** A platform profile id from `packages/contracts/platforms.json` (`x`, `threads`, `tiktok_caption`…). */
export const ProfileIdSchema = z.string().refine((id) => profileOf(id) !== null, "Unknown platform profile.");

const PostBody = z.object({
  kind: z.literal("post"),
  /** Platform tabs; each has its own versions. Limits come from the platform's profile (`platforms.json`). */
  platforms: z
    .array(
      z.object({
        platform: PlatformSchema,
        versions: z.array(z.string().max(3000)).min(1).max(3),
        limit: z.number().int().positive(),
        /** Characters shown before the platform's "more" on a phone (LinkedIn); null when the whole post shows. */
        visibleBeforeMore: z.number().int().positive().nullable(),
        // --- thread field (P6, owner A) ---
        /** An X thread (P6 W4): 5 to 8 posts, the first being `versions[0]`; absent for a single post. */
        thread: z.array(z.string().max(280)).min(5).max(8).optional(),
      }),
    )
    .min(1),
  checks: z.array(z.string().max(60)),
  /** "Why": the insight or plan line the draft came from. */
  why: z.string().max(200).nullable(),
});

const ReplyBody = z.object({
  kind: z.literal("reply"),
  community: z.string().max(80),
  threadTitle: z.string().max(300),
  threadUrl: z.url(),
  score: z.number().int().min(0).max(100),
  parts: z.array(ScorePartSchema),
  quotes: z.array(QuoteSchema),
  draft: z.string().max(10000),
  /** The subreddit rule line: "product mention allowed · you post it yourself". */
  rules: z.string().max(200),
  /**
   * The rule this draft was written under (P5 R1): `help_only` when the subreddit forbids self-promotion or the
   * founder already named the product in 1 of the last 10 replies; `text` says which. Absent on cards raised before
   * P5. A skipped thread has no card (it shows on the Sales screen only).
   */
  rule: SalesRuleSchema.optional(),
  /** Where the thread is (P6 R4): absent for Reddit, so cards raised before P6 parse as they did. */
  platform: z.literal("hn").optional(),
});

const GoalBody = z.object({
  kind: z.literal("goal"),
  goalId: z.string(),
  week: day,
  goal: z.string().max(200),
  metric: z.enum(["posts", "replies", "views"]),
  target: z.number().int().positive(),
  /** The week plan the goal comes with: one line per department. */
  plan: z.array(z.object({ what: z.string().max(120), department: DepartmentSchema })),
  budgetCredits: z.number().int().min(0).nullable(),
});

/**
 * Studio snapshots: what `approval_snapshot` (SQL, 20261228090000) stores for the four Studio kinds, field for
 * field, so the hash the founder approves covers exactly this. Paths and ids only, never signed URLs (a URL changes
 * on every read). The bodies below are what the card renders, built from a snapshot plus signed URLs.
 */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Words Writer made for one edit and one platform profile (P3 F8): a `content_items` row, department `video`,
 * `clip_id` the edit. In a finished video or shorts batch snapshot only when the edit has some, so a card raised
 * before captions existed keeps its hash.
 */
export const CaptionSnapshotSchema = z.object({
  caption_id: z.string(),
  clip_id: z.string(),
  profile: ProfileIdSchema,
  text: z.string().max(5000),
  /** The YouTube profile's title; null for every other profile. */
  title: z.string().max(100).nullable(),
});

/** One beat of the storyboard: the voice line, the keyframe (picture) and what moves during the beat. */
export const StoryBeatSchema = z.object({ words: z.string().max(300), picture: z.string().max(300), motion: z.string().max(300).nullable() });

/** One keyframe on the contact sheet (card 2) or the one being redone. */
const SheetKeyframeSnapshot = z.object({
  index: z.number().int().min(0),
  words: z.string().max(300),
  /** `media` bucket path of the keyframe image; null while it is not made yet. */
  path: z.string().max(500).nullable(),
  /** The text checker's badge: the keyframe may show garbled text. */
  garbled: z.boolean(),
  credits: z.number().int().min(0),
});

/** Card 1: storyboard + keyframe price (`studio_steps.kind = 'script'`). */
export const ScriptSnapshotSchema = z.object({
  kind: z.literal("script"),
  step_id: z.string(),
  clip_id: z.string(),
  tool: z.string(),
  title: z.string().max(200),
  seconds: z.number().positive().nullable(),
  aspect: z.enum(["9:16", "16:9", "1:1"]).nullable(),
  beats: z.array(StoryBeatSchema).max(40),
  /** Price of the keyframes, held when the founder approves. */
  price_credits: z.number().int().min(0),
});

/** Card 2 (contact sheet + video price) and a redone keyframe (`studio_steps.kind = 'price'`). */
export const PriceSnapshotSchema = z.object({
  kind: z.literal("price"),
  step_id: z.string(),
  clip_id: z.string(),
  tool: z.string(),
  title: z.string().max(200),
  what: z.string().max(200),
  seconds: z.number().positive().nullable(),
  wait_minutes: z.number().int().positive().nullable(),
  /** The contact sheet (card 2) or the one keyframe redone; empty when the price is for shots only. */
  keyframes: z.array(SheetKeyframeSnapshot).max(40),
  shots: z.number().int().min(0),
  price_credits: z.number().int().min(0),
});

/** One slide on a slideshow card: its text layer, its still (PNG) once rendered, and how long it shows. */
/** What `approval_snapshot` (SQL, 20270101100000) adds when the look check still found a problem on this render. */
export const LookSnapshotSchema = z.object({ pass: z.literal(false), round: z.number().int().min(0).max(1), note: z.string().max(200) });

export const SlideSnapshotSchema = z.object({
  text: z.string().max(300),
  /** `exports` bucket path of the slide's PNG from `render_stills`; null until the stills are rendered. */
  still_path: z.string().max(500).nullable(),
  seconds: z.number().positive(),
});

/**
 * The slideshow card (P5 S3, `studio_steps.kind = 'slideshow'`): the slides as built, the MP4 (`render_document`) and
 * the PNG set (`render_stills`, zipped) of this exact document. `document_hash` is read live from the edit, so any
 * change in the Slides view supersedes the card.
 */
export const SlideshowSnapshotSchema = z.object({
  kind: z.literal("slideshow"),
  step_id: z.string(),
  clip_id: z.string(),
  title: z.string().max(200),
  aspect: z.enum(["9:16", "16:9", "1:1"]).nullable(),
  slides: z.array(SlideSnapshotSchema).min(1).max(20),
  document_hash: sha256.nullable(),
  mp4_path: z.string().max(500).nullable(),
  png_set_path: z.string().max(500).nullable(),
  /** P5 A3: captions per platform, ordered when the card is raised and approved with it, as a finished video's. */
  captions: z.array(CaptionSnapshotSchema).max(12).optional(),
  look: LookSnapshotSchema.optional(),
});

/** Card 3: the render of the edit as it is now (`ref_kind = 'editor_project'`, `ref_id` = clip id). */
export const FinishedVideoSnapshotSchema = z.object({
  kind: z.literal("finished_video"),
  clip_id: z.string(),
  title: z.string().max(200),
  /** The document hash approving marks finished; any edit after it changes the hash and supersedes the card. */
  document_hash: sha256,
  /** The `render_document` task of this exact document; null while none is done. */
  render_task_id: z.string().nullable(),
  render_path: z.string().max(500).nullable(),
  seconds: z.number().positive().nullable(),
  captions: z.array(CaptionSnapshotSchema).max(12).optional(),
  look: LookSnapshotSchema.optional(),
});

/** Card 4: the shorts cut from one finished edit, approved together (`ref_kind = 'short_batch'`). */
export const ShortsBatchSnapshotSchema = z.object({
  kind: z.literal("shorts_batch"),
  batch_id: z.string(),
  parent_clip_id: z.string(),
  title: z.string().max(200),
  parent_hash: sha256,
  shorts: z
    .array(
      z.object({
        short_id: z.string(),
        /** The short's own edit (`clips.kind = 'short'`); null until the Builder made it. */
        short_clip_id: z.string().nullable(),
        start: z.number().min(0),
        end: z.number().positive(),
        hook: z.string().max(120),
        reason: z.string().max(300),
      }),
    )
    .max(3),
  /** Captions of every short in the batch (`clip_id` = the short's own edit). */
  captions: z.array(CaptionSnapshotSchema).max(36).optional(),
  look: LookSnapshotSchema.optional(),
});

export const StudioSnapshotSchema = z.discriminatedUnion("kind", [
  ScriptSnapshotSchema,
  PriceSnapshotSchema,
  FinishedVideoSnapshotSchema,
  ShortsBatchSnapshotSchema,
  SlideshowSnapshotSchema,
]);
export type StudioSnapshot = z.infer<typeof StudioSnapshotSchema>;

/** `approvals.ref_kind` per Studio card kind. */
export const STUDIO_REF_KIND = {
  script: "studio_step",
  price: "studio_step",
  finished_video: "editor_project",
  shorts_batch: "short_batch",
  slideshow: "studio_step",
} as const;

const ScriptBody = z.object({
  kind: z.literal("script"),
  stepId: z.string(),
  seconds: z.number().positive().nullable(),
  aspect: z.enum(["9:16", "16:9", "1:1"]).nullable(),
  beats: z.array(StoryBeatSchema).min(1),
  /** Price of the next stage (keyframes), shown before anything is spent. */
  nextPriceCredits: z.number().int().min(0).nullable(),
});

const PriceBody = z.object({
  kind: z.literal("price"),
  stepId: z.string(),
  what: z.string().max(200),
  /** Contact sheet tiles; each has its own Redo (a new `price` card for that keyframe). Empty for shots only. */
  keyframes: z.array(
    z.object({ index: z.number().int().min(0), label: z.string().max(300), thumbUrl: z.url().nullable(), garbled: z.boolean(), credits: z.number().int().min(0) }),
  ),
  shots: z.number().int().min(0),
  seconds: z.number().positive(),
  readyInMinutes: z.number().int().positive().nullable(),
});

/** One caption on a finished video or shorts card, editable before approving (`edit_caption`). */
export const CaptionSchema = z.object({
  id: z.string(),
  profile: ProfileIdSchema,
  text: z.string().max(5000),
  title: z.string().max(100).nullable(),
});
export type Caption = z.infer<typeof CaptionSchema>;

const FinishedVideoBody = z.object({
  kind: z.literal("finished_video"),
  clipId: z.string(),
  /** Sent back with "Mark finished": a later edit refuses it. */
  documentHash: sha256,
  seconds: z.number().positive(),
  /** Signed URL of the render; null until the render is done. */
  previewUrl: z.url().nullable(),
  /** Seconds into the render shown as the still before it plays. */
  frameAt: z.number().min(0),
  /** One per platform profile: captions and the YouTube title and description. */
  captions: z.array(CaptionSchema).max(12),
  // --- look-note field (P6, owner A) ---
  /** P6 S4: what the look check still found after one send-back (`snapshot.look.note`); absent when it passed or did not run. */
  lookNote: z.string().max(200).optional(),
});

const ShortsBatchBody = z.object({
  kind: z.literal("shorts_batch"),
  batchId: z.string(),
  parentClipId: z.string(),
  source: z.string().max(200),
  /** The squad cuts 3; fewer only when the reviewer found fewer good ranges. */
  shorts: z
    .array(
      z.object({
        shortClipId: z.string().nullable(),
        start: z.number().min(0),
        end: z.number().positive(),
        hook: z.string().max(120),
        reason: z.string().max(300),
        previewUrl: z.url().nullable(),
        captions: z.array(CaptionSchema).max(12),
      }),
    )
    .min(1)
    .max(3),
  // --- look-note field (P6, owner A) ---
  /** P6 S4: what the look check still found after one send-back (`snapshot.look.note`); absent when it passed or did not run. */
  lookNote: z.string().max(200).optional(),
});

const SlideshowBody = z.object({
  kind: z.literal("slideshow"),
  stepId: z.string(),
  clipId: z.string(),
  /** Sent back with the decision: an edit in the Slides view after the card was raised refuses it. */
  documentHash: sha256.nullable(),
  aspect: z.enum(["9:16", "16:9", "1:1"]).nullable(),
  /** Quick text edits per slide happen on the card; "Open in Slides" opens `clipId` in the Slides view. */
  slides: z
    .array(z.object({ text: z.string().max(300), stillUrl: z.url().nullable(), seconds: z.number().positive() }))
    .min(1)
    .max(20),
  /** Signed URLs; null until rendered. */
  previewUrl: z.url().nullable(),
  pngSetUrl: z.url().nullable(),
  /** P5 A3: one per platform it will be posted to, editable before approving (`edit_caption`), as on a finished video. */
  captions: z.array(CaptionSchema).max(12).optional(),
  // --- look-note field (P6, owner A) ---
  /** P6 S4: what the look check still found after one send-back (`snapshot.look.note`); absent when it passed or did not run. */
  lookNote: z.string().max(200).optional(),
});

/**
 * The platform's own fields on a schedule card (P4 F4), stored on the slot (`schedule_slots.options`) and part of what
 * the founder approves. TikTok's privacy and interaction toggles come from the account's creator info; the
 * AI-generated label is the founder's toggle on every platform, off by default (owner, 2026-10-26).
 */
export const ScheduleOptionsSchema = z
  .object({
    /** One of the account's privacy levels from TikTok creator info (`PUBLIC_TO_EVERYONE`…); TikTok only. */
    privacy: z.string().max(40).optional(),
    allow_comment: z.boolean().optional(),
    allow_duet: z.boolean().optional(),
    allow_stitch: z.boolean().optional(),
    /** TikTok's commercial content disclosure: promoting the founder's own business, or a paid partnership. */
    brand_organic: z.boolean().optional(),
    brand_content: z.boolean().optional(),
    ai_label: z.boolean().optional(),
  })
  .strict();
export type ScheduleOptions = z.infer<typeof ScheduleOptionsSchema>;

/**
 * What `approval_snapshot('schedule_slot', …)` (SQL, 20261230090000) stores, field for field: the content going out,
 * the time in UTC, the account and the platform fields. `content_hash` covers the words (and the edit for a video), so
 * editing either after approving supersedes the card; jitter is not part of it.
 */
export const ScheduleSnapshotSchema = z.object({
  kind: z.literal("schedule"),
  slot_id: z.string(),
  deliverable_id: z.string(),
  deliverable_kind: z.enum(["post", "video", "short", "slideshow"]),
  platform: PlatformSchema.exclude(["reddit"]),
  /** `intent`: no connected account for the platform, so the founder copies and opens it themselves. */
  mode: z.enum(["publish", "intent"]),
  account_id: z.string().nullable(),
  handle: z.string().max(100).nullable(),
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`; shown in the founder's timezone. */
  publish_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  options: ScheduleOptionsSchema,
  /** Why the last attempt failed; set on the card a failed or missed slot raises. */
  last_error: z.string().max(500).nullable(),
  /** The edit for a video or short; null for a text post. */
  clip_id: z.string().nullable(),
  /** The post, or the video's caption for this platform; null while a video has no caption for it. */
  text: z.string().max(5000).nullable(),
  /** The YouTube title; null elsewhere. */
  title: z.string().max(100).nullable(),
  content_hash: sha256,
  /**
   * A post's image (P5 B4): its cover still, part of `content_hash`. Present only when the post has one, so cards of
   * posts without an image keep the hash they had.
   */
  image: z.object({ clip_id: z.string(), object: z.string().max(500), bytes: z.number().int().positive().nullable() }).optional(),
  /** An X thread (P6 W4): its 5 to 8 posts, the first being `text`; part of `content_hash`. Absent for a single post. */
  thread: z.array(z.string().max(280)).min(5).max(8).optional(),
});
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshotSchema>;

/**
 * A schedule time as the routes take it: with its offset, and to the second at most. The card's snapshot keeps whole
 * seconds, so a fraction would make the approved time never match the slot's.
 */
export const PublishAtSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d/.test(value), "Pick a time to the minute (no fractions of a second).");

/** `approvals.ref_kind` of a schedule card; `ref_id` is the slot. */
export const SCHEDULE_REF_KIND = "schedule_slot" as const;

const ScheduleBody = z.object({
  kind: z.literal("schedule"),
  slotId: z.string(),
  what: z.string().max(200),
  where: WhereSchema,
  /** The founder's connected account; null = no account for the platform (copy and open instead, F9). */
  accountId: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  mode: z.enum(["publish", "intent"]),
  at: iso,
  /** IANA name the time is shown and picked in (`profiles.timezone`). */
  timezone: z.string().max(64),
  why: z.string().max(200).nullable(),
  /** What goes out: the words, the YouTube title, and the video's signed preview URL (null for a text post). */
  preview: z.object({ text: z.string().max(5000).nullable(), title: z.string().max(100).nullable(), videoUrl: z.url().nullable() }),
  options: ScheduleOptionsSchema,
  /**
   * TikTok's creator info for the account (read live through the publish adapter, not part of the hash): the privacy
   * levels the selector offers and the toggles the account has turned off. Null on other platforms.
   */
  tiktok: z
    .object({
      privacyLevels: z.array(z.string().max(40)).min(1),
      commentDisabled: z.boolean(),
      duetDisabled: z.boolean(),
      stitchDisabled: z.boolean(),
    })
    .nullable(),
  /** The reason the last attempt failed or was missed; the card offers Retry. */
  lastError: z.string().max(500).nullable(),
  /**
   * The slot behind the card (`schedule-enrich.ts`, from `schedule_slots`): `failed` offers Retry, `missed` is a new
   * time after the old one passed, `no_account` is the copy-and-open moment of a post with no connected account,
   * `unconfirmed` is a post Zernio took but never confirmed (the founder checks; never a blind Retry).
   */
  state: z.enum(["waiting", "failed", "missed", "no_account", "unconfirmed"]),
  /** The live post, once it went out. */
  publishedUrl: z.url().nullable(),
});

const CorrectionBody = z.object({
  kind: z.literal("correction"),
  correctionId: z.string(),
  rule: z.string().max(200),
  /** The repeated edit the rule comes from (`cmo_draft_outcomes.edit_mode`); null for rules from skip reasons. */
  editMode: z.string().max(40).nullable(),
  /** How many edits it was learned from. */
  times: z.number().int().min(0),
  /** The edits the rule was learned from: draft line → what the founder wrote. */
  examples: z.array(z.object({ before: z.string().max(300), after: z.string().max(300) })),
});

export const CardBodySchema = z.discriminatedUnion("kind", [
  PostBody,
  ReplyBody,
  GoalBody,
  ScriptBody,
  PriceBody,
  FinishedVideoBody,
  ShortsBatchBody,
  SlideshowBody,
  ScheduleBody,
  CorrectionBody,
]);
export type CardBody = z.infer<typeof CardBodySchema>;

export const ApprovalCardSchema = z
  .object({
    id: z.string(),
    kind: CardKindSchema,
    department: DepartmentSchema,
    status: CardStatusSchema,
    /** Collapsed line: the post's first line, the thread title, the video name. */
    title: z.string().max(300),
    /** Open line in the queue: one or two sentences on what approving does. */
    summary: z.string().max(400),
    /** Foot line: checks, price note, account, time. */
    meta: z.string().max(200),
    priceCredits: z.number().int().min(0).nullable(),
    postAt: iso.nullable(),
    account: WhereSchema.nullable(),
    raisedAt: iso,
    expiresAt: iso.nullable(),
    decidedAt: iso.nullable(),
    decidedVia: z.enum(["app", "email", "push", "mcp"]).nullable(),
    problem: CardProblemSchema.nullable(),
    /** What the founder sees, hashed (JCS + sha256). Sent back with the decision; a changed card refuses it. */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    body: CardBodySchema,
  })
  .refine((card) => card.body.kind === card.kind, { message: "The body kind must match the card kind.", path: ["body"] });
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;

/** The one filled button of each kind; it always does what the head names. */
export const PRIMARY_ACTION: Record<CardKind, string> = {
  post: "Approve",
  reply: "Copy and open thread",
  goal: "Approve week",
  script: "Approve script",
  price: "Approve price",
  finished_video: "Approve: finished",
  shorts_batch: "Approve batch",
  slideshow: "Approve",
  schedule: "Approve time",
  correction: "Keep as a rule",
};

/**
 * Words on a finished video or shorts card: `edit_caption {caption, text, title?}` changes one caption before the
 * card is approved. The card keeps its id and gets a new hash, so a tab showing the old words is refused.
 */
export const CAPTION_ACTION = "edit_caption";

/**
 * Studio actions (`approval_decide`, A1), named as `components/cards/decide.ts` sends them: redo one keyframe on a
 * contact sheet, cancel a script or a price (releases any hold), send back a finished video or a shorts batch.
 * Editing a beat (`edit {beat, text}`) re-plans the script and raises a new card.
 */
export const STUDIO_ACTIONS: Record<"script" | "price" | "finished_video" | "shorts_batch" | "slideshow", readonly string[]> = {
  script: ["approve", "edit", "cancel"],
  price: ["approve", "redo", "cancel"],
  finished_video: ["approve", "send_back"],
  shorts_batch: ["approve", "send_back"],
  /** P5: rendered before the card, so approving runs nothing; text edits go through the Slides view. */
  slideshow: ["approve", "send_back"],
};

/**
 * Schedule actions (`approval_decide`, P4 A1). `approve` and `retry` take the card as it is; `change_time {publish_at}`,
 * `change_account {account_id}` and `set_options {options}` change the slot and raise a new card (the old one is
 * superseded); `cancel` drops the slot.
 */
export const SCHEDULE_ACTIONS = ["approve", "change_time", "change_account", "set_options", "cancel", "retry"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

/**
 * Kinds whose decision works now (wave 1 A0; P2 A1 Studio steps and the finished video, A3 the shorts batch; P4 A1 schedule); the others show their
 * button disabled with the reason. The name stays so `components/cards/decide.ts` keeps reading it.
 */
export const DECIDABLE_IN_WAVE_1: ReadonlySet<CardKind> = new Set([
  "post",
  "reply",
  "goal",
  "correction",
  "script",
  "price",
  "finished_video",
  "shorts_batch",
  "slideshow",
  "schedule",
]);
