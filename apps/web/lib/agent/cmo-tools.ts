import "server-only";

/**
 * Tool của CMO chat — người điều phối của tầng CMO (H3, Marcus 04/10: "cmo để tạo task cho toàn
 * bộ các agent khác, kể cả edit video").
 *
 * Mọi tool chỉ đọc hoặc giao việc. Không có tool đăng: việc làm ngay vào hàng đợi `cmo_runs`;
 * việc có ngày và mọi việc video thành mục trên lịch (`cmo_add_item`). Mọi thứ đi ra ngoài vẫn
 * phải qua thẻ ở Approvals, nơi người dùng tự bấm. Đọc mạng xã hội: `cmo-research.ts`.
 */

import { z } from "zod";

import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { DOCUMENT_KINDS, DOCUMENTS } from "@/lib/cmo/documents";
import { startCmoRun } from "@/lib/cmo/jobs/start";
import { insightBlock, latestPerTopic } from "@/lib/cmo/jobs/context";
import { mondayOf } from "@/lib/cmo/jobs/summarize-memory";
import { readSite, SiteError } from "@/lib/cmo/site";
import { isoDay, type CompetitorInsight, type Lesson } from "@/lib/cmo/jobs/types";

import { CMO_SKILLS } from "@/lib/cmo/skills/index.gen";
import { SKILL_NAMES, skillText, type SkillName } from "@/lib/cmo/skills";

import { RESEARCH_TOOL_SPECS } from "./cmo-research";
import type { ToolOutcome, ToolSpec } from "./tools";

const EMPTY = { type: "object", properties: {}, additionalProperties: false };

/** Skill CMO chat đọc được (frontmatter `agents` có `cmo`). */
const CMO_READABLE: string[] = SKILL_NAMES.filter((name) => (CMO_SKILLS[name].agents as readonly string[]).includes("cmo"));

export const CMO_TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_doc",
    description: "Read one of the user's marketing documents in full: product, strategy, competitors or content_strategy.",
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: [...DOCUMENT_KINDS] } },
      required: ["kind"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_calendar",
    description: "List the content calendar for the next two weeks: day, department, platform, idea, reason and status of each item.",
    schema: EMPTY,
    strict: true,
  },
  {
    name: "list_approvals",
    description:
      "List drafts waiting for the user's approval, posts approved or published in the last 14 days, Reddit conversations (community, score, status) waiting for the user to reply, and video packs (clips with hooks, status).",
    schema: EMPTY,
    strict: true,
  },
  {
    name: "create_task",
    description: [
      "Hand a task to one of your agents. Each task needs a specific brief: what to make, for whom, and the angle or evidence from your research (with URLs).",
      "planner: plan the next seven days into the calendar (1 credit; when = now only).",
      "x_writer: draft an X post, three versions, into Approvals (1 credit).",
      "sales: search Reddit for people describing the problem, score threads with quotes, draft replies the founder posts themselves (5 credits; only when the founder asks).",
      "research: study competitors' X accounts, find posts that beat their baseline and the hooks behind them, and save what works for the planner and X writer (2 credits; pass handles, or it uses the X handles in Competitor Analysis; when = now only).",
      "video: a short-video task. The founder must bring their OWN video, so this always becomes a calendar item with a \"Make clips\" button that opens the editor; you cannot upload or confirm ownership for them.",
      "when: \"now\" runs it in the background (result in Approvals within a minute). A date (YYYY-MM-DD, within 13 days) puts it on the calendar and it runs that morning. Nothing is posted until the founder approves.",
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["planner", "x_writer", "sales", "research", "video"] },
        brief: { type: "string", description: "One to three sentences. For video: what the clips should be about." },
        when: { type: "string", description: "\"now\" or a date YYYY-MM-DD." },
        handles: { type: "array", items: { type: "string" }, description: "Research only: up to 4 X handles to study." },
        clips: { type: "integer", description: "Video only: how many clips (1-10)." },
        clip_length: { type: "string", enum: ["auto", "short", "medium", "long"], description: "Video only." },
      },
      required: ["agent", "brief"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "remember",
    description:
      "Save a short note the user asked you to remember (a preference, a fact, something to avoid). It is used in every future plan and draft. Set topic when the note is only about one area: post (X posts), sales (Reddit), video, or research.",
    schema: {
      type: "object",
      properties: {
        note: { type: "string" },
        topic: { type: "string", enum: ["general", "post", "sales", "video", "research"] },
      },
      required: ["note"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "read_skill",
    description:
      "Read one of your marketing playbooks in full (listed in <skills> and <library>). Read the matching one before planning a research task, writing a brief, or answering how to do something: a plan, launch, pricing, offer, emails, outreach, ads, PR or an SEO review.",
    schema: {
      type: "object",
      properties: { name: { type: "string", enum: CMO_READABLE } },
      required: ["name"],
      additionalProperties: false,
    },
    strict: true,
  },
  ...RESEARCH_TOOL_SPECS,
  // Thêm ở CUỐI: thứ tự tool là phần đầu của prompt cache.
  {
    name: "read_site",
    description:
      "Read a public website: the home page plus up to 3 key pages (pricing, about, features), with each page's title, meta description, headings and text. Use it for SEO, copy or conversion reviews of the founder's site or a competitor's.",
    schema: {
      type: "object",
      properties: { url: { type: "string", description: "The site to read, like example.com." } },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
  // Weekly goal loop (architecture P2). Added at the END: tool order is the head of the prompt cache.
  {
    name: "get_run_result",
    description:
      "Check on tasks you handed out: the status, steps and result of one task (by run_id) or of the 8 most recent tasks. Use it before telling the founder something is done, and to learn from what failed.",
    schema: {
      type: "object",
      properties: { run_id: { type: "string", description: "A run id from an earlier create_task result. Omit for the latest tasks." } },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "set_week_goal",
    description:
      "Propose one measurable goal for this week or next week, like \"Approve and post 5 posts on X\" (metric posts, target 5). It appears as a card the founder approves or edits; it is not the goal until they do. Metrics: posts (X posts approved), replies (Reddit threads the founder replied to), clips (clip packs approved), views (views on their posts).",
    schema: {
      type: "object",
      properties: {
        week: { type: "string", enum: ["this", "next"] },
        goal: { type: "string", description: "One sentence, 3 to 300 characters." },
        metric: { type: "string", enum: ["posts", "replies", "clips", "views"] },
        target: { type: "integer", description: "1 to 1,000,000." },
      },
      required: ["week", "goal", "metric", "target"],
      additionalProperties: false,
    },
    strict: true,
  },
  // CMO → editor assistant bridge (architecture P3).
  {
    name: "create_video_brief",
    description: [
      "Write an editing brief for clips the founder already cut from their OWN video: the hook, b-roll, visuals and pacing.",
      "It becomes a card in Approvals. If the founder approves it, the project opens with the brief filled into the editor assistant; they send it, and every edit still needs their approval there.",
      "project_id is a video pack's job_id from list_approvals; omit it to use their latest project with clips. You cannot cut new clips or upload video.",
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        hook: { type: "string", description: "The opening line or on-screen hook, up to 200 characters." },
        broll: { type: "string", description: "B-roll or cutaway ideas, up to 600 characters." },
        visuals: { type: "string", description: "Captions, colors, layout, up to 600 characters." },
        pacing: { type: "string", description: "Cut rhythm and length, up to 300 characters." },
      },
      required: ["hook"],
      additionalProperties: false,
    },
    strict: false,
  },
];

const WRITES = new Set(["create_task", "remember", "set_week_goal", "create_video_brief"]);
export const isCmoWrite = (name: string) => WRITES.has(name);

const readInput = z.object({ kind: z.enum(DOCUMENT_KINDS) });
const skillInput = z.object({ name: z.string() });
const taskInput = z.object({
  agent: z.enum(["planner", "x_writer", "sales", "research", "video"]),
  brief: z.string().trim().min(3).max(300),
  when: z.string().trim().regex(/^(now|\d{4}-\d{2}-\d{2})$/).default("now"),
  handles: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
  clips: z.number().int().min(1).max(10).optional(),
  clip_length: z.enum(["auto", "short", "medium", "long"]).optional(),
});
const JOB_OF = { planner: "plan_week", x_writer: "post_draft", sales: "sales_scan", research: "competitor_research" } as const;
const DEPARTMENT_OF = { x_writer: "post", sales: "sales", video: "video" } as const;
const rememberInput = z.object({ note: z.string().trim().min(1).max(600), topic: z.enum(["general", "post", "sales", "video", "research"]).default("general") });
const siteInput = z.object({ url: z.string().trim().min(3).max(300) });
const runInput = z.object({ run_id: z.string().uuid().optional() });
const briefInput = z.object({
  project_id: z.string().uuid().optional(),
  hook: z.string().trim().min(1).max(200),
  broll: z.string().trim().max(600).default(""),
  visuals: z.string().trim().max(600).default(""),
  pacing: z.string().trim().max(300).default(""),
});
const goalInput = z.object({
  week: z.enum(["this", "next"]),
  goal: z.string().trim().min(3).max(300),
  metric: z.enum(["posts", "replies", "clips", "views"]),
  target: z.number().int().min(1).max(1_000_000),
});

const invalid = (message: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ INVALID_INPUT: message }), summary: "Invalid request" });

/** Dữ liệu người dùng/agent khác viết trả về trong `untrusted_data`, như tool project. */
const data = (value: unknown) => JSON.stringify({ untrusted_data: value });

/**
 * Each `read_site` fetches up to four pages from someone else's server; without a cap a model
 * that loops on it keeps a turn busy and hammers that site.
 */
export const SITE_READS_PER_TURN = 3;

/** Counters that live for one request (the scope is rebuilt every turn). */
export type CmoTurn = { siteReads: number };

export async function runCmoTool(supabase: SupabaseClient, name: string, input: unknown, turn: CmoTurn = { siteReads: 0 }): Promise<ToolOutcome> {
  switch (name) {
    case "read_doc": {
      const parsed = readInput.safeParse(input);
      if (!parsed.success) return invalid("kind must be product, strategy, competitors or content_strategy.");
      const { data: row } = await supabase.from("marketing_documents_latest").select("body, created_by, version").eq("kind", parsed.data.kind).maybeSingle();
      if (!row) return { ok: true, content: JSON.stringify({ missing: true }), summary: `No ${DOCUMENTS[parsed.data.kind].title} yet` };
      return { ok: true, content: data(row), summary: `Read ${DOCUMENTS[parsed.data.kind].title}` };
    }
    case "list_calendar": {
      const { data: rows } = await supabase
        .from("content_items")
        .select("id, day, department, platform, idea, reason, status")
        .gte("day", isoDay())
        .lte("day", isoDay(13))
        .order("day")
        .limit(40);
      return { ok: true, content: data({ today: isoDay(), items: rows ?? [] }), summary: `Read the calendar (${rows?.length ?? 0} items)` };
    }
    case "list_approvals": {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
      const { data: rows } = await supabase
        .from("content_items")
        .select("id, day, platform, idea, status, body, final_text, decided_at")
        .in("status", ["in_review", "approved", "published", "skipped"])
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(30);
      // Thread Reddit: chỉ trường do mình tính — tiêu đề/nội dung người lạ viết không vào chat.
      const { data: threads } = await supabase
        .from("opportunities")
        .select("id, community, score, priority, status, created_at")
        .eq("status", "in_review")
        .order("score", { ascending: false })
        .limit(10);
      const { data: packs } = await supabase
        .from("video_packs")
        .select("id, job_id, status, clips, created_at, decided_at")
        .in("status", ["in_review", "approved"])
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5);
      const count = (rows?.length ?? 0) + (threads?.length ?? 0) + (packs?.length ?? 0);
      return { ok: true, content: data({ items: rows ?? [], reddit_conversations: threads ?? [], video_packs: packs ?? [] }), summary: `Read Approvals (${count} items)` };
    }
    case "create_task": {
      const parsed = taskInput.safeParse(input);
      if (!parsed.success) return invalid("agent must be planner, x_writer, sales, research or video; brief 3-300 characters; when \"now\" or YYYY-MM-DD.");
      const task = parsed.data;
      // Video luôn lên lịch (luật 3: chính người dùng đưa video của họ vào editor); có ngày cũng vậy.
      const scheduled = task.agent === "video" || task.when !== "now";
      try {
        if (scheduled) {
          if (task.agent === "planner" || task.agent === "research") return invalid(`The ${task.agent} only runs now.`);
          const day = task.when === "now" ? isoDay() : task.when;
          const body = task.agent === "video" ? { brief: task.brief, clips: task.clips ?? 3, clip_length: task.clip_length ?? "auto" } : { brief: task.brief };
          const item = await rpcOrThrow<{ id: string; day: string }>(supabase, "cmo_add_item", {
            p_department: DEPARTMENT_OF[task.agent],
            p_idea: task.brief,
            p_day: day,
            p_reason: "Added by your CMO",
            p_body: body,
          });
          return { ok: true, content: JSON.stringify({ scheduled: true, item_id: item.id, day: item.day }), summary: task.agent === "video" ? "Added a video task to the calendar" : `Scheduled for ${item.day}` };
        }
        const kind = JOB_OF[task.agent as keyof typeof JOB_OF];
        const input =
          kind === "post_draft" ? { idea: task.brief, brief: task.brief } : kind === "competitor_research" ? { brief: task.brief, handles: task.handles ?? [] } : { brief: task.brief };
        const run = await startCmoRun(supabase, kind, input);
        const label = { plan_week: "Planning the week", post_draft: "Drafting a post for X", sales_scan: "Scanning Reddit", competitor_research: "Researching competitors" }[kind];
        return { ok: true, content: JSON.stringify({ started: true, run_id: run.id, status: run.status }), summary: label };
      } catch (error) {
        return { ok: false, content: JSON.stringify({ error: error instanceof Error ? error.message : "Could not start this task." }), summary: "Could not start" };
      }
    }
    case "read_skill": {
      const parsed = skillInput.safeParse(input);
      if (!parsed.success || !CMO_READABLE.includes(parsed.data.name)) return invalid(`name must be one of: ${CMO_READABLE.join(", ")}.`);
      return { ok: true, content: skillText(parsed.data.name as SkillName), summary: `Read the ${parsed.data.name} playbook` };
    }
    case "remember": {
      const parsed = rememberInput.safeParse(input);
      if (!parsed.success) return invalid("note must be 1 to 600 characters.");
      await rpcOrThrow(supabase, "cmo_remember", { p_body: parsed.data.note, p_topic: parsed.data.topic });
      return { ok: true, content: JSON.stringify({ saved: true }), summary: "Saved to memory" };
    }
    case "read_site": {
      const parsed = siteInput.safeParse(input);
      if (!parsed.success) return invalid("url must be a website address, like example.com.");
      if (turn.siteReads >= SITE_READS_PER_TURN) {
        return {
          ok: false,
          content: JSON.stringify({ error: `You can read ${SITE_READS_PER_TURN} websites per request. Work with what you have read.` }),
          summary: "Website limit reached",
        };
      }
      turn.siteReads += 1;
      try {
        // Cùng bộ đọc của Onboarding: đã chặn SSRF, trần thời gian và dung lượng mỗi trang.
        const snapshot = await readSite(parsed.data.url);
        return { ok: true, content: data(snapshot), summary: `Read ${new URL(snapshot.url).hostname}` };
      } catch (error) {
        const message = error instanceof SiteError ? error.message : "We could not read that website.";
        return { ok: false, content: JSON.stringify({ error: message }), summary: "Could not read the website" };
      }
    }
    case "get_run_result": {
      const parsed = runInput.safeParse(input ?? {});
      if (!parsed.success) return invalid("run_id must be a run id from create_task.");
      let query = supabase.from("cmo_runs").select("id, kind, status, error, steps, output, created_at, finished_at").order("created_at", { ascending: false });
      query = parsed.data.run_id ? query.eq("id", parsed.data.run_id).limit(1) : query.limit(8);
      const { data: runs } = await query;
      const rows = ((runs ?? []) as { id: string; kind: string; status: string; error: string | null; steps: { label: string; status: string }[] | null; output: unknown; created_at: string; finished_at: string | null }[]).map((r) => ({
        run_id: r.id,
        task: r.kind,
        status: r.status,
        error: r.error,
        steps: (r.steps ?? []).map((step) => `${step.status}: ${step.label}`),
        result: r.output,
        started: r.created_at,
        finished: r.finished_at,
      }));
      if (parsed.data.run_id && !rows.length) return { ok: false, content: JSON.stringify({ error: "No task with that id." }), summary: "Task not found" };
      return { ok: true, content: data(rows), summary: rows.length === 1 ? `Checked a ${rows[0]!.task} task` : `Checked ${rows.length} tasks` };
    }
    case "set_week_goal": {
      const parsed = goalInput.safeParse(input);
      if (!parsed.success) return invalid("week must be this or next; goal 3 to 300 characters; metric posts, replies, clips or views; target 1 to 1,000,000.");
      const week = isoDay(parsed.data.week === "next" ? 7 : 0, new Date(`${mondayOf()}T00:00:00Z`));
      await rpcOrThrow(supabase, "cmo_set_week_goal", { p_week: week, p_goal: parsed.data.goal, p_metric: parsed.data.metric, p_target: parsed.data.target });
      return {
        ok: true,
        content: JSON.stringify({ proposed: true, week, note: "The founder approves or edits it on the goal card in Approvals." }),
        summary: "Proposed a weekly goal",
      };
    }
    case "create_video_brief": {
      const parsed = briefInput.safeParse(input);
      if (!parsed.success) return invalid("hook is required (up to 200 characters); broll and visuals up to 600; pacing up to 300; project_id must be a project id.");
      let project = parsed.data.project_id ?? null;
      if (!project) {
        // Latest finished clipping project: under RLS, so only the founder's own videos.
        const { data: latest } = await supabase.from("jobs").select("id").eq("status", "done").order("created_at", { ascending: false }).limit(1).maybeSingle();
        project = (latest as { id: string } | null)?.id ?? null;
      }
      if (!project) return { ok: false, content: JSON.stringify({ error: "The founder has no clips yet. Suggest they make clips from one of their own videos first." }), summary: "No project with clips" };
      const { hook, broll, visuals, pacing } = parsed.data;
      await rpcOrThrow(supabase, "cmo_create_video_brief", { p_job: project, p_hook: hook, p_broll: broll, p_visuals: visuals, p_pacing: pacing });
      return {
        ok: true,
        content: JSON.stringify({ created: true, project_id: project, note: "The brief is a card in Approvals. Nothing is edited until the founder approves it and then approves the assistant's changes." }),
        summary: "Wrote a video brief",
      };
    }
    default:
      return { ok: false, content: JSON.stringify({ error: `Unknown tool ${name}.` }), summary: "Unknown tool" };
  }
}

/** Trạng thái nối sau câu lệnh: số việc đang chờ duyệt + lịch hôm nay, ngắn để rẻ. */
export async function cmoState(supabase: SupabaseClient): Promise<string> {
  const [{ data: pending }, { data: threads }, { data: packs }, { data: today }, { data: runs }, { data: memories }] = await Promise.all([
    supabase.from("content_items").select("id", { count: "exact", head: false }).eq("status", "in_review").limit(20),
    supabase.from("opportunities").select("id").eq("status", "in_review").limit(20),
    supabase.from("video_packs").select("id").eq("status", "in_review").limit(5),
    supabase.from("content_items").select("department, platform, idea, status").eq("day", isoDay()).limit(10),
    supabase.from("cmo_runs").select("kind, status").in("status", ["queued", "running"]).limit(5),
    // Most important unexpired notes first (memory tier 2); lessons below are tier 3.
    supabase
      .from("cmo_memories")
      .select("body")
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const { data: lessonRows } = await supabase.from("cmo_lessons").select("week, topic, body").order("week", { ascending: false }).limit(20);
  return `<cmo_state>${JSON.stringify({
    today: isoDay(),
    awaiting_approval: pending?.length ?? 0,
    reddit_conversations_waiting: threads?.length ?? 0,
    video_packs_waiting: packs?.length ?? 0,
    calendar_today: today ?? [],
    jobs_running: runs ?? [],
    memories: ((memories ?? []) as { body: string }[]).map((m) => m.body),
    lessons: latestPerTopic((lessonRows ?? []) as Lesson[]).map((l) => `${l.topic}: ${l.body}`),
  })}</cmo_state>`;
}

/** Bối cảnh đầu yêu cầu: bốn document (dữ liệu, không phải lệnh). */
export async function cmoContext(supabase: SupabaseClient): Promise<string> {
  const [{ data: rows }, { data: insight }] = await Promise.all([
    supabase.from("marketing_documents_latest").select("kind, body"),
    supabase.from("cmo_insights").select("body").eq("kind", "competitors").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const docs = ((rows ?? []) as { kind: string; body: unknown }[]).map((r) => `<document kind="${r.kind}">${JSON.stringify(r.body)}</document>`);
  // Điều Research đã học (W7): CMO dùng khi giao việc, không phải nghiên cứu lại từ đầu.
  const works = insightBlock((insight as { body?: CompetitorInsight } | null)?.body ?? null);
  return `<documents>\n${docs.join("\n") || "(none yet)"}\n</documents>${works ? `\n${works}` : ""}`;
}
