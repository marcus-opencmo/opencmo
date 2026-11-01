/**
 * An in-memory `CmoStore` for checks and evals: the same job code runs against it without
 * Supabase. Not `server-only`, so `tsx` scripts can import it.
 */

import type { VideoSource } from "../writer/types";
import { latestPerTopic } from "./context";
import { isoDay, type CmoStore, type CompetitorInsight, type ConnectedAccountRow, type ReplyOutcomeDue, type MetricRow, type ZernioPostRow, type NicheVideoInsight, type SalesSettings, type SubredditRule, type Documents, type Goal, type InboxRequest, type ItemRow, type Lesson, type MemoryEvent, type Opportunity, type QueuedRun, type Step, type VoiceNoteRow, type WeekResults } from "./types";
import type { AccountMetricRow } from "./metrics-source";

export type InboxItem = {
  id: string;
  kind: QueuedRun["kind"];
  input: Record<string, unknown>;
  step: string;
  request: InboxRequest;
  answers: Record<string, unknown>;
  memo: Record<string, unknown>;
  status: "open" | "claimed" | "submitted" | "done" | "expired";
  feedback: string | null;
  rounds: number;
};

export type RunState = QueuedRun & { status: string; steps: Step[]; error: string | null; output: unknown; notBefore?: number };

export function memoryStore(docs: Documents, memories: string[] = ["Skipped the X post \"Pricing\": too salesy"], events: MemoryEvent[] = [], corrections: string[] = []) {
  /** Voice notes as `voice_notes_for` would return them; tests push rows here, newest first. */
  const voice: VoiceNoteRow[] = [];
  /** Edits a caption run can read, and the captions it saved (`edited`: the founder's own, never overwritten). */
  const videos: VideoSource[] = [];
  const captions: { runId: string; clipId: string; profile: string; text: string; title: string | null; gen: Record<string, unknown>; edited: boolean }[] = [];
  const lessons: Lesson[] = [];
  const goals: Goal[] = [];
  const results: WeekResults = { posts: 0, replies: 0, views: 0 };
  const runs: RunState[] = [];
  const items: ItemRow[] = [];
  const opps: Opportunity[] = [];
  const rules = new Map<string, SubredditRule>();
  const salesSettings: SalesSettings = { excluded: [], pairs: [] };
  const mentions = { used: 0 };
  const insights: CompetitorInsight[] = [];
  const niche: NicheVideoInsight[] = [];
  const metrics: MetricRow[] = [];
  const zernio: { profileId: string | null; accounts: ConnectedAccountRow[]; posts: ZernioPostRow[]; days: AccountMetricRow[] } = {
    profileId: null,
    accounts: [],
    posts: [],
    days: [],
  };
  const inbox: InboxItem[] = [];
  const replies: (ReplyOutcomeDue & { check?: { status: string; votes: number | null; replies: number | null } })[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;
  const store: CmoStore = {
    async claim(runId) {
      const run = runs.find((r) => r.status === "queued" && (!runId || r.id === runId) && (!r.notBefore || r.notBefore <= Date.now()));
      if (!run) return null;
      run.status = "running";
      run.attempt += 1;
      return { id: run.id, user_id: run.user_id, kind: run.kind, input: run.input, attempt: run.attempt };
    },
    async step(run, steps) {
      const r = runs.find((x) => x.id === run.id)!;
      if (r.attempt !== run.attempt || r.status !== "running") return false;
      r.steps = steps.map((s) => ({ ...s }));
      return true;
    },
    async complete(run, ok, output, error) {
      const r = runs.find((x) => x.id === run.id)!;
      r.status = ok ? "done" : "failed";
      r.output = output;
      r.error = error;
      return true;
    },
    documents: async () => docs,
    memories: async () => memories,
    voiceNotes: async (_u, limit) => voice.slice(0, limit),
    videoSource: async (_u, clipId) => videos.find((video) => video.clipId === clipId) ?? null,
    async saveCaption(_u, runId, clipId, profile, text, title, gen) {
      const at = captions.findIndex((c) => c.clipId === clipId && c.profile === profile);
      if (at >= 0 && captions[at]!.edited) return;
      const row = { runId, clipId, profile, text, title, gen, edited: false };
      if (at >= 0) captions[at] = row;
      else captions.push(row);
    },
    memoryEvents: async () => events,
    corrections: async () => corrections,
    lessons: async () => latestPerTopic([...lessons].sort((a, b) => b.week.localeCompare(a.week))),
    goal: async (_u, week) => goals.find((g) => g.week === week) ?? null,
    weekResults: async () => ({ ...results }),
    async proposeGoal(_u, _run, week, goal) {
      const at = goals.findIndex((g) => g.week === week);
      if (at >= 0 && goals[at]!.status === "approved") return null;
      if (at >= 0) goals.splice(at, 1);
      const row: Goal = { id: id(), week, ...goal, status: "proposed", result: null };
      goals.push(row);
      return row;
    },
    async recordGoalResult(_u, week, result) {
      const goal = goals.find((g) => g.week === week && g.status === "approved");
      if (goal) goal.result = result;
      return Boolean(goal);
    },
    async saveLessons(_u, _run, week, list) {
      for (const l of list) {
        const at = lessons.findIndex((x) => x.week === week && x.topic === l.topic);
        if (at >= 0) lessons.splice(at, 1);
        lessons.push({ week, topic: l.topic, body: l.body });
      }
      return list.length;
    },
    async items(_u, f) {
      return items.filter((i) => (!f.statuses || f.statuses.includes(i.status)) && (!f.department || i.department === f.department));
    },
    async planWeek(_u, runId, plan) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].status === "planned") items.splice(i, 1);
      for (const p of plan) {
        items.push({ id: id(), run_id: runId, ...p, status: "planned", priority: "medium", body: {}, final_text: null, external_url: null, decided_at: null, published_at: null, created_at: new Date().toISOString() });
      }
      return plan.length;
    },
    async saveDraft(_u, runId, itemId, idea, body, priority) {
      let item = itemId ? items.find((i) => i.id === itemId) : undefined;
      if (!item) {
        item = { id: id(), run_id: runId, department: "post", platform: "x", day: isoDay(), idea, reason: "", status: "planned", priority, body: {}, final_text: null, external_url: null, decided_at: null, published_at: null, created_at: new Date().toISOString() };
        items.push(item);
      }
      Object.assign(item, { status: "in_review", body, priority, run_id: runId });
      return item;
    },
    seenUrls: async () => new Set(opps.map((o) => o.url)),
    subredditRule: async (name) => rules.get(name.toLowerCase()) ?? null,
    async saveSubredditRule(rule) {
      rules.set(rule.subreddit.toLowerCase(), { ...rule, subreddit: rule.subreddit.toLowerCase(), read_at: new Date().toISOString() });
    },
    salesSettings: async () => salesSettings,
    recentMentions: async () => mentions.used,
    // Saved threads here are never decided, so every mention draft still waits.
    waitingMentions: async () => opps.filter((o) => o.rule === "mention_ok").length,
    async saveOpportunities(_u, _r, list) {
      const fresh = list.filter((o) => !opps.some((x) => x.url === o.url));
      opps.push(...fresh);
      return fresh.length;
    },
    async defer(run, seconds, steps) {
      const r = runs.find((x) => x.id === run.id)!;
      if (r.attempt !== run.attempt || r.status !== "running") return false;
      Object.assign(r, { status: "queued", attempt: Math.max(0, r.attempt - 1), notBefore: Date.now() + seconds * 1000, steps: steps.map((s) => ({ ...s })) });
      return true;
    },
    async saveInsight(_u, _run, body) {
      insights.push(body);
    },
    latestInsight: async () => insights.at(-1) ?? null,
    async saveNicheInsight(_u, _run, body) {
      niche.push(body);
    },
    latestNicheInsight: async () => niche.at(-1) ?? null,
    async saveMetrics(_u, rows) {
      const ok = rows.filter(
        (row) =>
          (row.source === "zernio" && zernio.posts.some((p) => p.item_id === row.item_id)) ||
          (row.source !== "zernio" && items.some((i) => i.id === row.item_id && i.status === "published")),
      );
      metrics.push(...ok);
      return ok.length;
    },
    zernioPosts: async (_u, since) => zernio.posts.filter((p) => p.published_at >= since),
    connectedAccounts: async () => ({ zernioProfileId: zernio.profileId, accounts: zernio.profileId ? zernio.accounts : [] }),
    async saveAccountMetrics(_u, rows) {
      const ok = rows.filter((r) => zernio.accounts.some((a) => a.id === r.social_account_id));
      for (const r of ok) {
        const i = zernio.days.findIndex((d) => d.social_account_id === r.social_account_id && d.day === r.day);
        if (i >= 0) zernio.days[i] = r;
        else zernio.days.push(r);
      }
      return ok.length;
    },
    refreshBestSlots: async () => 0,
    replyOutcomesDue: async (_u, limit) => replies.filter((r) => !r.check).slice(0, limit),
    async saveReplyOutcome(_u, outcomeId, check) {
      const row = replies.find((r) => r.outcome_id === outcomeId && !r.check);
      if (!row) return false;
      row.check = check;
      return true;
    },
    inbox: async (_u, inboxId) => {
      const item = inbox.find((i) => i.id === inboxId);
      return item ? { answers: { ...item.answers }, memo: { ...item.memo } } : null;
    },
    async openInbox(run, step, request, memo) {
      const r = runs.find((x) => x.id === run.id)!;
      if (r.attempt !== run.attempt || r.status !== "running") return null;
      const inboxId = typeof run.input.inbox === "string" ? run.input.inbox : null;
      let item = inboxId ? inbox.find((i) => i.id === inboxId) : undefined;
      if (!item) {
        const { brain: _brain, ...input } = run.input;
        item = { id: id(), kind: run.kind, input, step, request, answers: {}, memo: {}, status: "open", feedback: null, rounds: 0 };
        inbox.push(item);
      }
      Object.assign(item, { step, request, memo: { ...item.memo, ...memo }, status: "open", feedback: null });
      Object.assign(r, { status: "done", output: { inbox_id: item.id, waiting_for: step }, error: null });
      return item.id;
    },
    async finishInbox(run, ok, feedback) {
      const item = inbox.find((i) => i.id === run.input.inbox);
      if (!item || item.status !== "submitted") return;
      if (ok) Object.assign(item, { status: "done", feedback: null });
      else {
        delete item.answers[item.step];
        Object.assign(item, { status: "open", feedback });
      }
    },
  };
  /** What `inbox_submit` does: stores the answer and queues the replay. */
  const submit = (inboxId: string, step: string, answer: unknown) => {
    const item = inbox.find((i) => i.id === inboxId);
    if (!item || item.status !== "open" || item.step !== step) throw new Error(`inbox ${inboxId} is not waiting for ${step}`);
    item.answers[step] = answer;
    item.status = "submitted";
    item.rounds += 1;
    return enqueue(item.kind, { ...item.input, brain: "claude", inbox: item.id });
  };
  const enqueue = (kind: QueuedRun["kind"], input: Record<string, unknown> = {}) => {
    const run: RunState = { id: id(), user_id: "u1", kind, input, attempt: 0, status: "queued", steps: [], error: null, output: null };
    runs.push(run);
    return run;
  };
  return { store, runs, items, opps, rules, salesSettings, mentions, insights, niche, metrics, zernio, replies, lessons, goals, results, enqueue, inbox, submit, voice, videos, captions };
}
