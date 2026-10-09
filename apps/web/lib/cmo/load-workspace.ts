import "server-only";

import type { SupabaseClient } from "@/lib/api/handler";
import { agentChatProvider } from "@/lib/agent/model";

import { DEMO_CHAT_TITLE, demoAllowed, demoCalendar, demoChat, demoInbox, demoLinks, demoLog, demoMetrics, demoSeo } from "./demo";
import { llmReady } from "./jobs/llm";
import { isoDay, type CompetitorInsight, type ItemRow, type ScorePart, type Step } from "./jobs/types";
import { socialReaderReady } from "./social/reddit";
import { loadCmoState } from "./state";
import { suggestFixes } from "./suggest";
import { AGENTS, type CalendarItem, type ClipPreview, type InboxCard, type InsightView, type Metrics, type JobId, type LogEntry, type PostCard, type SalesCard, type VideoCard, type Workspace } from "./workspace";

type CmoRunRow = {
  id: string;
  kind: "onboard" | "plan_week" | "post_draft" | "sales_scan" | "video_pack" | "competitor_research" | "pull_metrics";
  status: LogEntry["status"];
  input: { site?: string; idea?: string; source?: string };
  error: string | null;
  steps: Step[] | null;
  output: Record<string, unknown> | null;
  created_at: string;
};

const JOB_OF: Record<CmoRunRow["kind"], JobId> = { onboard: "W0", plan_week: "W1", post_draft: "W2", sales_scan: "W4", video_pack: "W5", pull_metrics: "W6", competitor_research: "W7" };

type VideoPackRow = {
  id: string;
  job_id: string;
  status: "in_review" | "approved";
  clips: { clip_id: string; hook: string; seconds: number; score: number | null }[];
  captions: Record<string, Record<string, string>>;
  exports: { clip_id: string; task_id: string }[];
  created_at: string;
  jobs: { title: string | null; source_url: string } | { title: string | null; source_url: string }[] | null;
};

const VIDEO_PLATFORMS = ["TikTok", "Reels", "Shorts", "Facebook", "Threads"];

/** Gói video (W5) → thẻ. `tasks`: trạng thái bản export theo id, cho nút Download. */
function toVideoCard(row: VideoPackRow, tasks: Map<string, NonNullable<ClipPreview["download"]>["status"]>): VideoCard {
  const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
  const exportOf = new Map(row.exports.map((item) => [item.clip_id, item.task_id]));
  return {
    id: row.id,
    priority: "medium",
    department: "video",
    title: `${row.clips.length} clips ready`,
    source: job?.title || (job?.source_url?.startsWith("storage://") ? "Your upload" : (job?.source_url ?? "Your video")),
    clips: row.clips.map((clip, index) => {
      const taskId = exportOf.get(clip.clip_id);
      return {
        id: clip.clip_id,
        title: clip.hook || `Clip ${index + 1}`,
        seconds: clip.seconds,
        hook: clip.hook,
        previewUrl: `/api/v1/clips/${clip.clip_id}/file?preview=1`,
        captions: row.captions[clip.clip_id] ?? {},
        download: taskId ? { taskId, status: tasks.get(taskId) ?? "queued" } : null,
      };
    }),
    platforms: VIDEO_PLATFORMS,
    projectId: row.job_id,
    createdAt: row.created_at,
    state: row.status === "approved" ? "approved" : "review",
  };
}

type OpportunityRow = {
  id: string;
  url: string;
  community: string;
  title: string;
  author: string;
  snippet: string;
  posted_at: string | null;
  comments: number;
  score: number;
  score_parts: ScorePart[] | null;
  reply: string;
  priority: SalesCard["priority"];
  created_at: string;
};

/** Lượt chạy thật → dòng Activity. W0 cũ chưa có `steps` thì dựng hai bước từ trạng thái. */
function runToLog(run: CmoRunRow): LogEntry {
  const steps: LogEntry["steps"] = run.steps?.length
    ? run.steps.map((s) => ({ tool: s.tool, label: s.label, status: s.status }))
    : run.kind === "onboard"
      ? [
          { tool: "fetch_site", label: "Read your website", status: run.status === "failed" ? "failed" : "done" },
          { tool: "write_doc", label: "Wrote 4 documents", status: run.status === "done" ? "done" : run.status === "running" ? "running" : "skipped" },
        ]
      : [];
  const detail = run.status === "failed" ? run.error : run.status === "queued" ? "Waiting to start" : (run.input.site ?? (run.input.source === "schedule" ? "Scheduled" : null));
  return { id: run.id, job: JOB_OF[run.kind], title: run.kind, status: run.status, startedAt: run.created_at, detail, steps };
}

function toPostCard(item: ItemRow): PostCard {
  const body = item.body as { text?: string; alternates?: string[]; rationale?: string };
  return {
    id: item.id,
    priority: item.priority,
    department: "post",
    platform: "x",
    title: item.status === "approved" ? "Ready to post on X" : "New X post ready",
    text: body.text ?? "",
    alternates: Array.isArray(body.alternates) ? body.alternates : [],
    rationale: body.rationale ?? item.reason,
    scheduledFor: null,
    createdAt: item.created_at,
    state: item.status === "approved" ? "approved" : "review",
    finalText: item.final_text,
  };
}

function toSalesCard(row: OpportunityRow): SalesCard {
  return {
    id: row.id,
    priority: row.priority,
    department: "sales",
    platform: "reddit",
    title: "Conversation worth joining",
    thread: { title: row.title, community: row.community, url: row.url, author: row.author, postedAt: row.posted_at, snippet: row.snippet, comments: row.comments },
    score: row.score,
    parts: Array.isArray(row.score_parts) ? row.score_parts : [],
    reply: row.reply,
    createdAt: row.created_at,
  };
}

function toCalendar(item: ItemRow): CalendarItem {
  return {
    id: item.id,
    day: `${item.day}T09:00:00Z`,
    department: item.department,
    platform: item.platform,
    idea: item.idea,
    reason: item.reason,
    editable: item.status === "planned",
    ...(item.department === "video" && item.status === "planned" ? { clipsHref: clipsHref(item.body) } : {}),
  };
}

/** Mục video → tab Clips của editor, điền sẵn số clip/độ dài từ brief (H3). Người dùng tự đưa video. */
function clipsHref(body: Record<string, unknown>): string {
  const params = new URLSearchParams({ panel: "clips" });
  const clips = Number(body.clips);
  if ([1, 3, 5, 8, 10].includes(clips)) params.set("count", String(clips));
  if (["auto", "short", "medium", "long"].includes(String(body.clip_length))) params.set("length", String(body.clip_length));
  return `/app/editor?${params}`;
}

/** Dòng trạng thái thanh trên: nói thật việc đang ở đâu. */
function statusLine(runs: CmoRunRow[], awaiting: number): Workspace["status"] {
  const active = runs.find((r) => r.status === "running" || r.status === "queued");
  if (active) {
    const what = { plan_week: "planning your week", post_draft: "drafting a post for X", sales_scan: "scanning Reddit for conversations", video_pack: "making your video pack", onboard: "building your plan", competitor_research: "studying your competitors on X", pull_metrics: "reading the numbers on your posts" }[active.kind];
    return { text: `Your CMO is ${what}. Follow along in Activity.`, tone: "running" };
  }
  const latest = runs[0];
  if (latest?.status === "failed") return { text: `Last task failed: ${latest.error ?? "unknown error"}`, tone: "error" };
  if (awaiting) return { text: `${awaiting} ${awaiting === 1 ? "item is" : "items are"} waiting for you in Approvals.`, tone: "ok" };
  return { text: "Your marketing plan is ready. Ask your CMO, or plan the week.", tone: "ok" };
}

/**
 * Dữ liệu màn AI CMO. Thật: document, lịch, bài chờ duyệt, lượt chạy, chat.
 * Phần chưa có backend (số liệu, SEO, video) trống — hoặc lấy mẫu khi
 * `OPENCMO_CMO_DEMO=1` ngoài production, và chỉ khi phần thật cũng còn trống.
 */
export async function loadWorkspace(supabase: SupabaseClient): Promise<Workspace> {
  const today = isoDay();
  const [state, { data: runRows }, { data: itemRows }, { data: oppRows }, { data: packRows }] = await Promise.all([
    loadCmoState(supabase),
    supabase.from("cmo_runs").select("id, kind, status, input, error, steps, output, created_at").order("created_at", { ascending: false }).limit(20),
    supabase
      .from("content_items")
      .select("id, run_id, department, platform, day, idea, reason, status, priority, body, final_text, external_url, decided_at, published_at, created_at")
      .or(`status.in.(in_review,approved),and(status.eq.planned,day.gte.${today},day.lte.${isoDay(13)})`)
      .order("day")
      .limit(100),
    supabase
      .from("opportunities")
      .select("id, url, community, title, author, snippet, posted_at, comments, score, score_parts, reply, priority, created_at")
      .eq("status", "in_review")
      .order("score", { ascending: false })
      .limit(30),
    // Gói đã duyệt còn hiện 3 ngày: chỗ người dùng tải bản export về.
    supabase
      .from("video_packs")
      .select("id, job_id, status, clips, captions, exports, created_at, jobs(title, source_url)")
      .or(`status.eq.in_review,and(status.eq.approved,decided_at.gte.${new Date(Date.now() - 3 * 86_400_000).toISOString()})`)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const [realMetrics, insight] = await Promise.all([loadMetrics(supabase), loadInsight(supabase)]);
  const packs = (packRows ?? []) as unknown as VideoPackRow[];
  const taskIds = packs.flatMap((pack) => pack.exports.map((item) => item.task_id));
  const { data: taskRows } = taskIds.length ? await supabase.from("tasks").select("id, status").in("id", taskIds) : { data: [] };
  const taskStatus = new Map(((taskRows ?? []) as { id: string; status: NonNullable<ClipPreview["download"]>["status"] }[]).map((task) => [task.id, task.status]));
  const demo = demoAllowed();
  const runs = (runRows ?? []) as CmoRunRow[];
  const items = (itemRows ?? []) as ItemRow[];

  const documents: Workspace["documents"] = {};
  for (const [kind, row] of Object.entries(state.documents)) {
    if (row) documents[kind as keyof typeof documents] = { body: row.body, createdBy: row.created_by, version: row.version };
  }
  const productName = typeof documents.product?.body.name === "string" ? documents.product.body.name : "";
  const product = productName || "Acme";
  const site = state.lastRun?.input?.site ?? "";
  const category = typeof documents.product?.body.category === "string" && documents.product.body.category ? documents.product.body.category : null;

  const realInbox: InboxCard[] = [
    ...items.filter((i) => i.department === "post" && (i.status === "in_review" || i.status === "approved")).map(toPostCard),
    ...((oppRows ?? []) as OpportunityRow[]).map(toSalesCard),
    ...packs.map((pack) => toVideoCard(pack, taskStatus)),
  ];
  // Lịch 7 ngày: mục còn `planned` (sửa được) và mục đã thành bài trong tuần (chỉ xem).
  const realCalendar = items.filter((i) => i.day >= today && i.day <= isoDay(6)).map(toCalendar);
  const realLog = runs.map(runToLog);

  // Mẫu chỉ lấp phần trống: có dữ liệu thật thì không trộn mẫu vào.
  const inbox = realInbox.length || !demo ? realInbox : demoInbox(product);
  const calendar = realCalendar.length || !demo ? realCalendar : demoCalendar();
  const log = realLog.length > 1 || !demo ? realLog : [...demoLog(), ...realLog];
  const chatLive = agentChatProvider("cmo") !== null;
  const awaiting = realInbox.filter((c) => !((c.department === "post" || c.department === "video") && c.state === "approved")).length;

  return {
    demo,
    site,
    project: { name: productName || site || "Your product", category: category ?? (demo ? "SaaS" : null) },
    status: statusLine(runs, awaiting),
    suggestions: suggestFixes(documents),
    documents,
    agents: AGENTS.map((agent) => ({
      ...agent,
      ready: inbox.filter((card) => card.department === agent.department && !((card.department === "post" || card.department === "video") && card.state === "approved")).length,
      // Reddit Agent chạy theo lịch chỉ khi lịch có mục Reddit; nút Run now luôn có khi đọc được Reddit.
      nextRun: agent.department === "post" ? nextMorning() : agent.department === "sales" ? nextSalesRun(calendar) : demo ? nextMorning() : null,
      // Video Agent: luôn chạy được — gói không cần model để cắt clip; caption rơi về bản từ hook khi chưa có model.
      runnable: (agent.department === "post" && llmReady("x_writer")) || (agent.department === "sales" && llmReady("sales") && socialReaderReady()) || agent.department === "video",
    })),
    inbox,
    calendar,
    metrics: realMetrics ?? (demo ? demoMetrics() : null),
    insight,
    seo: demo ? demoSeo() : null,
    links: demo ? demoLinks(site) : null,
    log,
    chat: chatLive ? [] : demo ? demoChat(product) : [],
    chatTitle: chatLive ? null : demo ? DEMO_CHAT_TITLE : null,
    live: { inbox: true, calendar: true, chat: chatLive, metrics: realMetrics !== null, seo: false, links: false },
  };
}

/**
 * Số thật của bài đã đăng (W6-lite, `post_metrics`): lượt đo MỚI NHẤT của mỗi bài trong 14 ngày.
 * Null khi chưa có lượt đo nào — cột Results nói "No numbers yet" thay vì số mẫu.
 */
async function loadMetrics(supabase: SupabaseClient): Promise<Metrics | null> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("post_metrics")
    .select("item_id, views, likes, replies, reposts, measured_at, content_items(final_text, body, published_at)")
    .gte("measured_at", since)
    .order("measured_at", { ascending: false })
    .limit(500);
  type Row = { item_id: string; views: number; likes: number; replies: number; reposts: number; content_items: { final_text: string | null; body: Record<string, unknown>; published_at: string | null } | null };
  const latest = new Map<string, Row>();
  for (const row of (data ?? []) as unknown as Row[]) if (!latest.has(row.item_id)) latest.set(row.item_id, row);
  const rows = [...latest.values()];
  if (!rows.length) return null;
  const sum = (key: "views" | "likes" | "replies" | "reposts") => rows.reduce((total, row) => total + Number(row[key]), 0);
  // Lượt xem theo NGÀY ĐĂNG, 14 ngày (cũ → mới): một bài = một chấm vào ngày nó lên.
  const days = Array.from({ length: 14 }, (_, i) => isoDay(i - 13));
  const views = days.map((day) => rows.filter((row) => (row.content_items?.published_at ?? "").slice(0, 10) === day).reduce((t, row) => t + Number(row.views), 0));
  const best = [...rows].sort((a, b) => Number(b.likes) + Number(b.replies) + Number(b.reposts) - (Number(a.likes) + Number(a.replies) + Number(a.reposts)))[0]!;
  const text = best.content_items?.final_text ?? String(best.content_items?.body?.text ?? "");
  return {
    windowDays: 14,
    tiles: [
      { label: "Posts measured", value: rows.length, change: null, hint: "Published on X, last 14 days" },
      { label: "Views", value: sum("views"), change: null, hint: "Public view count on X" },
      { label: "Likes", value: sum("likes"), change: null, hint: "On your posts" },
      { label: "Replies", value: sum("replies"), change: null, hint: "Conversations started" },
    ],
    views,
    top: text ? { title: text.split("\n")[0]!.slice(0, 140), platform: "X", views: Number(best.views) } : null,
  };
}

/** Bản "what works now" mới nhất của W7, quá 21 ngày thì thôi hiện (cùng ngưỡng với prompt). */
async function loadInsight(supabase: SupabaseClient): Promise<InsightView | null> {
  const { data } = await supabase.from("cmo_insights").select("body, created_at").eq("kind", "competitors").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const row = data as { body: CompetitorInsight; created_at: string } | null;
  if (!row || Date.now() - new Date(row.created_at).getTime() > 21 * 86_400_000) return null;
  return {
    measuredAt: row.created_at,
    hooks: (row.body.hooks ?? []).slice(0, 5).map((h) => ({ pattern: h.pattern, example: h.example, url: h.url, lift: h.lift })),
    ideas: (row.body.ideas ?? []).slice(0, 3).map((i) => i.idea),
  };
}

/** Mục Reddit gần nhất trên lịch → lượt cron của ngày đó (lịch mẫu không tính). */
function nextSalesRun(calendar: CalendarItem[]): string | null {
  const next = calendar.filter((c) => c.department === "sales" && c.editable).map((c) => c.day.slice(0, 10)).sort()[0];
  if (!next) return null;
  const run = new Date(`${next}T00:05:00Z`);
  return run.getTime() > Date.now() ? run.toISOString() : nextMorning();
}

/** Lượt cron kế tiếp: 00:05 UTC ngày mai (7:05 giờ Việt Nam). */
function nextMorning(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)).toISOString();
}
