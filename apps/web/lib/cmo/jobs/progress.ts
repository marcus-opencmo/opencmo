/**
 * The progress check (docs/architecture/brain.md §4, the progress ledger): once a day, code only, it reads the week's
 * order tree and says what is done, stuck, over budget or waiting on the founder. A stuck order gets one replan
 * through the Planner, never a loop; everything else costs nothing.
 *
 * Pure: `jobs.check.ts` runs it on sample trees. The cron calls `progress-run.ts`, which reads and writes.
 */

export type OrderLedgerRow = {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  department: string;
  status: "queued" | "running" | "waiting_founder" | "waiting_order" | "deferred" | "done" | "failed" | "cancelled";
  due_at: string | null;
  budget_credits: number;
  spent_credits: number;
  updated_at: string;
  brief: Record<string, unknown>;
  error: { code?: string; message?: string } | null;
};

/**
 * What each order kind costs, the same table as `cmo_job_price` in SQL (pgTAP `203_work_orders` pins both). An order
 * that needs credits and was given none is over budget. `build_video` is `studio_video_budget()`: what a video order
 * budgets before its cards price it (P2 A2).
 */
export const JOB_PRICES: Readonly<Record<string, number>> = { plan_week: 1, post_draft: 1, sales_scan: 5, competitor_research: 2, niche_video_research: 2, build_video: 60 };

export type Verdict = "done" | "on_track" | "waiting_founder" | "over_budget" | "stuck";

const HOUR = 3_600_000;
/** A run holds a 5-minute lease and steps renew it; an order running this long has lost its run. */
const RUNNING_STUCK_MS = 2 * HOUR;
const DEFERRED_STUCK_MS = 24 * HOUR;
/** Past its due time by this much with nothing started. */
const LATE_MS = 24 * HOUR;

/** Kinds the Planner can plan around (calendar items). Other kinds are retried by their own loop. */
export const REPLANNABLE: ReadonlySet<string> = new Set(["post_draft", "sales_scan"]);

/**
 * One order's state. `price` is what the order's kind costs (`cmo_job_price`); an order that needs credits and was
 * given none is over budget, the case the weekly budget runs out mid-plan.
 */
export function classifyOrder(order: OrderLedgerRow, now: Date, price = 0): Verdict {
  const age = now.getTime() - new Date(order.updated_at).getTime();
  const late = order.due_at !== null && now.getTime() - new Date(order.due_at).getTime() > LATE_MS;
  switch (order.status) {
    case "done":
    case "cancelled":
      return "done";
    case "failed":
      return "stuck";
    case "waiting_founder":
      return "waiting_founder";
    case "running":
      return age > RUNNING_STUCK_MS ? "stuck" : "on_track";
    case "deferred":
      return age > DEFERRED_STUCK_MS ? "stuck" : "on_track";
    case "waiting_order":
      return late ? "stuck" : "on_track";
    case "queued":
      if (price > order.budget_credits - order.spent_credits) return "over_budget";
      return late ? "stuck" : "on_track";
  }
}

export type ProgressReport = {
  done: number;
  total: number;
  onTrack: OrderLedgerRow[];
  waitingFounder: OrderLedgerRow[];
  overBudget: OrderLedgerRow[];
  stuck: OrderLedgerRow[];
  /** The one order to replan today, or null: replannable, not replanned before, the most overdue first. */
  replan: OrderLedgerRow | null;
};

/** The week's ledger. The root (no parent) is the week itself, not an order to count. */
export function progressReport(orders: OrderLedgerRow[], now: Date, prices: Readonly<Record<string, number>> = JOB_PRICES): ProgressReport {
  const children = orders.filter((o) => o.parent_id !== null);
  const by = (v: Verdict) => children.filter((o) => classifyOrder(o, now, prices[o.kind] ?? 0) === v);
  const stuck = by("stuck");
  const replan =
    [...stuck]
      .filter((o) => REPLANNABLE.has(o.kind) && !("replanned_at" in o.brief) && !("replan_of" in o.brief))
      .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"))[0] ?? null;
  return {
    done: by("done").length,
    total: children.length,
    onTrack: by("on_track"),
    waitingFounder: by("waiting_founder"),
    overBudget: by("over_budget"),
    stuck,
    replan,
  };
}

/** Why an order is stuck, in the words the replan brief and the log use. */
export function stuckReason(order: OrderLedgerRow, now: Date): string {
  if (order.status === "failed") return order.error?.message ? `It failed: ${order.error.message}` : "It failed.";
  const hours = Math.round((now.getTime() - new Date(order.updated_at).getTime()) / HOUR);
  if (order.status === "running") return `It has been running for ${hours} hours without progress.`;
  if (order.status === "deferred") return `It has waited ${hours} hours to continue.`;
  return "It is a day past its due time and has not started.";
}

/** The brief the Planner gets for the one replan: what is stuck and why, and not to plan it again unchanged. */
export function replanBrief(order: OrderLedgerRow, now: Date): string {
  return `Replan: "${order.title}" is stuck. ${stuckReason(order, now)} Plan the rest of the week around it; do not plan the same item again unchanged.`.slice(0, 300);
}

/** When the daily check runs next: the Modal clock calls the CMO cron at 00:05 UTC. */
export function nextCheckAt(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
