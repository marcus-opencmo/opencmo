/**
 * Hợp đồng dữ liệu của màn AI CMO (docs/cmo/san-pham.md §3.2–3.3, §4.2).
 *
 * UI đi trước: mọi thứ màn 4 cột cần nằm ở đây thành kiểu. Backend của từng việc
 * (W1–W7) xong tới đâu thì `loadWorkspace` đổ dữ liệu thật vào đúng kiểu đó, UI
 * không đổi. `live` nói phần nào đã có backend thật.
 *
 * File thuần (không server-only): component client import được kiểu.
 */

import type { DocumentKind } from "./documents";

export type Department = "post" | "sales" | "video";
export type JobId = "W0" | "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "W7" | "W8";

/** Một agent trong danh sách "Your agents": department × nền tảng. */
export type AgentSummary = {
  department: Department;
  name: string;
  channels: string;
  goal: string;
  /** Tên thứ agent làm ra, số ít/số nhiều: "2 posts ready". */
  unit: [string, string];
  ready: number;
  /** ISO; lần chạy theo lịch kế tiếp, null khi chưa có lịch. */
  nextRun: string | null;
  /** Chạy được bằng tay ngay bây giờ (backend của việc đó đã có). */
  runnable: boolean;
};

/** Mức gấp của thẻ trong Inbox — agent đặt; UI xếp và tô theo nó. */
export type Priority = "high" | "medium" | "low";

export type PostCard = {
  id: string;
  priority: Priority;
  department: "post";
  platform: "x";
  title: string;
  text: string;
  alternates: string[];
  rationale: string;
  scheduledFor: string | null;
  createdAt: string;
  /** review = chờ duyệt; approved = đã duyệt, chờ người dùng đăng trên X (đăng hỗ trợ, W3). */
  state: "review" | "approved";
  /** Chữ người dùng đã duyệt (có thể đã sửa). */
  finalText: string | null;
};

export type ScorePart = { label: "Pain" | "Fit" | "Timing" | "Reach" | "Evidence"; score: number; max: number; evidence: string };

export type SalesCard = {
  id: string;
  priority: Priority;
  department: "sales";
  platform: "reddit";
  title: string;
  /** `postedAt` null khi nguồn không cho biết giờ đăng. */
  thread: { title: string; community: string; url: string; author: string; postedAt: string | null; snippet: string; comments: number };
  score: number;
  parts: ScorePart[];
  reply: string;
  createdAt: string;
};

export type ClipPreview = {
  id: string;
  title: string;
  seconds: number;
  hook: string;
  /** Video xem trước (bản preview của engine); vắng = chỉ hiện hook. */
  previewUrl?: string;
  /** Chữ từng nền tảng cho clip này (W5): tiktok, reels, shorts, facebook, threads. */
  captions?: Record<string, string>;
  /** Bản tải về sau khi duyệt: task export trên worker. */
  download?: { taskId: string; status: "queued" | "running" | "done" | "failed" | "cancelled" } | null;
};

export type VideoCard = {
  id: string;
  priority: Priority;
  department: "video";
  title: string;
  source: string;
  clips: ClipPreview[];
  platforms: string[];
  projectId: string | null;
  createdAt: string;
  /** Thẻ thật: chờ duyệt, hoặc đã duyệt và đang/đã dựng bản tải về. Mẫu thì vắng. */
  state?: "review" | "approved";
};

export type InboxCard = PostCard | SalesCard | VideoCard;

export type Metrics = {
  windowDays: number;
  tiles: { label: string; value: number; change: number | null; hint: string }[];
  /** Lượt xem mỗi ngày, cũ → mới. */
  views: number[];
  top: { title: string; platform: string; views: number } | null;
};

/** "What works now" của W7 (cột Results): hook có URL bài làm bằng chứng. */
export type InsightView = { measuredAt: string; hooks: { pattern: string; example: string; url: string; lift: number }[]; ideas: string[] };

/** Bốn điểm Lighthouse (0–100) cho một loại máy. */
export type PageSpeed = { performance: number; accessibility: number; bestPractices: number; seo: number };
export type Vital = { label: "LCP" | "FCP" | "TBT" | "CLS"; value: string; pass: boolean };

/** Tab SEO của cột Analytics: PageSpeed + Core Web Vitals của trang chủ. */
export type SeoMetrics = {
  pagespeed: { mobile: PageSpeed; desktop: PageSpeed };
  vitals: { mobile: Vital[]; desktop: Vital[] };
  auditedAt: string;
  /** Đã nối Google Analytics / Search Console chưa (W6 đọc số thật từ đó). */
  google: { analytics: boolean; searchConsole: boolean };
};

/** Tab Links: trang của chính site và link trỏ về đã biết. */
export type LinkRow = { url: string; kind: "page" | "backlink"; title: string; note: string };

export type LogStep = { tool: string; label: string; status: "done" | "running" | "failed" | "skipped" };
export type LogEntry = {
  id: string;
  job: JobId;
  title: string;
  status: "queued" | "running" | "done" | "failed";
  startedAt: string;
  detail: string | null;
  steps: LogStep[];
};

export type CalendarItem = {
  id: string;
  day: string;
  department: Department;
  platform: string;
  idea: string;
  reason: string;
  /** Mục `planned` thật: sửa/xoá được. Mục mẫu và mục đã thành bài thì không. */
  editable: boolean;
  /** Mục video còn mở: link tab Clips của editor (người dùng tự đưa video của họ). */
  clipsHref?: string;
};

export type ChatMessage = { id: string; role: "user" | "cmo"; text: string };

/** Gợi ý sửa tài liệu ở cột Context — tính thật từ document (`lib/cmo/suggest.ts`). */
export type Suggestion = { label: string; href: string };

export type Workspace = {
  /** Dữ liệu mẫu (chỉ dev/preview) — UI hiện băng "Demo data". */
  demo: boolean;
  site: string;
  project: { name: string; category: string | null };
  /** Dòng trạng thái kiểu terminal ở thanh trên. */
  status: { text: string; tone: "ok" | "running" | "error" };
  suggestions: Suggestion[];
  documents: Partial<Record<DocumentKind, { body: Record<string, unknown>; createdBy: "agent" | "user"; version: number }>>;
  agents: AgentSummary[];
  inbox: InboxCard[];
  calendar: CalendarItem[];
  insight: InsightView | null;
  /** Tab Social: số liệu bài đăng (W6). */
  metrics: Metrics | null;
  seo: SeoMetrics | null;
  links: LinkRow[] | null;
  log: LogEntry[];
  chat: ChatMessage[];
  chatTitle: string | null;
  /** Phần nào đã có backend thật. Phần chưa có: UI hiện trạng thái trống, không giả. */
  live: { inbox: boolean; metrics: boolean; chat: boolean; calendar: boolean; seo: boolean; links: boolean };
};

export const DEPARTMENT_LABEL: Record<Department, string> = { post: "Post", sales: "Sales", video: "Video" };

/** Ba agent mặc định — mô tả là goal của từng department, cố định theo sản phẩm. */
export const AGENTS: Omit<AgentSummary, "ready" | "nextRun" | "runnable">[] = [
  { department: "post", name: "X Agent", channels: "X", goal: "A post on X every day, in your voice.", unit: ["post", "posts"] },
  { department: "sales", name: "Reddit Agent", channels: "Reddit", goal: "Conversations worth joining, with a reply drafted.", unit: ["conversation", "conversations"] },
  { department: "video", name: "Video Agent", channels: "TikTok · Reels · Shorts · Facebook · Threads", goal: "Short videos from the recordings you already have.", unit: ["clip pack", "clip packs"] },
];

export const JOB_TITLE: Record<JobId, string> = {
  W0: "Onboarding",
  W1: "Plan the week",
  W2: "Draft X post",
  W3: "Publish",
  W4: "Scan Reddit",
  W5: "Video pack",
  W6: "Pull numbers",
  W7: "Competitor research",
  W8: "Weekly memory",
};
