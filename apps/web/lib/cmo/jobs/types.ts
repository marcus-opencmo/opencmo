/**
 * Kiểu dùng chung của hàng đợi việc CMO. File thuần (không server-only) để
 * `jobs.check.ts` dựng được store giả trong bộ nhớ.
 */

import type { DocumentKind } from "../documents";

export type CmoJobKind = "plan_week" | "post_draft" | "sales_scan" | "video_pack" | "competitor_research" | "pull_metrics" | "summarize_memory" | "review_week";
export const CMO_JOB_KINDS: CmoJobKind[] = ["plan_week", "post_draft", "sales_scan", "video_pack", "competitor_research", "pull_metrics", "summarize_memory", "review_week"];

/** What a weekly goal counts. Only things the product can measure itself. */
export type GoalMetric = "posts" | "replies" | "clips" | "views";
export const GOAL_METRICS: GoalMetric[] = ["posts", "replies", "clips", "views"];
export type Goal = { id: string; week: string; goal: string; metric: GoalMetric; target: number; status: "proposed" | "approved" | "rejected"; result: number | null };
/** What a week reached: posts approved, Reddit replies the founder marked, clip packs approved, views on posts. */
export type WeekResults = Record<GoalMetric, number>;

/** What a memory or a lesson is about; a job reads its own topic plus `general`. */
export type MemoryTopic = "general" | "post" | "sales" | "video" | "research";
export const MEMORY_TOPICS: MemoryTopic[] = ["general", "post", "sales", "video", "research"];

/** Tier 2: one event (a preference the founder typed, a skip reason, a result). */
export type MemoryEvent = { kind: "preference" | "fact" | "feedback" | "result"; topic: MemoryTopic; body: string; created_at: string };

/** Tier 3: a weekly lesson for one topic; `week` is the Monday it covers. */
export type Lesson = { week: string; topic: MemoryTopic; body: string };

/** Điều W7 học được từ đối thủ: mọi mẫu đều có URL bài làm bằng chứng. */
export type CompetitorInsight = {
  accounts: { handle: string; posts: number; baseline: number; confidence: "low" | "ok" }[];
  hooks: { pattern: string; example: string; url: string; lift: number; why: string }[];
  formats: string[];
  ideas: { idea: string; inspired_by: string }[];
  measured_at: string;
};

/** Một lượt đo số liệu của bài đã đăng (W6-lite). */
export type MetricRow = { item_id: string; url: string; views: number; likes: number; replies: number; reposts: number };

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
  reply: string;
};

/** Một clip của job cắt, đủ để viết caption và dựng thẻ (W5). */
export type ClipInfo = { id: string; idx: number; hook: string; reason: string; start: number; end: number; score: number | null; text: string };

/** Trạng thái job cắt clip mà W5 đang chờ. */
export type ClipJob = { status: "queued" | "running" | "done" | "failed" | "cancelled"; error: string | null; createdAt: string; title: string | null; clips: ClipInfo[] };

/** Caption cho năm nền tảng của MỘT clip. */
export type PlatformCaptions = { tiktok: string; reels: string; shorts: string; facebook: string; threads: string };

/** Mọi đọc/ghi của một việc CMO đi qua đây: thật là Supabase (service role), test là bộ nhớ. */
export interface CmoStore {
  claim(runId?: string): Promise<QueuedRun | null>;
  step(run: QueuedRun, steps: Step[]): Promise<boolean>;
  complete(run: QueuedRun, ok: boolean, output: Record<string, unknown> | null, error: string | null): Promise<boolean>;
  documents(userId: string): Promise<Documents>;
  /** Unexpired notes, most important first; with a topic, that topic plus `general`. */
  memories(userId: string, limit: number, topic?: MemoryTopic): Promise<string[]>;
  /** Every note written since `since` (ISO), newest first, for the weekly summary. */
  memoryEvents(userId: string, since: string): Promise<MemoryEvent[]>;
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
  /** Job cắt clip của người dùng (W5); null khi không có hoặc không phải của họ. */
  clipJob(userId: string, jobId: string): Promise<ClipJob | null>;
  saveVideoPack(userId: string, runId: string, jobId: string, clips: Array<{ clip_id: string; hook: string; seconds: number; score: number | null }>, captions: Record<string, PlatformCaptions>): Promise<string>;
  /** Trả lượt về hàng đợi, hoãn `seconds` giây; false khi lượt đã bị nhận lại. */
  defer(run: QueuedRun, seconds: number, steps: Step[]): Promise<boolean>;
  /** W7: lưu điều học được; đọc bản mới nhất (Planner, X writer, CMO chat). */
  saveInsight(userId: string, runId: string, body: CompetitorInsight): Promise<void>;
  latestInsight(userId: string): Promise<CompetitorInsight | null>;
  /** W6-lite: số liệu bài đã đăng; chỉ nhận bài `published` của chính người dùng. */
  saveMetrics(userId: string, rows: MetricRow[]): Promise<number>;
}

/** Ngày theo UTC dạng YYYY-MM-DD, cộng `offset` ngày. Cùng mốc với `current_date` của Postgres (UTC). */
export function isoDay(offset = 0, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
}
