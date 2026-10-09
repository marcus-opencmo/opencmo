/**
 * An in-memory `CmoStore` for checks and evals: the same job code runs against it without
 * Supabase. Not `server-only`, so `tsx` scripts can import it.
 */

import { isoDay, type ClipJob, type CmoStore, type CompetitorInsight, type MetricRow, type Documents, type ItemRow, type Opportunity, type PlatformCaptions, type QueuedRun, type Step } from "./types";

export type RunState = QueuedRun & { status: string; steps: Step[]; error: string | null; output: unknown; notBefore?: number };

export function memoryStore(docs: Documents, memories: string[] = ["Skipped the X post \"Pricing\": too salesy"]) {
  const runs: RunState[] = [];
  const items: ItemRow[] = [];
  const opps: Opportunity[] = [];
  const jobs = new Map<string, ClipJob>();
  const packs: Array<{ id: string; runId: string; jobId: string; clips: unknown[]; captions: Record<string, PlatformCaptions> }> = [];
  const insights: CompetitorInsight[] = [];
  const metrics: MetricRow[] = [];
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
    async saveOpportunities(_u, _r, list) {
      const fresh = list.filter((o) => !opps.some((x) => x.url === o.url));
      opps.push(...fresh);
      return fresh.length;
    },
    clipJob: async (_u, jobId) => jobs.get(jobId) ?? null,
    async saveVideoPack(_u, runId, jobId, clips, captions) {
      const pack = { id: id(), runId, jobId, clips, captions };
      packs.push(pack);
      return pack.id;
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
    async saveMetrics(_u, rows) {
      const ok = rows.filter((row) => items.some((i) => i.id === row.item_id && i.status === "published"));
      metrics.push(...ok);
      return ok.length;
    },
  };
  const enqueue = (kind: QueuedRun["kind"], input: Record<string, unknown> = {}) => {
    const run: RunState = { id: id(), user_id: "u1", kind, input, attempt: 0, status: "queued", steps: [], error: null, output: null };
    runs.push(run);
    return run;
  };
  return { store, runs, items, opps, jobs, packs, insights, metrics, enqueue };
}
