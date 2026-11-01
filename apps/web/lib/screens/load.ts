import "server-only";

import type { SupabaseClient } from "@/lib/api/handler";
import { brainMode } from "@/lib/cmo/brain";
import { loadDigestInput, localClock } from "@/lib/cmo/digest";
import { CMO_SKILLS } from "@/lib/cmo/skills/index.gen";
import { profileIdOf, profileOf, POST_PROFILES } from "@/lib/cmo/platforms";
import { readyStyles } from "@/lib/agent/styles";
import { DOCUMENTS, DOCUMENT_KINDS, type DocumentKind } from "@/lib/cmo/documents";
import { JOB_PRICES, classifyOrder, nextCheckAt, type OrderLedgerRow } from "@/lib/cmo/jobs/progress";
import { mondayOf } from "@/lib/cmo/jobs/summarize-memory";
import { localMidnight, localMonday } from "@/lib/time-zone";
import { PUBLISH_PLATFORMS } from "@/lib/departments/publish/types";
import { SITE_URL } from "@/lib/site";

import scheduleDefaults from "../../../../packages/contracts/schedule-defaults.json";

import { RangeSchema, type AnalyticsScreen } from "./analytics";
import { buildAnalytics, buildResults, type AccountDayIn, type AccountIn, type PostIn } from "./analytics-build";
import type { ApprovalCard } from "./approval-card";
import type { BrainScreen, OrderRow, OrderState } from "./brain";
import { buildMeasures, type WeekCounts } from "./brain-measures";
import { APPROVAL_COLUMNS, approvalToCard, type ApprovalRow } from "./cards";
import { enrichScheduleCards } from "./schedule-enrich";
import { signStudioCards } from "./studio-sign";
import { DEPARTMENTS, TEAM, type CmoState, type Department } from "./common";
import type { DashboardScreen } from "./dashboard";
import { SKILL_READERS, type LibraryScreen } from "./library";
import type { RailStatus } from "./rail";
import type { ResearchScreen } from "./research";
import type { SalesScreen } from "./sales";
import type { ScreenData, ScreenName } from "./registry";
import type { ScheduleScreen } from "./schedule";
import type { SettingsScreen } from "./settings";
import type { StudioItem, StudioScreen, TeamStep } from "./studio";
import { videoSteps, type VideoStepRow } from "./video-steps";
import type { WriterScreen } from "./writer";

export type LoadContext = { supabase: SupabaseClient; userId: string; params: URLSearchParams };

type Loader<N extends ScreenName> = (ctx: LoadContext) => Promise<Partial<ScreenData<N>>>;

const iso = (v: string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/**
 * Runs each part on its own: a part that fails is left out, so its field stays sample (or empty in production) and
 * not live, instead of failing the whole screen.
 */
async function parts<T extends object>(label: string, readers: { [K in keyof T]?: () => Promise<T[K]> }): Promise<Partial<T>> {
  const keys = Object.keys(readers) as (keyof T)[];
  const results = await Promise.allSettled(keys.map((k) => readers[k]!()));
  const out: Partial<T> = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out[keys[i]!] = r.value;
    else console.warn(`[screens] ${label}.${String(keys[i])} not loaded`, r.reason instanceof Error ? r.reason.message : r.reason);
  });
  return out;
}

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return (r.data ?? ([] as unknown)) as T;
}

type Profile = { weekly_credit_budget: number; timezone: string; digest_hour: number | null; cmo_paused_at: string | null; plan: string };

async function profile(supabase: SupabaseClient, userId: string): Promise<Profile> {
  const r = await supabase.from("profiles").select("weekly_credit_budget, timezone, digest_hour, cmo_paused_at, plan").eq("id", userId).maybeSingle();
  if (r.error || !r.data) throw new Error(`profiles: ${r.error?.message ?? "missing"}`);
  return r.data as Profile;
}

async function cmoState(supabase: SupabaseClient, userId: string, p: Promise<Profile>): Promise<CmoState> {
  const [mode, prof] = await Promise.all([brainMode(supabase, userId), p]);
  return { mode: mode.brain, pausedAt: iso(prof.cmo_paused_at) };
}

/** The queue: waiting cards, oldest first, Studio pictures signed, schedule cards in the founder's time. Kinds the app cannot show yet are left out. */
async function waitingCards(supabase: SupabaseClient, userId: string): Promise<ApprovalCard[]> {
  const rows = must(
    await supabase.from("approvals").select(APPROVAL_COLUMNS).eq("status", "waiting").order("created_at", { ascending: true }).limit(100),
    "approvals",
  ) as ApprovalRow[];
  const cards = await signStudioCards(supabase, rows.map((row) => approvalToCard(row)).filter((c): c is ApprovalCard => c !== null), rows);
  return enrichScheduleCards(supabase, userId, cards);
}

type OrderDb = OrderLedgerRow & { user_id: string; root_id: string | null; week: string; created_at: string; done_reason: string | null };
const ORDER_COLUMNS = "id, user_id, root_id, parent_id, week, kind, title, department, status, due_at, budget_credits, spent_credits, updated_at, created_at, brief, error, done_reason";

/** This week's tree: the root and its orders, parents before children. */
async function weekTree(supabase: SupabaseClient, week = mondayOf()): Promise<{ root: OrderDb | null; orders: OrderDb[] }> {
  const rows = must(await supabase.from("work_orders").select(ORDER_COLUMNS).eq("week", week).order("created_at").limit(500), "work_orders") as OrderDb[];
  const root = rows.find((o) => o.parent_id === null) ?? null;
  const children = rows.filter((o) => o.parent_id !== null);
  const sorted: OrderDb[] = [];
  const visit = (parent: string) => {
    // Orders of one plan share `created_at` (one transaction): sort siblings by when they are due.
    const siblings = children
      .filter((c) => c.parent_id === parent)
      .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || a.created_at.localeCompare(b.created_at));
    for (const o of siblings) {
      sorted.push(o);
      visit(o.id);
    }
  };
  if (root) visit(root.id);
  return { root, orders: sorted };
}

const STATE_TEXT: Record<OrderState, string> = {
  queued: "Queued",
  running: "Running",
  waiting_founder: "Waits on you",
  waiting_order: "Waits on another order",
  deferred: "Continues later",
  done: "Done",
  failed: "Stuck",
  cancelled: "Cancelled",
};

function stateText(o: OrderDb, now: Date): string {
  if (o.status === "failed") return o.error?.code === "stuck" ? "Stuck: no progress" : `Stuck: ${(o.error?.message ?? "failed").slice(0, 60)}`;
  if (o.status === "queued" && classifyOrder(o, now, JOB_PRICES[o.kind] ?? 0) === "over_budget") return "Stuck: budget";
  return STATE_TEXT[o.status];
}

/** The waiting card of each order (through its deliverables), for the "Open" link on a row. */
async function cardsByOrder(supabase: SupabaseClient, orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!orderIds.length) return out;
  const deliverables = [
    ...(must(await supabase.from("deliverables").select("order_id, ref_kind, ref_id").in("order_id", orderIds), "deliverables") as {
      order_id: string;
      ref_kind: string;
      ref_id: string;
    }[]),
    // Studio's cards hang off its steps, batches and edits, not deliverables (P2).
    ...(await studioRefs(supabase, orderIds)),
  ];
  if (!deliverables.length) return out;
  const waiting = must(
    await supabase.from("approvals").select("id, ref_id").eq("status", "waiting").in("ref_id", deliverables.map((d) => d.ref_id)),
    "approvals",
  ) as { id: string; ref_id: string }[];
  for (const d of deliverables) {
    const card = waiting.find((w) => w.ref_id === d.ref_id);
    if (card && !out.has(d.order_id)) out.set(d.order_id, card.id);
  }
  return out;
}

function orderRows(orders: OrderDb[], cards: Map<string, string>, rootId: string, now: Date): OrderRow[] {
  return orders.map((o) => ({
    id: o.id,
    parentId: o.parent_id === rootId ? null : o.parent_id,
    title: o.title,
    department: o.department as Department,
    dueAt: iso(o.due_at),
    dueText: null,
    credits: { used: o.spent_credits, budget: o.budget_credits },
    state: o.status,
    stateText: stateText(o, now),
    approvalId: cards.get(o.id) ?? null,
  }));
}

async function weekGoal(supabase: SupabaseClient, week = mondayOf()): Promise<string | null> {
  const r = await supabase.from("cmo_goals").select("goal").eq("week", week).eq("status", "approved").maybeSingle();
  if (r.error) throw new Error(`cmo_goals: ${r.error.message}`);
  // Goals saved before the 200-character cap would fail the week strip's contract and blank it.
  const goal = (r.data as { goal: string } | null)?.goal;
  return goal ? clip(goal, 200) : null;
}

const OPEN: ReadonlySet<string> = new Set(["queued", "running", "waiting_founder", "waiting_order", "deferred"]);

async function dashboard({ supabase, userId }: LoadContext): Promise<Partial<DashboardScreen>> {
  const now = new Date();
  const prof = profile(supabase, userId);
  const tree = weekTree(supabase);
  const queue = waitingCards(supabase, userId);
  return parts<DashboardScreen>("dashboard", {
    cmo: () => cmoState(supabase, userId, prof),
    queue: () => queue,
    week: async () => {
      const [{ root, orders }, goal, p] = await Promise.all([tree, weekGoal(supabase), prof]);
      const open = orders.filter((o) => o.status !== "cancelled");
      const today = now.toISOString().slice(0, 10);
      const drafts = must(
        // Drafted today: approving or publishing an older draft is not new writing.
        await supabase.from("content_items").select("body").eq("department", "post").gte("created_at", `${today}T00:00:00Z`).in("status", ["in_review", "approved", "published"]),
        "content_items",
      ) as { body: { text?: string } }[];
      const words = drafts.reduce((n, d) => n + (typeof d.body.text === "string" ? d.body.text.split(/\s+/).filter(Boolean).length : 0), 0);
      return {
        goal,
        deliverables: { done: open.filter((o) => o.status === "done").length, total: open.length },
        workingNow: new Set(orders.filter((o) => o.status === "running" && (TEAM as string[]).includes(o.department)).map((o) => o.department)).size,
        wordsDraftedToday: words,
        credits: { used: root?.spent_credits ?? 0, budget: root?.budget_credits ?? p.weekly_credit_budget },
      };
    },
    team: async () => {
      const [{ orders }, cards, p] = await Promise.all([tree, queue, prof]);
      const verdict = (o: OrderDb) => classifyOrder(o, now, JOB_PRICES[o.kind] ?? 0);
      const nodes = TEAM.map((department) => {
        const mine = orders.filter((o) => o.department === department);
        // An order waiting on its generations or renders (Studio) is at work, not idle.
        const running = mine.find((o) => o.status === "running") ?? mine.find((o) => o.status === "waiting_order");
        const stuck = mine.find((o) => verdict(o) === "stuck" || verdict(o) === "over_budget");
        const next = mine.filter((o) => o.status === "queued").sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"))[0];
        const waitingOn = mine.find((o) => o.status === "waiting_founder");
        const state: "working" | "idle" | "stuck" = stuck ? "stuck" : running ? "working" : "idle";
        const line = stuck
          ? `Stuck: ${stuck.title}`
          : running
            ? `Working on “${running.title}”`
            : waitingOn
              ? `“${waitingOn.title}” waits on you`
              : next
                ? `Next: “${next.title}”`
                : "Idle";
        return { department, state, line: line.slice(0, 120), waiting: cards.filter((c) => c.department === department).length };
      });
      const anyStuck = nodes.some((n) => n.state === "stuck");
      return {
        brain: {
          state: p.cmo_paused_at ? ("paused" as const) : anyStuck ? ("stuck" as const) : ("on_track" as const),
          watching: orders.filter((o) => OPEN.has(o.status)).length,
          nextCheckAt: nextCheckAt(now).toISOString(),
        },
        nodes,
      };
    },
    log: async () => {
      const rows = must(
        await supabase.from("work_order_events").select("id, at, department, text").order("at", { ascending: false }).limit(50),
        "work_order_events",
      ) as { id: number; at: string; department: string; text: string }[];
      return rows.map((r) => ({
        id: String(r.id),
        at: new Date(r.at).toISOString(),
        who: ((DEPARTMENTS as readonly string[]).includes(r.department) ? r.department : "brain") as Department,
        text: r.text,
      }));
    },
    outToday: async () => {
      const today = now.toISOString().slice(0, 10);
      const rows = must(
        await supabase
          .from("content_items")
          .select("id, platform, idea, final_text, status, day, published_at, decided_at")
          .eq("department", "post")
          .in("status", ["approved", "published"])
          .or(`day.eq.${today},published_at.gte.${today}T00:00:00Z`)
          .limit(20),
        "content_items",
      ) as { id: string; platform: string; idea: string; final_text: string | null; status: string; published_at: string | null; decided_at: string | null }[];
      return rows
        .map((r) => ({
          id: r.id,
          at: new Date(r.published_at ?? r.decided_at ?? now).toISOString(),
          where: { platform: screenPlatform(r.platform, "x"), handle: "your account" },
          text: (r.final_text ?? r.idea).slice(0, 300),
          // Assisted posting (W3): an approved X post waits for the founder to post it on X.
          status: r.status === "published" ? ("posted" as const) : ("scheduled" as const),
          problem: null,
          approvalId: null,
        }))
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    results: async () => {
      const m = await measured(supabase, 7, now);
      return buildResults({ now, accounts: m.accounts, days: m.days, posts: m.posts });
    },
    digest: async () => {
      const p = await prof;
      const clock = localClock(now, p.timezone);
      const input = await loadDigestInput(supabase, userId, { appUrl: SITE_URL, dateLabel: clock.dateLabel, now });
      if (!input.waiting.length && !input.wentOut.length && !input.stuck.length) return null;
      const dept = (d: string) => ((DEPARTMENTS as readonly string[]).includes(d) ? d : "brain") as Department;
      return {
        dateLabel: input.dateLabel.slice(0, 40),
        waiting: input.waiting.map((w) => ({ id: w.id, title: w.title.slice(0, 200), department: dept(w.department) })),
        wentOut: input.wentOut.map((o) => ({ title: o.title.slice(0, 200), where: o.where.slice(0, 40) })),
        stuck: input.stuck.map((s) => ({ title: s.title.slice(0, 200), department: dept(s.department), reason: s.reason.slice(0, 300) })),
      };
    },
  });
}

/** One week's counts for the brain's measures, read under the founder's session. */
async function weekCounts(supabase: SupabaseClient, monday: string, now: Date): Promise<WeekCounts> {
  const from = `${monday}T00:00:00Z`;
  const to = new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
  const [plans, drafts, orders, approved] = await Promise.all([
    supabase.from("approvals").select("status").eq("kind", "goal").in("status", ["approved", "edited", "skipped"]).gte("decided_at", from).lt("decided_at", to).limit(500),
    supabase.from("cmo_draft_outcomes").select("similarity").not("similarity", "is", null).gte("decided_at", from).lt("decided_at", to).limit(2000),
    supabase.from("work_orders").select("id, parent_id, status, due_at, finished_at, spent_credits, brief").eq("week", monday).limit(1000),
    supabase.from("approvals").select("id", { count: "exact", head: true }).in("status", ["approved", "edited"]).gte("decided_at", from).lt("decided_at", to),
  ]);
  const planRows = must(plans, "approvals") as { status: string }[];
  const draftRows = must(drafts, "cmo_draft_outcomes") as { similarity: number }[];
  const orderRows = must(orders, "work_orders") as { id: string; parent_id: string | null; status: string; due_at: string | null; finished_at: string | null; spent_credits: number; brief: Record<string, unknown> | null }[];
  if (approved.error) throw new Error(`approvals: ${approved.error.message}`);
  const children = orderRows.filter((o) => o.parent_id && o.status !== "cancelled");
  const due = children.filter((o) => o.due_at && (o.status === "done" || Date.parse(o.due_at) < now.getTime()));
  return {
    plans: { asIs: planRows.filter((r) => r.status === "approved").length, decided: planRows.length },
    drafts: { asIs: draftRows.filter((r) => r.similarity >= 0.95).length, total: draftRows.length },
    orders: { onTime: due.filter((o) => o.status === "done" && o.finished_at && o.finished_at <= o.due_at!).length, due: due.length },
    credits: { spent: orderRows.filter((o) => !o.parent_id).reduce((n, o) => n + o.spent_credits, 0), approved: approved.count ?? 0 },
    replans: children.filter((o) => o.brief && "replan_of" in o.brief).length,
  };
}

async function brain({ supabase, userId }: LoadContext): Promise<Partial<BrainScreen>> {
  const now = new Date();
  const prof = profile(supabase, userId);
  const tree = weekTree(supabase);
  return parts<BrainScreen>("brain", {
    measures: async () => {
      const monday = mondayOf(now);
      const before = mondayOf(new Date(Date.parse(`${monday}T00:00:00Z`) - 86_400_000));
      const [week, last] = await Promise.all([weekCounts(supabase, monday, now), weekCounts(supabase, before, now)]);
      return buildMeasures(week, last);
    },
    cmo: () => cmoState(supabase, userId, prof),
    week: async () => {
      const [{ root, orders }, goal, p] = await Promise.all([tree, weekGoal(supabase), prof]);
      const open = orders.filter((o) => o.status !== "cancelled");
      return {
        goal,
        done: open.filter((o) => o.status === "done").length,
        total: open.length,
        credits: { used: root?.spent_credits ?? 0, budget: root?.budget_credits ?? p.weekly_credit_budget },
        nextCheckAt: nextCheckAt(now).toISOString(),
      };
    },
    orders: async () => {
      const { root, orders } = await tree;
      if (!root) return [];
      const visible = orders.filter((o) => o.status !== "cancelled");
      const [cards, steps] = await Promise.all([
        cardsByOrder(supabase, visible.map((o) => o.id)),
        videoStepsByOrder(supabase, visible.filter((o) => o.kind === "build_video")),
      ]);
      return orderRows(visible, cards, root.id, now).map((row) => (steps.has(row.id) ? { ...row, steps: steps.get(row.id) } : row));
    },
    learned: async () => {
      const [lessons, rules, skips] = await Promise.all([
        supabase.from("cmo_lessons").select("id, week, topic, body, created_at").order("week", { ascending: false }).limit(20),
        supabase.from("cmo_corrections").select("id, rule, created_at, decided_at, source_edits").eq("status", "active").order("created_at", { ascending: false }).limit(10),
        supabase.from("cmo_memories").select("id, body, topic, created_at").eq("kind", "feedback").order("created_at", { ascending: false }).limit(5),
      ]);
      const seen = new Set<string>();
      const latest = (must(lessons, "cmo_lessons") as { id: string; topic: string; body: string; created_at: string }[]).filter((l) =>
        seen.has(l.topic) ? false : (seen.add(l.topic), true),
      );
      const topicLabel = (t: string) => ({ post: "X", sales: "Sales", video: "Video", general: "General" })[t] ?? t;
      return [
        ...(must(rules, "cmo_corrections") as { id: string; rule: string; created_at: string; decided_at: string | null; source_edits: unknown[] }[]).map((r) => ({
          id: r.id,
          kind: "rule" as const,
          scope: "you approved",
          text: r.rule,
          source: Array.isArray(r.source_edits) && r.source_edits.length ? `From ${r.source_edits.length} edits` : "From your edits",
          at: new Date(r.decided_at ?? r.created_at).toISOString(),
          deletable: true,
        })),
        ...latest.map((l) => ({
          id: l.id,
          kind: "lesson" as const,
          scope: topicLabel(l.topic),
          text: l.body.slice(0, 300),
          source: "From last week's results",
          at: new Date(l.created_at).toISOString(),
          deletable: false,
        })),
        ...(must(skips, "cmo_memories") as { id: string; body: string; topic: string; created_at: string }[]).map((m) => ({
          id: m.id,
          kind: "skip_reason" as const,
          scope: topicLabel(m.topic),
          text: m.body.slice(0, 300),
          source: "From a card you skipped",
          at: new Date(m.created_at).toISOString(),
          deletable: true,
        })),
      ];
    },
    corrections: async () => {
      const rows = must(await supabase.from("cmo_corrections").select("id, rule, status, created_at").order("created_at", { ascending: false }).limit(50), "cmo_corrections") as {
        id: string;
        rule: string;
        status: "proposed" | "active" | "rejected";
        created_at: string;
      }[];
      const waiting = must(
        await supabase.from("approvals").select("id, ref_id").eq("ref_kind", "correction").eq("status", "waiting"),
        "approvals",
      ) as { id: string; ref_id: string }[];
      return rows.map((r) => ({
        id: r.id,
        rule: r.rule,
        status: r.status,
        at: new Date(r.created_at).toISOString(),
        approvalId: waiting.find((w) => w.ref_id === r.id)?.id ?? null,
      }));
    },
    pastWeeks: async () => {
      const thisWeek = mondayOf(now);
      const roots = must(
        await supabase.from("work_orders").select("id, week, budget_credits, spent_credits").is("parent_id", null).lt("week", thisWeek).order("week", { ascending: false }).limit(8),
        "work_orders",
      ) as { id: string; week: string; budget_credits: number; spent_credits: number }[];
      if (!roots.length) return [];
      const [children, goals] = await Promise.all([
        supabase.from("work_orders").select("root_id, status").in("root_id", roots.map((r) => r.id)).not("parent_id", "is", null),
        supabase.from("cmo_goals").select("week, goal, target, result, metric, status").in("week", roots.map((r) => r.week)),
      ]);
      const kids = must(children, "work_orders") as { root_id: string; status: string }[];
      const goalRows = must(goals, "cmo_goals") as { week: string; goal: string; target: number; result: number | null; metric: string; status: string }[];
      return roots.map((r) => {
        const mine = kids.filter((k) => k.root_id === r.id && k.status !== "cancelled");
        const g = goalRows.find((x) => x.week === r.week && x.status === "approved");
        const result =
          g && g.result !== null
            ? `${g.result >= g.target ? "Reached" : "Missed"}: ${g.result} of ${g.target} ${g.metric}.`
            : `${mine.filter((k) => k.status === "done").length} of ${mine.length} orders done.`;
        return {
          week: r.week,
          goal: g?.goal ? clip(g.goal, 200) : null,
          result,
          done: mine.filter((k) => k.status === "done").length,
          total: mine.length,
          credits: { used: r.spent_credits, budget: r.budget_credits },
        };
      });
    },
  });
}

// ------------------------------------------------------------------ voice and skills (P3 A3)

/** A row of `voice_notes` (A1): the founder's own words from one decision, its profile and its weight today. */
type VoiceNoteRow = {
  id: string;
  body: string;
  platform: string | null;
  source: "approved" | "edited" | "skipped";
  edit_mode: string | null;
  created_at: string;
  weight: number;
};

/** What an edit mode says the founder did, as Library → Voice names where a note came from. */
const EDIT_SOURCE: Record<string, string> = {
  TOO_SALESY: "less selling",
  WRONG_VOICE: "your own voice",
  INVENTED_CLAIM: "a claim taken out",
  TOO_LONG: "shorter",
  HOOK_REWRITTEN: "a new first line",
  CTA_REMOVED: "no closing ask",
  FULL_REWRITE: "rewritten",
};

function voiceSource(note: VoiceNoteRow): string {
  if (note.source === "approved") return "Approved as written";
  if (note.source === "skipped") return "From a skip reason";
  return `From your edit: ${EDIT_SOURCE[note.edit_mode ?? ""] ?? "rewritten"}`;
}

/** The founder's live voice notes, newest (heaviest) first, under their own session. */
async function voiceNotes(supabase: SupabaseClient, limit: number): Promise<VoiceNoteRow[]> {
  const rows = must(await supabase.rpc("voice_notes", { p_limit: limit, p_platform: null }), "voice_notes") as VoiceNoteRow[];
  return rows.map((r) => ({ ...r, weight: Math.min(1, Math.max(0, Number(r.weight))) }));
}

/** The words the strategy says to avoid: what Writer cuts from every draft. */
async function wordsCut(supabase: SupabaseClient): Promise<string[]> {
  const r = await supabase.from("marketing_documents_latest").select("body").eq("kind", "strategy").maybeSingle();
  if (r.error) throw new Error(`marketing_documents_latest: ${r.error.message}`);
  const avoid = (r.data as { body?: { avoid?: unknown } } | null)?.body?.avoid;
  return Array.isArray(avoid)
    ? avoid.filter((w): w is string => typeof w === "string").map((w) => w.trim()).filter((w) => w && w.length <= 40).slice(0, 20)
    : [];
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const shortDate = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The registry agents a built-in writing skill names, as the Library calls them. */
function readersOf(agents: readonly string[]): LibraryScreen["skills"]["writing"][number]["readBy"] {
  const name = (agent: string): (typeof SKILL_READERS)[number] | null =>
    agent === "writer" || agent.endsWith("_writer") ? "Writer" : agent === "checker" ? "Checker" : agent === "sales" ? "Sales" : agent === "cmo" ? "CMO chat" : null;
  return [...new Set(agents.map(name).filter((r): r is (typeof SKILL_READERS)[number] => r !== null))];
}

async function library({ supabase }: LoadContext): Promise<Partial<LibraryScreen>> {
  return parts<LibraryScreen>("library", {
    voice: async () => {
      const [notes, words] = await Promise.all([voiceNotes(supabase, 40), wordsCut(supabase)]);
      return {
        notes: notes.map((n) => ({
          id: n.id,
          text: clip(n.body, 600),
          platform: (n.platform && profileOf(n.platform)?.platform) || null,
          source: voiceSource(n),
          at: new Date(n.created_at).toISOString(),
          weight: n.weight,
          replaces: null,
        })),
        wordsCut: words,
      };
    },
    // Read only (brain.md §8b): the writing guidance and profiles we ship, the style skills, and the founder's own
    // saved from the editor Assistant. Department playbooks stay with their departments.
    skills: async () => {
      const own = must(await supabase.from("editor_skills").select("id, name, description, created_at").order("created_at").limit(50), "editor_skills") as {
        id: string;
        name: string;
        description: string;
        created_at: string;
      }[];
      const slop = CMO_SKILLS["no-ai-slop"];
      return {
        writing: [
          { id: "no-ai-slop", name: "Plain writing (No AI Slop)", origin: "built_in" as const, note: clip(`Guidance, never a hard filter: ${slop.description}`, 200), readBy: readersOf(slop.agents) },
          {
            id: "platform-profiles",
            name: "Platform profiles",
            origin: "built_in" as const,
            note: clip(`Length, the cut before “more” and the tone for ${POST_PROFILES.map((p) => p.label).join(", ")} and video captions. No links; hashtags only on video captions.`, 200),
            readBy: ["Writer", "Checker"],
          },
        ],
        video: [
          ...readyStyles().map((style) => ({ id: `style-${style.name}`, name: style.name, origin: "built_in" as const, note: clip(style.description, 200), readBy: ["Studio", "Editor Assistant"] as ("Studio" | "Editor Assistant")[] })),
          ...own.map((skill) => ({ id: skill.id, name: skill.name.slice(0, 80), origin: "yours" as const, note: clip(`${skill.description} · saved ${shortDate(skill.created_at)}`, 200), readBy: ["Editor Assistant"] as "Editor Assistant"[] })),
        ],
      };
    },
    site: async () => {
      const r = await supabase.from("cmo_runs").select("input").eq("kind", "onboard").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (r.error) throw new Error(`cmo_runs: ${r.error.message}`);
      const site = (r.data as { input?: { site?: string } } | null)?.input?.site;
      return typeof site === "string" ? site.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 200) : null;
    },
    documents: async () => {
      const rows = must(await supabase.from("marketing_documents_latest").select("kind, created_by, created_at"), "marketing_documents_latest") as {
        kind: DocumentKind;
        created_by: "agent" | "user";
        created_at: string;
      }[];
      return DOCUMENT_KINDS.flatMap((kind) => {
        const row = rows.find((r) => r.kind === kind);
        if (!row) return [];
        const doc = DOCUMENTS[kind];
        return [{ kind, title: doc.title, summary: doc.summary.slice(0, 300), fields: doc.fields.length, editedBy: row.created_by, editedAt: new Date(row.created_at).toISOString(), note: null }];
      });
    },
    brandKits: async () => {
      const rows = must(await supabase.from("brand_kits").select("id, name, kit, is_default").order("created_at").limit(20), "brand_kits") as {
        id: string;
        name: string;
        kit: BrandKitJson | null;
      }[];
      return Promise.all(
        rows.map(async (row) => {
          const k = row.kit ?? {};
          const logo = k.logo && typeof k.logo.object === "string" ? { ...k.logo, object: k.logo.object } : null;
          const signed = logo ? await supabase.storage.from("brand").createSignedUrl(logo.object, 3600) : null;
          return {
            id: row.id,
            name: row.name.slice(0, 60),
            colors: k.colors!,
            fonts: { heading: String(k.fonts?.heading ?? "Inter"), body: String(k.fonts?.body ?? "Inter") },
            captionStyle: String(k.captions?.preset ?? "classic"),
            aspect: k.layout?.aspect ?? "9:16",
            fit: k.layout?.fit ?? "fill",
            logo: logo ? { url: signed?.data?.signedUrl ?? null, corner: logo.corner ?? "top-right", size: logo.size ?? 0.08 } : null,
          };
        }),
      );
    },
  });
}

/** The parts of a stored kit (`brand_kits.kit`, checked by `save_brand_kit`) the Library shows. */
type BrandKitJson = {
  colors?: LibraryScreen["brandKits"][number]["colors"];
  fonts?: { heading?: string; body?: string };
  captions?: { preset?: string };
  layout?: { aspect?: LibraryScreen["brandKits"][number]["aspect"]; fit?: LibraryScreen["brandKits"][number]["fit"] };
  logo?: { object?: string; corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right"; size?: number } | null;
};

async function settings({ supabase, userId }: LoadContext): Promise<Partial<SettingsScreen>> {
  const prof = profile(supabase, userId);
  return parts<SettingsScreen>("settings", {
    accounts: async () => accountList(await socialAccounts(supabase), true),
    cmo: () => cmoState(supabase, userId, prof),
    weeklyCreditBudget: async () => (await prof).weekly_credit_budget,
    timezone: async () => (await prof).timezone,
    digestHour: async () => (await prof).digest_hour,
    plan: async () => {
      const [p, balance] = await Promise.all([prof, supabase.rpc("credit_balance", { p_user_id: userId })]);
      const name = p.plan.charAt(0).toUpperCase() + p.plan.slice(1);
      return { name: name.slice(0, 40), credits: typeof balance.data === "number" ? balance.data : null };
    },
  });
}

type SocialAccountDb = { id: string; platform: string; handle: string; avatar_url: string | null; status: string; updated_at: string };

async function socialAccounts(supabase: SupabaseClient): Promise<SocialAccountDb[]> {
  return must(
    await supabase.from("social_accounts").select("id, platform, handle, avatar_url, status, updated_at").order("connected_at"),
    "social_accounts",
  ) as SocialAccountDb[];
}

/**
 * Every platform OpenCMO posts to, connected or not (P4 F1): Settings offers Connect for the rest. `reconnect` when
 * Zernio reports the account refused or gone; then posts to it wait until the founder connects it again.
 */
function accountList(rows: SocialAccountDb[], all: boolean): SettingsScreen["accounts"] {
  const byPlatform = new Map(rows.map((r) => [r.platform, r]));
  return PUBLISH_PLATFORMS.flatMap((platform): SettingsScreen["accounts"] => {
    const r = byPlatform.get(platform);
    if (!r) return all ? [{ id: `connect-${platform}`, platform, handle: "", status: "not_connected" as const, syncedAt: null, noDataSince: null, avatarUrl: null }] : [];
    const connected = r.status === "connected";
    return [{
      id: r.id,
      platform,
      handle: r.handle.slice(0, 80),
      status: connected ? ("connected" as const) : ("reconnect" as const),
      syncedAt: connected ? iso(r.updated_at) : null,
      noDataSince: connected ? null : iso(r.updated_at),
      avatarUrl: r.avatar_url,
    }];
  });
}

type SlotDb = {
  id: string;
  platform: string;
  status: string;
  publish_at: string;
  error: { message?: string } | null;
  external_url: string | null;
  approval_id: string | null;
  account: { handle: string } | null;
  deliverable: { kind: string; ref_kind: string; ref_id: string } | null;
};

/** SQL's slot statuses on the calendar's five (`SLOT_STATUSES`); a card still waiting makes it the founder's turn. */
function slotStatus(s: SlotDb, waiting: Set<string>): { status: ScheduleScreen["slots"][number]["status"]; note: string | null } {
  switch (s.status) {
    case "proposed":
      return { status: s.approval_id && waiting.has(s.approval_id) ? "waiting_founder" : "proposed", note: null };
    case "waiting":
    case "due":
    case "publishing":
      return { status: "scheduled", note: null };
    case "reminded":
      return { status: "scheduled", note: "post it yourself" };
    case "published":
      return { status: "posted", note: null };
    case "missed":
      return { status: "failed", note: "missed" };
    default:
      return { status: "failed", note: s.error?.message ? s.error.message.slice(0, 80) : "failed" };
  }
}

const SCHEDULE_RULES: string[] = [
  `At most ${scheduleDefaults.platforms.x.dailyCap} posts a day on X; on other platforms as many as their best times. ${scheduleDefaults.minGapHours} hours apart.`,
  "Times start from common best times (Buffer's 2026 study) in your time zone. Once a platform has 10 published posts with numbers, your own best hours take over.",
  "A short and its long video never go out on one platform the same day.",
  "Drag a slot to move it. A new time or account asks you again.",
  `A post that misses its time by ${scheduleDefaults.windowMinutes} minutes is never posted late: you get a new time to approve.`,
];

async function schedule({ supabase, userId, params }: LoadContext): Promise<Partial<ScheduleScreen>> {
  const prof = profile(supabase, userId);
  // The week starts at Monday midnight where the founder is: a Monday 06:00 post in UTC+7 is Monday's, not Sunday's.
  // A profile that cannot be read leaves the timezone field to fail on its own, as each field does.
  const timezone = await prof.then((p) => p.timezone, () => "UTC");
  const asked = params.get("from");
  const askedDay = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && !Number.isNaN(Date.parse(`${asked}T12:00:00Z`)) ? asked : null;
  const monday = askedDay ? localMonday(Date.parse(`${askedDay}T12:00:00Z`), "UTC") : localMonday(Date.now(), timezone);
  const nextMonday = new Date(Date.parse(`${monday}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const from = new Date(localMidnight(monday, timezone) ?? `${monday}T00:00:00Z`);
  const to = new Date(localMidnight(nextMonday, timezone) ?? `${nextMonday}T00:00:00Z`);
  return parts<ScheduleScreen>("schedule", {
    timezone: async () => (await prof).timezone,
    from: async () => from.toISOString(),
    to: async () => to.toISOString(),
    slots: async () => {
      const slots = must(
        await supabase
          .from("schedule_slots")
          .select("id, platform, status, publish_at, error, external_url, approval_id, account:social_accounts(handle), deliverable:deliverables(kind, ref_kind, ref_id)")
          .gte("publish_at", from.toISOString())
          .lt("publish_at", to.toISOString())
          .neq("status", "cancelled")
          .order("publish_at")
          .limit(300),
        "schedule_slots",
      ) as unknown as SlotDb[];
      const items = [...new Set(slots.flatMap((s) => (s.deliverable?.ref_kind === "content_item" ? [s.deliverable.ref_id] : [])))];
      const clips = [...new Set(slots.flatMap((s) => (s.deliverable?.ref_kind === "clip" ? [s.deliverable.ref_id] : [])))];
      const approvals = [...new Set(slots.flatMap((s) => (s.approval_id ? [s.approval_id] : [])))];
      const [itemRows, clipRows, waitingRows] = await Promise.all([
        items.length ? supabase.from("content_items").select("id, idea, body").in("id", items) : Promise.resolve({ data: [] }),
        clips.length ? supabase.from("clips").select("id, hook").in("id", clips) : Promise.resolve({ data: [] }),
        approvals.length ? supabase.from("approvals").select("id").in("id", approvals).eq("status", "waiting") : Promise.resolve({ data: [] }),
      ]);
      const titles = new Map<string, string>([
        ...((itemRows.data ?? []) as { id: string; idea: string | null; body: { text?: string } | null }[]).map(
          (r) => [r.id, (r.body?.text?.split("\n")[0] || r.idea || "Post").slice(0, 300)] as [string, string],
        ),
        ...((clipRows.data ?? []) as { id: string; hook: string | null }[]).map((r) => [r.id, `Short · ${r.hook || "Untitled"}`.slice(0, 300)] as [string, string]),
      ]);
      const waiting = new Set(((waitingRows.data ?? []) as { id: string }[]).map((r) => r.id));
      return slots.flatMap((s) => {
        const platform = PUBLISH_PLATFORMS.find((p) => p === s.platform);
        if (!platform) return [];
        const { status, note } = slotStatus(s, waiting);
        return [{
          id: s.id,
          at: iso(s.publish_at)!,
          where: { platform, handle: (s.account?.handle ?? "").slice(0, 80) },
          title: titles.get(s.deliverable?.ref_id ?? "") ?? "Post",
          status,
          note,
          // A card still waiting (a time to approve, a failed post's Retry, a copy-and-open) opens from its slot.
          approvalId: s.approval_id && waiting.has(s.approval_id) ? s.approval_id : null,
          url: status === "posted" && s.external_url?.startsWith("https://") ? s.external_url : null,
        }];
      });
    },
    accounts: async () => accountList(await socialAccounts(supabase), false),
    rules: async () => SCHEDULE_RULES,
  });
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The rows Studio's cards decide, per order: its steps, its shorts batches and its video's edit (card 3). */
async function studioRefs(supabase: SupabaseClient, orderIds: string[]): Promise<{ order_id: string; ref_id: string }[]> {
  const [steps, batches] = await Promise.all([
    supabase.from("studio_steps").select("id, order_id, clip_id").in("order_id", orderIds),
    supabase.from("short_batches").select("id, order_id").in("order_id", orderIds),
  ]);
  const stepRows = must(steps, "studio_steps") as { id: string; order_id: string; clip_id: string }[];
  return [
    ...stepRows.map((r) => ({ order_id: r.order_id, ref_id: r.id })),
    ...[...new Map(stepRows.map((r) => [r.clip_id, r.order_id])).entries()].map(([clip, order]) => ({ order_id: order, ref_id: clip })),
    ...(must(batches, "short_batches") as { id: string; order_id: string }[]).map((r) => ({ order_id: r.order_id, ref_id: r.id })),
  ];
}

type StepDb = VideoStepRow & { id: string; order_id: string; clip_id: string; created_at: string };
const STEP_COLUMNS = "id, order_id, clip_id, tool, kind, status, decision, card, next, next_done_at, created_at";

/** Each video order's team steps, oldest step first. */
async function videoStepsByOrder(supabase: SupabaseClient, orders: { id: string; status: string }[]): Promise<Map<string, TeamStep[]>> {
  const out = new Map<string, TeamStep[]>();
  if (!orders.length) return out;
  const ids = orders.map((o) => o.id);
  const [steps, card3] = await Promise.all([
    supabase.from("studio_steps").select(STEP_COLUMNS).in("order_id", ids).order("created_at", { ascending: true }),
    supabase.from("approvals").select("ref_id").eq("ref_kind", "editor_project").eq("status", "waiting"),
  ]);
  const rows = must(steps, "studio_steps") as StepDb[];
  const waiting = new Set((must(card3, "approvals") as { ref_id: string }[]).map((r) => r.ref_id));
  for (const o of orders) {
    const mine = rows.filter((r) => r.order_id === o.id);
    out.set(o.id, videoSteps(o as { status: OrderDb["status"] }, mine, mine.some((r) => waiting.has(r.clip_id))));
  }
  return out;
}

const isHttps = (u: unknown): u is string => typeof u === "string" && /^https:\/\/\S+$/.test(u) && u.length <= 500;

/** Waiting cards keyed by the row they decide. */
async function waitingByRef(supabase: SupabaseClient, refKind: string): Promise<Map<string, string>> {
  const rows = must(await supabase.from("approvals").select("id, ref_id").eq("ref_kind", refKind).eq("status", "waiting"), "approvals") as {
    id: string;
    ref_id: string;
  }[];
  return new Map(rows.map((r) => [r.ref_id, r.id]));
}

async function research({ supabase }: LoadContext): Promise<Partial<ResearchScreen>> {
  const now = new Date();
  const latest = supabase.from("cmo_insights").select("body, created_at").eq("kind", "competitors").order("created_at", { ascending: false }).limit(1).maybeSingle();
  // P5 R2: what works on video in the founder's niche, the newest run.
  const niche = supabase.from("cmo_insights").select("body, created_at").eq("kind", "niche_video").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return parts<ResearchScreen>("research", {
    lastRunAt: async () => {
      const r = await supabase.from("cmo_runs").select("finished_at").in("kind", ["competitor_research", "niche_video_research"]).eq("status", "done").order("finished_at", { ascending: false }).limit(1).maybeSingle();
      if (r.error) throw new Error(`cmo_runs: ${r.error.message}`);
      return iso((r.data as { finished_at: string | null } | null)?.finished_at);
    },
    // The research loop runs on Sunday's 00:05 UTC schedule.
    nextRunAt: async () => {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((7 - now.getUTCDay()) % 7), 0, 5));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
      return next.toISOString();
    },
    insights: async () => {
      const [r, n] = await Promise.all([latest, niche]);
      if (r.error) throw new Error(`cmo_insights: ${r.error.message}`);
      if (n.error) throw new Error(`cmo_insights: ${n.error.message}`);
      type NicheRow = { platform?: string; url?: string; hook?: string; format?: string; why?: string; views?: number; lift?: number };
      const videos = (((n.data as { body?: { videos?: NicheRow[] } } | null)?.body?.videos ?? []) as NicheRow[])
        .filter((v) => typeof v.hook === "string" && v.hook && isHttps(v.url))
        .slice(0, 12)
        .map((v, i) => ({
          id: `video-${i}`,
          type: "hook" as const,
          scope: "niche_video" as const,
          platform: v.platform === "youtube" ? "Shorts" : "TikTok",
          text: v.hook!.slice(0, 300),
          evidence: [typeof v.lift === "number" ? `${v.lift}× the search's median` : "", v.format ?? "", v.why ?? ""].filter(Boolean).join(" · ").slice(0, 200),
          usedIn: null,
          sources: [v.url!],
          video: {
            views: typeof v.views === "number" ? Math.max(0, Math.round(v.views)) : null,
            outlier: typeof v.lift === "number" ? v.lift : null,
            seconds: null,
            format: v.format ? v.format.slice(0, 60) : null,
          },
        }));
      const body = ((r.data as { body?: { hooks?: unknown[] } } | null)?.body ?? {}) as { hooks?: { pattern?: string; example?: string; url?: string; lift?: number }[] };
      // Every insight points to the post it came from: one without a link is dropped (counted in `dropped`).
      const hooks: ResearchScreen["insights"] = (body.hooks ?? [])
        .filter((h) => typeof h.pattern === "string" && h.pattern && isHttps(h.url))
        .slice(0, 20)
        .map((h, i) => ({
          id: `hook-${i}`,
          type: "hook" as const,
          scope: "competitors" as const,
          platform: "X",
          text: h.pattern!.slice(0, 300),
          evidence: `${typeof h.lift === "number" ? `${h.lift}× the account's median` : "Above the account's median"}${h.example ? ` · “${h.example.slice(0, 120)}”` : ""}`.slice(0, 200),
          usedIn: null,
          sources: [h.url!],
        }));
      return [...hooks, ...videos];
    },
    dropped: async () => {
      const r = await latest;
      if (r.error) throw new Error(`cmo_insights: ${r.error.message}`);
      const body = ((r.data as { body?: unknown } | null)?.body ?? {}) as { hooks?: { url?: unknown }[]; formats?: unknown[]; ideas?: unknown[] };
      return (body.hooks ?? []).filter((h) => !isHttps(h.url)).length + (body.formats ?? []).length + (body.ideas ?? []).length;
    },
    results: async () => {
      const metrics = must(await supabase.from("post_metrics").select("item_id, views, replies, measured_at").order("measured_at", { ascending: false }).limit(100), "post_metrics") as {
        item_id: string;
        views: number | null;
        replies: number | null;
      }[];
      const latestPerItem = [...new Map(metrics.map((m) => [m.item_id, m])).values()].slice(0, 10);
      if (!latestPerItem.length) return [];
      const items = must(await supabase.from("content_items").select("id, idea, final_text, platform").in("id", latestPerItem.map((m) => m.item_id)), "content_items") as {
        id: string;
        idea: string;
        final_text: string | null;
        platform: string | null;
      }[];
      return latestPerItem.map((m) => {
        const item = items.find((i) => i.id === m.item_id);
        // P6 measures Threads, LinkedIn and video posts too, not only X.
        return { id: m.item_id, title: (item?.final_text ?? item?.idea ?? "Your post").slice(0, 200), platform: screenPlatform(item?.platform, "x"), views: orNull(m.views), replies: orNull(m.replies) };
      });
    },
  });
}

/** The screen platform of a calendar label or profile id ("LinkedIn" → linkedin, "tiktok_caption" → tiktok). */
function screenPlatform(label: string | null | undefined, fallback: WriterScreen["drafts"][number]["platform"]): WriterScreen["drafts"][number]["platform"] {
  return profileOf(profileIdOf(label) ?? "")?.platform ?? fallback;
}

async function writer({ supabase }: LoadContext): Promise<Partial<WriterScreen>> {
  return parts<WriterScreen>("writer", {
    // Posts on their own platform, captions per platform (P3 A2: video words for one edit), and the briefs Writer
    // wrote for Studio, over the last two weeks.
    drafts: async () => {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      type ItemRow = {
        id: string;
        day: string;
        idea: string;
        platform: string;
        status: "planned" | "drafting" | "in_review" | "approved" | "published";
        body: { text?: string; title?: string; alternates?: unknown[]; edited_at?: string };
        final_text: string | null;
        published_at: string | null;
        clip_id: string | null;
      };
      const columns = "id, day, idea, platform, status, body, final_text, published_at, clip_id";
      const statuses = ["planned", "drafting", "in_review", "approved", "published"];
      const [posts, captions, briefs, cards, videoCards, batchCards, shorts] = await Promise.all([
        supabase.from("content_items").select(columns).eq("department", "post").in("status", statuses).gte("day", since).order("day").limit(100),
        supabase.from("content_items").select(columns).eq("department", "video").not("clip_id", "is", null).in("status", statuses).gte("day", since).order("day").limit(60),
        supabase.from("work_orders").select("id, status, brief, due_at, created_at").eq("kind", "write_video_brief").in("status", ["queued", "running", "deferred", "done"]).gte("created_at", `${since}T00:00:00Z`).order("created_at").limit(20),
        waitingByRef(supabase, "content_item"),
        waitingByRef(supabase, "editor_project"),
        waitingByRef(supabase, "short_batch"),
        supabase.from("shorts").select("short_clip_id, batch_id").not("short_clip_id", "is", null).gte("created_at", `${since}T00:00:00Z`).limit(200),
      ]);
      const column = { planned: "drafting", drafting: "drafting", in_review: "waiting", approved: "scheduled", published: "posted" } as const;
      const dayText = (day: string) => WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
      const batchOf = new Map((must(shorts, "shorts") as { short_clip_id: string; batch_id: string }[]).map((s) => [s.short_clip_id, s.batch_id]));
      const postDrafts = (must(posts, "content_items") as ItemRow[]).map((r) => {
        const text = typeof r.body.text === "string" && r.body.text ? r.body.text : r.idea;
        const edited = r.final_text !== null && r.final_text !== r.body.text;
        return {
          id: r.id,
          kind: "post" as const,
          platform: screenPlatform(r.platform, "x"),
          at: iso(r.published_at),
          dayText: r.published_at ? null : dayText(r.day),
          title: (r.final_text ?? text).slice(0, 300),
          column: column[r.status],
          versions: Math.min(3, Math.max(1, 1 + (Array.isArray(r.body.alternates) ? r.body.alternates.length : 0))),
          note: r.status === "published" || r.status === "approved" ? (edited ? "You edited it before approving" : "Approved as drafted") : null,
          approvalId: cards.get(r.id) ?? null,
        };
      });
      const captionDrafts = (must(captions, "content_items") as ItemRow[]).map((r) => {
        const card = videoCards.get(r.clip_id!) ?? batchCards.get(batchOf.get(r.clip_id!) ?? "") ?? null;
        return {
          id: r.id,
          kind: "caption" as const,
          platform: screenPlatform(r.platform, "tiktok"),
          at: iso(r.published_at),
          dayText: r.published_at ? null : dayText(r.day),
          title: (typeof r.body.title === "string" && r.body.title ? r.body.title : typeof r.body.text === "string" ? r.body.text : r.idea).slice(0, 300),
          column: column[r.status],
          versions: 1,
          note: r.body.edited_at ? "You edited it on the card" : r.status === "in_review" ? "On the video's card" : null,
          approvalId: card,
        };
      });
      const briefDrafts = (must(briefs, "work_orders") as { id: string; status: string; brief: { objective?: string; platform?: string }; due_at: string | null; created_at: string }[]).map((o) => ({
        id: o.id,
        kind: "video_brief" as const,
        platform: screenPlatform(o.brief.platform, "youtube"),
        at: null,
        dayText: dayText((o.due_at ?? o.created_at).slice(0, 10)),
        title: (typeof o.brief.objective === "string" && o.brief.objective ? o.brief.objective : "This week's video").slice(0, 300),
        column: o.status === "done" ? ("posted" as const) : ("drafting" as const),
        versions: 1,
        note: o.status === "done" ? "Fed the Studio team" : null,
        approvalId: null,
      }));
      return [...postDrafts, ...captionDrafts, ...briefDrafts];
    },
    // What Writer reads first: the rules the founder approved, then their heaviest voice notes; the product rule.
    voice: async () => {
      const [rules, notes, words] = await Promise.all([
        supabase.from("cmo_corrections").select("rule, created_at, decided_at").eq("status", "active").order("created_at", { ascending: false }).limit(10),
        voiceNotes(supabase, 8),
        wordsCut(supabase),
      ]);
      const label = (platform: string | null) => (platform ? (profileOf(platform)?.label ?? "") : "");
      return {
        lines: [
          ...(must(rules, "cmo_corrections") as { rule: string; created_at: string; decided_at: string | null }[]).map((r) => ({
            text: clip(r.rule, 200),
            source: `Rule you approved · ${shortDate(r.decided_at ?? r.created_at)}`,
          })),
          ...notes.map((n) => ({
            text: clip(n.body, 200),
            source: clip([voiceSource(n), label(n.platform), `weight ${n.weight.toFixed(2)}`].filter(Boolean).join(" · "), 120),
          })),
          { text: "No links, no hashtags in posts.", source: "Product rule · hashtags only on video captions" },
        ],
        wordsCut: words,
      };
    },
  });
}

/**
 * Studio (P2 A5): the long videos the brain's orders make and the shorts batches, with their cards; the Video team
 * panel for the video in progress; and every recent edit's finished state (`editStates`), which the page puts on the
 * upload cards it reads from `/api/v1/projects`. Uploads themselves stay on that route.
 */
async function studioScreen({ supabase }: LoadContext): Promise<Partial<StudioScreen>> {
  type VideoOrder = { id: string; title: string; status: OrderDb["status"]; created_at: string; updated_at: string; error: { message?: string } | null; brief: { seconds?: number } };
  type Edit = { clip_id: string; document_hash: string; finished_at: string | null; finished_hash: string | null; updated_at: string; clips: { kind: "full" | "blank" | "short" | "slideshow"; hook: string | null } | null };
  const videos = supabase
    .from("work_orders")
    .select("id, title, status, created_at, updated_at, error, brief")
    .eq("kind", "build_video")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(20)
    .then((r) => must(r, "work_orders") as VideoOrder[]);
  const edits = supabase
    .from("editor_projects")
    .select("clip_id, document_hash, finished_at, finished_hash, updated_at, clips(kind, hook)")
    .order("updated_at", { ascending: false })
    .limit(100)
    .then((r) => must(r, "editor_projects") as unknown as Edit[]);
  const steps = videos.then(async (orders) =>
    orders.length
      ? (must(await supabase.from("studio_steps").select(STEP_COLUMNS).in("order_id", orders.map((o) => o.id)).order("created_at", { ascending: true }), "studio_steps") as StepDb[])
      : [],
  );
  const cards = Promise.all([waitingByRef(supabase, "studio_step"), waitingByRef(supabase, "editor_project"), waitingByRef(supabase, "short_batch")]);

  return parts<StudioScreen>("studio", {
    items: async () => {
      const [orders, stepRows, editRows, [stepCards, editCards, batchCards]] = await Promise.all([videos, steps, edits, cards]);
      const editOf = new Map(editRows.map((e) => [e.clip_id, e]));
      const videoItems = orders.map((o) => {
        const mine = stepRows.filter((r) => r.order_id === o.id);
        const clipId = mine.at(-1)?.clip_id ?? null;
        const edit = clipId ? editOf.get(clipId) : undefined;
        const finished = !!edit?.finished_hash && edit.finished_hash === edit.document_hash;
        const waitingStep = mine.find((r) => stepCards.has(r.id));
        const approvalId = (waitingStep && stepCards.get(waitingStep.id)) ?? (clipId ? editCards.get(clipId) : undefined) ?? null;
        const status: StudioItem["status"] =
          o.status === "done" ? (finished ? "finished" : "ready") : o.status === "failed" ? "failed" : o.status === "waiting_founder" ? "waiting_founder" : "running";
        const seconds = typeof o.brief.seconds === "number" ? ` · ${o.brief.seconds} s` : "";
        const now = videoSteps(o, mine, !!(clipId && editCards.has(clipId))).find((s) => s.state === "running");
        return {
          id: o.id,
          kind: "video" as const,
          title: o.title.slice(0, 200),
          subtitle: `AI video${seconds}${status === "finished" ? " · finished" : now ? ` · ${now.label.toLowerCase()}` : ""}`.slice(0, 200),
          status,
          progress: null,
          favorite: false,
          createdAt: new Date(o.created_at).toISOString(),
          editedAt: edit ? new Date(edit.updated_at).toISOString() : null,
          failure: o.status === "failed" ? (o.error?.message ?? "The video could not be made.").slice(0, 200) : null,
          projectId: null,
          editorHref: clipId ? `/app/editor/${clipId}` : null,
          approvalId,
          // Only a built video is finished: once the order reached its render, Mark finished is card 3's approval.
          canMarkFinished: !!edit && !finished && o.status !== "failed" && (o.status === "done" || mine.some((r) => r.next?.tool === "render")),
          clipId,
          documentHash: edit?.document_hash ?? null,
          canCutShorts: finished,
          edits: [],
        };
      });

      const batches = must(
        await supabase.from("short_batches").select("id, parent_clip_id, status, error, created_at, decided_at, shorts(id, status)").order("created_at", { ascending: false }).limit(20),
        "short_batches",
      ) as { id: string; parent_clip_id: string; status: string; error: string | null; created_at: string; decided_at: string | null; shorts: { id: string; status: string }[] }[];
      const batchItems = batches.map((b) => {
        const parent = editOf.get(b.parent_clip_id)?.clips?.hook ?? "your video";
        const count = b.shorts.filter((x) => x.status !== "failed").length;
        const status: StudioItem["status"] =
          b.status === "approved" ? "finished" : b.status === "waiting_founder" ? "waiting_founder" : b.status === "failed" ? "failed" : b.status === "sent_back" || b.status === "cancelled" ? "cancelled" : "running";
        return {
          id: b.id,
          kind: "short" as const,
          title: `${count} ${count === 1 ? "short" : "shorts"} · ${parent}`.slice(0, 200),
          subtitle: (status === "running" ? "Cut from a finished edit · rendering" : status === "cancelled" ? "Sent back" : "Cut from a finished edit · 9:16").slice(0, 200),
          status,
          progress: null,
          favorite: false,
          createdAt: new Date(b.created_at).toISOString(),
          editedAt: iso(b.decided_at),
          failure: b.status === "failed" ? (b.error ?? "The shorts could not be rendered.").slice(0, 200) : null,
          projectId: null,
          editorHref: null,
          approvalId: batchCards.get(b.id) ?? null,
          canMarkFinished: false,
          clipId: null,
          documentHash: null,
          canCutShorts: false,
          edits: [],
        };
      });
      // P5 S3: the Slideshow and Post image squads' orders, each with the step that holds its edit and card.
      const made = must(
        await supabase
          .from("work_orders")
          .select("id, kind, title, status, created_at, error")
          .in("kind", ["build_slideshow", "build_post_image"])
          .neq("status", "cancelled")
          .order("created_at", { ascending: false })
          .limit(20),
        "work_orders",
      ) as { id: string; kind: "build_slideshow" | "build_post_image"; title: string; status: OrderDb["status"]; created_at: string; error: { message?: string } | null }[];
      const madeSteps = made.length
        ? (must(await supabase.from("studio_steps").select("id, order_id, clip_id, kind, status").in("order_id", made.map((o) => o.id)).order("created_at", { ascending: true }), "studio_steps") as {
            id: string;
            order_id: string;
            clip_id: string;
            kind: string;
            status: string;
          }[])
        : [];
      const madeItems = made.map((o) => {
        const step = madeSteps.filter((s) => s.order_id === o.id).at(-1);
        const slideshow = o.kind === "build_slideshow";
        const status: StudioItem["status"] =
          o.status === "done" ? "finished" : o.status === "failed" ? "failed" : o.status === "waiting_founder" ? "waiting_founder" : "running";
        const now = step?.status === "running" ? "rendering" : status === "running" ? "building" : status === "finished" ? (slideshow ? "approved" : "ready for its post") : "";
        return {
          id: o.id,
          kind: slideshow ? ("slideshow" as const) : ("post_image" as const),
          title: o.title.slice(0, 200),
          subtitle: `${slideshow ? "Slideshow · MP4 + PNG set" : "Post image"}${now ? ` · ${now}` : ""}`.slice(0, 200),
          status,
          progress: null,
          favorite: false,
          createdAt: new Date(o.created_at).toISOString(),
          editedAt: step ? (editOf.get(step.clip_id) ? new Date(editOf.get(step.clip_id)!.updated_at).toISOString() : null) : null,
          failure: o.status === "failed" ? (o.error?.message ?? (slideshow ? "The slideshow could not be made." : "The image could not be made.")).slice(0, 200) : null,
          projectId: null,
          editorHref: step ? `/app/editor/${step.clip_id}` : null,
          approvalId: step ? (stepCards.get(step.id) ?? null) : null,
          canMarkFinished: false,
          clipId: step?.clip_id ?? null,
          documentHash: step ? (editOf.get(step.clip_id)?.document_hash ?? null) : null,
          canCutShorts: false,
          edits: [],
        };
      });
      return [...videoItems, ...batchItems, ...madeItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    team: async () => {
      const [orders, stepRows, [, editCards]] = await Promise.all([videos, steps, cards]);
      const live = orders.find((o) => ["queued", "running", "waiting_founder", "waiting_order", "deferred"].includes(o.status));
      if (!live) return null;
      const mine = stepRows.filter((r) => r.order_id === live.id);
      const clip = mine.at(-1)?.clip_id;
      return { title: live.title.slice(0, 200), steps: videoSteps(live, mine, !!(clip && editCards.has(clip))) };
    },
    editStates: async () =>
      (await edits)
        .filter((e) => e.clips)
        .map((e) => ({
          clipId: e.clip_id,
          documentHash: e.document_hash,
          finishedAt: e.finished_hash === e.document_hash ? iso(e.finished_at) : null,
          kind: e.clips!.kind,
        })),
  });
}

async function sales({ supabase }: LoadContext): Promise<Partial<SalesScreen>> {
  return parts<SalesScreen>("sales", {
    threads: async () => {
      const [rows, cards] = await Promise.all([
        supabase.from("opportunities").select("id, url, community, title, posted_at, comments, score, score_parts, reply, status, rule, rule_why").order("created_at", { ascending: false }).limit(30),
        waitingByRef(supabase, "opportunity"),
      ]);
      type Part = { label?: string; score?: number; max?: number; evidence?: string };
      return (must(rows, "opportunities") as { id: string; url: string; community: string; title: string; posted_at: string | null; comments: number; score: number; score_parts: Part[] | null; reply: string | null; status: "in_review" | "replied" | "dismissed"; rule: "mention_ok" | "help_only" | "skip" | null; rule_why: string | null }[])
        .map((r) => {
          const parts = (r.score_parts ?? []).filter((p) => ["Pain", "Fit", "Timing", "Reach", "Evidence"].includes(p.label ?? "") && typeof p.score === "number" && typeof p.max === "number" && p.max > 0);
          return {
            id: r.id,
            score: Math.max(0, Math.min(100, Math.round(r.score))),
            community: (r.community || "Reddit").slice(0, 80),
            postedAt: iso(r.posted_at),
            comments: r.comments,
            title: r.title.slice(0, 300),
            url: r.url,
            // P5 R1: the rule the draft was written under. Threads from before it are help first, no product mention.
            rule: {
              kind: r.rule === "mention_ok" ? ("mention_allowed" as const) : r.rule === "skip" ? ("skipped" as const) : ("help_only" as const),
              text: (r.rule_why ?? (r.rule ? "" : "Rules not checked: help first")).slice(0, 200) || (r.rule === "skip" ? "Skipped by the community's rules" : "Help only"),
            },
            parts: parts.map((p) => ({ label: p.label as "Pain", score: p.score!, max: p.max! })),
            quotes: parts.filter((p) => typeof p.evidence === "string" && p.evidence).map((p) => ({ text: p.evidence!.slice(0, 400), from: p.label!.toLowerCase() })),
            draft: r.rule === "skip" ? null : r.reply,
            draftChecks: r.rule === "skip" || !r.reply ? null : `No links · under 120 words · ${r.rule === "mention_ok" ? "product named at most once" : "no product mention"}`,
            status: r.status === "in_review" ? ("open" as const) : r.status,
            approvalId: cards.get(r.id) ?? null,
          };
        })
        .sort((a, b) => Number(b.status === "open") - Number(a.status === "open"));
    },
    week: async () => {
      const monday = `${mondayOf()}T00:00:00Z`;
      const count = async (status: string) => {
        const r = await supabase.from("opportunities").select("id", { count: "exact", head: true }).eq("status", status).gte("decided_at", monday);
        if (r.error) throw new Error(`opportunities: ${r.error.message}`);
        return r.count ?? 0;
      };
      const [replied, dismissed] = await Promise.all([count("replied"), count("dismissed")]);
      return { replied, dismissed };
    },
    // P5 F3: product mentions in the last ten posted replies (at most one in ten).
    mentions: async () => {
      const r = await supabase.rpc("sales_mention_count");
      if (r.error) throw new Error(`sales_mention_count: ${r.error.message}`);
      return { used: Number(r.data ?? 0), window: 10 };
    },
    // P5 F6: the last two scans found nothing worth joining; the banner offers a scan with a new brief.
    stuck: async () => {
      const r = await supabase.from("cmo_runs").select("status, output").eq("kind", "sales_scan").in("status", ["done", "failed"]).order("created_at", { ascending: false }).limit(2);
      if (r.error) throw new Error(`cmo_runs: ${r.error.message}`);
      const runs = (r.data ?? []) as { status: string; output: { cards?: number } | null }[];
      if (runs.length < 2 || runs.some((x) => x.status !== "done" || (x.output?.cards ?? 0) > 0)) return null;
      return { text: "Your last two scans found no conversation worth joining. Try a different brief, or fewer excluded subreddits.", creditsToFinish: 5, found: 0 };
    },
    settings: async () => {
      const r = await supabase.from("sales_settings").select("excluded_subreddits, co_occurrence").maybeSingle();
      if (r.error) throw new Error(`sales_settings: ${r.error.message}`);
      const row = r.data as { excluded_subreddits: string[]; co_occurrence: [string, string][] } | null;
      return { excludedSubreddits: (row?.excluded_subreddits ?? []).slice(0, 50), pairs: (row?.co_occurrence ?? []).slice(0, 20) };
    },
  });
}

/**
 * What Analytics and the Dashboard's results read (P6 A1): accounts, their days and the newest reading of each post
 * published in twice the range (the second half is the comparison), all under the founder's RLS session. Published
 * posts come from `my_published_items`: a video's caption item counts once a slot published its clip, though the
 * caption itself stays `approved` (the slot publishes the clip, not the caption).
 */
/** A stored count as a number, or null when it was not reported (bigint columns can arrive as strings). */
const orNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

async function measured(supabase: SupabaseClient, range: number, now: Date): Promise<{ accounts: AccountIn[]; days: AccountDayIn[]; posts: PostIn[]; published: number }> {
  const since = new Date(now.getTime() - 2 * range * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);
  const [accounts, days, items] = await Promise.all([
    socialAccounts(supabase),
    supabase
      .from("account_metrics")
      .select("social_account_id, platform, handle, day, followers, impressions, engagements, video_views, measured_at")
      .gte("day", sinceDay)
      .order("day")
      .limit(5000),
    supabase.rpc("my_published_items", { p_since: since.toISOString() }),
  ]);
  const itemRows = (must(items, "my_published_items") as { item_id: string; platform: string; idea: string; final_text: string | null; published_at: string }[]).map(
    ({ item_id, ...rest }) => ({ id: item_id, ...rest }),
  );
  const metricRows = itemRows.length
    ? (must(
        await supabase
          .from("post_metrics")
          .select("item_id, url, views, likes, replies, reposts, impressions, engagements, measured_at")
          .in("item_id", itemRows.map((i) => i.id))
          .order("measured_at", { ascending: false })
          .limit(5000),
        "post_metrics",
      ) as { item_id: string; url: string; views: number | null; likes: number | null; replies: number | null; reposts: number | null; impressions: number | null; engagements: number | null }[])
    : [];
  const newest = new Map<string, (typeof metricRows)[number]>();
  for (const m of metricRows) if (!newest.has(m.item_id)) newest.set(m.item_id, m);
  const posts: PostIn[] = itemRows.flatMap((i) => {
    const m = newest.get(i.id);
    // "tiktok_caption" → tiktok: a caption item is measured on its platform.
    const platform = screenPlatform(i.platform, "x");
    return m
      ? [{
          id: i.id,
          title: (i.final_text ?? i.idea).split("\n")[0]!.slice(0, 200),
          platform,
          publishedAt: new Date(i.published_at).toISOString(),
          views: orNull(m.views),
          impressions: orNull(m.impressions),
          engagements: orNull(m.engagements),
          likes: orNull(m.likes),
          replies: orNull(m.replies),
          reposts: orNull(m.reposts),
          url: m.url || null,
        }]
      : [];
  });
  const fromRange = new Date(now.getTime() - range * 86_400_000).toISOString();
  return {
    accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, avatarUrl: a.avatar_url, status: a.status, updatedAt: a.updated_at })),
    days: (must(days, "account_metrics") as AccountDayIn[]).map((d) => ({
      ...d,
      followers: d.followers === null ? null : Number(d.followers),
      impressions: d.impressions === null ? null : Number(d.impressions),
      engagements: d.engagements === null ? null : Number(d.engagements),
      video_views: d.video_views === null ? null : Number(d.video_views),
    })),
    posts,
    published: itemRows.filter((i) => i.published_at >= fromRange).length,
  };
}

async function analytics({ supabase, params }: LoadContext): Promise<Partial<AnalyticsScreen>> {
  const parsed = RangeSchema.safeParse(Number(params.get("range") ?? 30));
  const range = parsed.success ? parsed.data : 30;
  const now = new Date();
  const m = await measured(supabase, range, now);
  // `brainReads` is live and empty: no model reads these numbers yet, and a sample line would read as a real finding.
  return buildAnalytics({ range, now, accounts: m.accounts, days: m.days, posts: m.posts, publishedInRange: m.published });
}

/**
 * The rail's two status lines (P6 F14): the next slot waiting to go out (schedule cards wait on the founder, so only
 * approved slots count) and how many accounts Analytics reads. Null fields draw no line.
 */
export async function loadRailStatus({ supabase, userId }: Omit<LoadContext, "params">): Promise<RailStatus> {
  const [p, next, accounts] = await Promise.all([
    profile(supabase, userId),
    supabase.from("schedule_slots").select("publish_at").eq("status", "waiting").gt("publish_at", new Date().toISOString()).order("publish_at").limit(1).maybeSingle(),
    supabase.from("social_accounts").select("id", { count: "exact", head: true }).eq("status", "connected"),
  ]);
  const at = (next.data as { publish_at?: string } | null)?.publish_at ?? null;
  return { nextPostAt: at ? new Date(at).toISOString() : null, connectedAccounts: accounts.count ? accounts.count : null, timezone: p.timezone };
}

/**
 * Live readers, one per screen, under the founder's RLS session (no service role). A loader returns only the
 * fields it reads for real; `registry.ts` `live` must list them too before they replace sample data.
 */
export const LOADERS: { [N in ScreenName]?: Loader<N> } = { dashboard, analytics, brain, library, settings, schedule, research, writer, studio: studioScreen, sales };
