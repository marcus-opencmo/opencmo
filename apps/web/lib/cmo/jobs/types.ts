/**
 * Kiểu dùng chung của hàng đợi việc CMO. File thuần (không server-only) để
 * `jobs.check.ts` dựng được store giả trong bộ nhớ.
 */

import type { DocumentKind } from "../documents";
import type { VideoSource } from "../writer/types";
import type { AccountMetricRow } from "./metrics-source";

export type CmoJobKind =
  | "plan_week"
  | "post_draft"
  | "sales_scan"
  | "competitor_research"
  | "pull_metrics"
  | "summarize_memory"
  | "review_week"
  | "write_video_brief"
  | "write_caption"
  | "write_slides"
  | "publish_post"
  | "niche_video_research";
export const CMO_JOB_KINDS: CmoJobKind[] = ["plan_week", "post_draft", "sales_scan", "competitor_research", "pull_metrics", "summarize_memory", "review_week", "write_video_brief", "write_caption", "write_slides", "publish_post", "niche_video_research"];

/** What a weekly goal counts. Only things the product can measure itself. */
export type GoalMetric = "posts" | "replies" | "views";
export const GOAL_METRICS: GoalMetric[] = ["posts", "replies", "views"];
export type Goal = { id: string; week: string; goal: string; metric: GoalMetric; target: number; status: "proposed" | "approved" | "rejected"; result: number | null };
/** What a week reached: posts approved, Reddit replies the founder marked, views on posts. */
export type WeekResults = Record<GoalMetric, number>;

/** What a memory or a lesson is about; a job reads its own topic plus `general`. */
export type MemoryTopic = "general" | "post" | "sales" | "video" | "research";
export const MEMORY_TOPICS: MemoryTopic[] = ["general", "post", "sales", "video", "research"];

/** Tier 2: one event (a preference the founder typed, a skip reason, a result). */
export type MemoryEvent = { kind: "preference" | "fact" | "feedback" | "result"; topic: MemoryTopic; body: string; created_at: string };

/** Tier 3: a weekly lesson for one topic; `week` is the Monday it covers. */
/** A voice note as `voice_notes_for` returns it: the founder's own words from one decision, and its platform. */
export type VoiceNoteRow = { body: string; platform: string | null; created_at: string; weight: number };

export type Lesson = { week: string; topic: MemoryTopic; body: string };

/** Điều W7 học được từ đối thủ: mọi mẫu đều có URL bài làm bằng chứng. */
export type CompetitorInsight = {
  accounts: { handle: string; posts: number; baseline: number; confidence: "low" | "ok" }[];
  hooks: { pattern: string; example: string; url: string; lift: number; why: string }[];
  formats: string[];
  ideas: { idea: string; inspired_by: string }[];
  measured_at: string;
};

/**
 * What works on short video in the founder's niche (P5 R2): standout shorts on TikTok and YouTube for the strategy's
 * topics. Only text, numbers and the URL are kept, never the video; a video without a URL from the read is dropped.
 */
export type NicheVideoInsight = {
  topics: string[];
  videos: {
    platform: "tiktok" | "youtube";
    url: string;
    author: string;
    views: number;
    /** Views over the median of the same search. */
    lift: number;
    /** The opening line as said or captioned, cut to 200 characters. */
    hook: string;
    format: string;
    why: string;
  }[];
  formats: string[];
  measured_at: string;
};

/**
 * One measurement of a published post. `source` says who read it (P6): `public` is the public reading through the
 * social reader, `zernio` the numbers of a post that went out through Zernio. Missing optional fields are unreported.
 */
export type MetricRow = {
  item_id: string;
  url: string;
  /** Null: not reported (stored as null, never zero). The public reading always has all four. */
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  source?: "public" | "zernio";
  impressions?: number | null;
  engagements?: number | null;
};

/** A post a slot published through Zernio, with the calendar item its numbers belong to. */
export type ZernioPostRow = {
  item_id: string | null;
  external_id: string;
  external_url: string | null;
  platform: string;
  social_account_id: string | null;
  zernio_account_id: string | null;
  published_at: string;
};

/** A replied thread due its outcome check (SQL `cmo_reply_outcomes_due`). `reply` is what the founder posted. */
export type ReplyOutcomeDue = {
  outcome_id: string;
  opportunity_id: string;
  platform: "reddit" | "hn";
  url: string;
  community: string;
  reply: string;
  outcome_url: string | null;
};

export type ConnectedAccountRow = { id: string; platform: AccountMetricRow["platform"]; handle: string; zernio_account_id: string };

export type StepStatus = "running" | "done" | "failed" | "skipped";
export type Step = { tool: string; label: string; status: StepStatus };

export type QueuedRun = {
  id: string;
  user_id: string;
  kind: CmoJobKind;
  input: Record<string, unknown>;
  attempt: number;
};

export type ItemStatus = "planned" | "drafting" | "in_review" | "approved" | "published" | "skipped" | "failed";

export type ItemRow = {
  id: string;
  run_id: string | null;
  department: "post" | "sales" | "video";
  platform: string;
  day: string;
  idea: string;
  reason: string;
  status: ItemStatus;
  priority: "high" | "medium" | "low";
  body: Record<string, unknown>;
  final_text: string | null;
  external_url: string | null;
  decided_at: string | null;
  published_at: string | null;
  created_at: string;
};

export type PlanItem = { department: "post" | "sales" | "video"; platform: string; day: string; idea: string; reason: string };

export type Documents = Partial<Record<DocumentKind, Record<string, unknown>>>;

/** Một phần của điểm cơ hội: số + câu trích bằng chứng (hiện ở ngăn kéo thẻ Sales). */
export type ScorePart = { label: "Pain" | "Fit" | "Timing" | "Reach" | "Evidence"; score: number; max: number; evidence: string };

/** Một thread Reddit đáng tham gia, sẵn sàng thành thẻ (W4). */
export type Opportunity = {
  url: string;
  community: string;
  title: string;
  author: string;
  snippet: string;
  posted_at: string | null;
  comments: number;
  score: number;
  score_parts: ScorePart[];
  /** Empty for a skipped thread: it is kept for the Sales screen, with no draft and no card. */
  reply: string;
  /** Which model and prompt drafted the reply (`edit-taxonomy.ts`). */
  gen?: { model: string; prompt_version: string };
  /** P5 R1: the rule the draft was written under, and why ("r/x forbids self-promotion"). */
  rule?: SubredditVerdict;
  rule_why?: string;
  /** P6 R4: where the thread is. Omitted means Reddit (the column's default). */
  platform?: "reddit" | "hn";
};

/** What a subreddit's rules allow (P5 R1): name the product, help only, or stay out. */
export type SubredditVerdict = "mention_ok" | "help_only" | "skip";
export type SubredditRule = { subreddit: string; verdict: SubredditVerdict; summary: string; read_at: string };
/** The founder's Sales settings (`sales_settings`). */
export type SalesSettings = { excluded: string[]; pairs: [string, string][] };

/** Who thinks for a run: OpenCMO's own models, or the founder's Claude through the inbox. */
export type Brain = "opencmo" | "claude";

/** A model call a run could not make itself, as the founder's Claude reads it in the inbox. */
export type InboxRequest = {
  /** What Claude is asked to do, one line. */
  title: string;
  /** The agent that would have answered (`lib/cmo/agents/registry.ts`). */
  agent: string;
  system: string;
  prompt: string;
  /** JSON Schema of the answer: the job validates it with the same zod schema. */
  schema: Record<string, unknown>;
};

/** What an inbox replay starts from: the answers given so far, and the step results kept between rounds. */
export type InboxState = { answers: Record<string, unknown>; memo: Record<string, unknown> };

/** Mọi đọc/ghi của một việc CMO đi qua đây: thật là Supabase (service role), test là bộ nhớ. */
export interface CmoStore {
  claim(runId?: string): Promise<QueuedRun | null>;
  step(run: QueuedRun, steps: Step[]): Promise<boolean>;
  complete(run: QueuedRun, ok: boolean, output: Record<string, unknown> | null, error: string | null): Promise<boolean>;
  documents(userId: string): Promise<Documents>;
  /**
   * Unexpired notes, most important first; with a topic, that topic plus `general`. `voice: false` leaves out the
   * voice notes (rows learned from a decision), for a writer that reads them on their own through `voiceNotes`.
   */
  memories(userId: string, limit: number, topic?: MemoryTopic, opts?: { voice?: boolean }): Promise<string[]>;
  /** The founder's voice notes (`voice_notes_for`), newest first, with a weight that falls from 1 to 0 with age. */
  voiceNotes(userId: string, limit: number): Promise<VoiceNoteRow[]>;
  /** Every note written since `since` (ISO), newest first, for the weekly summary. */
  memoryEvents(userId: string, since: string): Promise<MemoryEvent[]>;
  /** An edit's own words for its captions (read as the founder, under RLS); null when the edit is not theirs. */
  videoSource(userId: string, clipId: string): Promise<VideoSource | null>;
  /** One caption for one edit and profile (`cmo_save_caption`, which checks it again); a founder's edit is kept. */
  saveCaption(userId: string, runId: string, clipId: string, profile: string, text: string, title: string | null, gen: Record<string, unknown>): Promise<void>;
  /** Memory tier 0: the founder's active rules (`cmo_corrections`), newest first. */
  corrections(userId: string): Promise<string[]>;
  /** The latest lesson for each topic. */
  lessons(userId: string): Promise<Lesson[]>;
  saveLessons(userId: string, runId: string, week: string, lessons: { topic: MemoryTopic; body: string }[]): Promise<number>;
  /** The goal for the week starting `week` (Monday), whatever its status. */
  goal(userId: string, week: string): Promise<Goal | null>;
  /** What happened since `since` (ISO), counted per goal metric. */
  weekResults(userId: string, since: string): Promise<WeekResults>;
  /** Proposes a goal for the founder to approve; null when that week's goal is already approved. */
  proposeGoal(userId: string, runId: string, week: string, goal: { goal: string; metric: GoalMetric; target: number }): Promise<Goal | null>;
  recordGoalResult(userId: string, week: string, result: number): Promise<boolean>;
  items(userId: string, filter: { statuses?: ItemStatus[]; since?: string; department?: ItemRow["department"]; limit?: number }): Promise<ItemRow[]>;
  planWeek(userId: string, runId: string, items: PlanItem[]): Promise<number>;
  saveDraft(userId: string, runId: string, itemId: string | null, idea: string, body: Record<string, unknown>, priority: ItemRow["priority"]): Promise<ItemRow>;
  /** Link thread đã từng thành thẻ (kể cả đã bỏ) — W4 không đưa lại. */
  seenUrls(userId: string): Promise<Set<string>>;
  saveOpportunities(userId: string, runId: string, items: Opportunity[]): Promise<number>;
  /** P5 R1: a subreddit's cached verdict (any age; the scan decides what is fresh), and saving a new one. */
  subredditRule(subreddit: string): Promise<SubredditRule | null>;
  saveSubredditRule(rule: Omit<SubredditRule, "read_at">): Promise<void>;
  salesSettings(userId: string): Promise<SalesSettings>;
  /** Product mentions in the founder's last ten posted replies (SQL `sales_mention_count_for`). */
  recentMentions(userId: string): Promise<number>;
  /** Drafts already handed out that may name the product and still wait on the founder: they count toward the rule. */
  waitingMentions(userId: string): Promise<number>;
  /** Trả lượt về hàng đợi, hoãn `seconds` giây; false khi lượt đã bị nhận lại. */
  defer(run: QueuedRun, seconds: number, steps: Step[]): Promise<boolean>;
  /** W7: lưu điều học được; đọc bản mới nhất (Planner, X writer, CMO chat). */
  saveInsight(userId: string, runId: string, body: CompetitorInsight): Promise<void>;
  latestInsight(userId: string): Promise<CompetitorInsight | null>;
  /** P5 R2: niche video research, saved as `cmo_insights.kind = 'niche_video'`; Writer's video brief reads the latest. */
  saveNicheInsight(userId: string, runId: string, body: NicheVideoInsight): Promise<void>;
  latestNicheInsight(userId: string): Promise<NicheVideoInsight | null>;
  /** W6-lite: số liệu bài đã đăng; chỉ nhận bài `published` của chính người dùng. */
  saveMetrics(userId: string, rows: MetricRow[]): Promise<number>;
  /** P6 A1: published slots Zernio can measure, newest first (SQL `cmo_zernio_posts`). */
  zernioPosts(userId: string, since: string): Promise<ZernioPostRow[]>;
  /** P6 A1: the founder's Zernio profile and connected accounts; no profile = nothing connected. */
  connectedAccounts(userId: string): Promise<{ zernioProfileId: string | null; accounts: ConnectedAccountRow[] }>;
  saveAccountMetrics(userId: string, rows: AccountMetricRow[]): Promise<number>;
  /** P6 A2: recomputes the founder's best hours from their numbers (SQL `best_slots_refresh`); returns hours stored. */
  refreshBestSlots(userId: string): Promise<number>;
  /** P6 A3: replies three days old and never checked. */
  replyOutcomesDue(userId: string, limit: number): Promise<ReplyOutcomeDue[]>;
  /** P6 A3: stores one check (once); false when it was already checked. */
  saveReplyOutcome(userId: string, outcomeId: string, check: { status: "found" | "not_found" | "gone"; votes: number | null; replies: number | null }): Promise<boolean>;
  /** The inbox item a replay run answers; null when it is gone or not the user's. */
  inbox(userId: string, inboxId: string): Promise<InboxState | null>;
  /** Writes the waiting model call to the run's inbox item and ends the run; null when the lease was lost. */
  openInbox(run: QueuedRun, step: string, request: InboxRequest, memo: Record<string, unknown>): Promise<string | null>;
  /** A replay ended: closes the item, or reopens it with the reason the answer failed. */
  finishInbox(run: QueuedRun, ok: boolean, feedback: string | null): Promise<void>;
}

/** Ngày theo UTC dạng YYYY-MM-DD, cộng `offset` ngày. Cùng mốc với `current_date` của Postgres (UTC). */
export function isoDay(offset = 0, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
}
