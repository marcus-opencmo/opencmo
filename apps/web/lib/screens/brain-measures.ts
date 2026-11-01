/**
 * The brain's measures (`brain.md` §10; P6 A4, F11) from one week's rows and the week before. Pure, so a check runs
 * it. A measure with nothing to count this week is null (a dash), and its change is null when either week is empty.
 */

import type { Measure } from "./brain";

/** One week's raw counts; every field comes from rows of that week (Monday to Sunday, the founder's week). */
export type WeekCounts = {
  /** Plan (goal) cards decided: approved as is, and all decided. */
  plans: { asIs: number; decided: number };
  /** Draft outcomes with a similarity: approved at ≥ 0.95, and all. */
  drafts: { asIs: number; total: number };
  /** Orders with a due time that are done or past it: done by then, and all. */
  orders: { onTime: number; due: number };
  /** Credits spent by the week's orders, and cards approved (as is or edited) that week. */
  credits: { spent: number; approved: number };
  /** Orders the daily check replanned. */
  replans: number;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const diff = (a: number | null, b: number | null, round: (n: number) => number) => (a === null || b === null ? null : round(a - b));

export function buildMeasures(week: WeekCounts, last: WeekCounts): Measure[] {
  const plan = pct(week.plans.asIs, week.plans.decided);
  const drafts = pct(week.drafts.asIs, week.drafts.total);
  const onTime = pct(week.orders.onTime, week.orders.due);
  const perApproved = (w: WeekCounts) => (w.credits.approved > 0 ? round1(w.credits.spent / w.credits.approved) : null);
  const credits = perApproved(week);
  const anything = (w: WeekCounts) => w.plans.decided + w.drafts.total + w.orders.due + w.credits.approved + w.replans > 0;
  const replans = anything(week) ? week.replans : null;
  return [
    {
      key: "plan_accepted",
      value: plan,
      unit: "percent",
      change: diff(plan, pct(last.plans.asIs, last.plans.decided), Math.round),
      target: "Half of plans",
      note: week.plans.decided ? `${week.plans.asIs} of ${week.plans.decided} plans` : null,
    },
    {
      key: "drafts_as_is",
      value: drafts,
      unit: "percent",
      change: diff(drafts, pct(last.drafts.asIs, last.drafts.total), Math.round),
      target: "Rising week over week",
      note: week.drafts.total ? `${week.drafts.asIs} of ${week.drafts.total} drafts` : null,
    },
    {
      key: "orders_on_time",
      value: onTime,
      unit: "percent",
      change: diff(onTime, pct(last.orders.onTime, last.orders.due), Math.round),
      target: "Most",
      note: week.orders.due ? `${week.orders.onTime} of ${week.orders.due} orders` : null,
    },
    {
      key: "credits_per_approved",
      value: credits,
      unit: "credits",
      change: diff(credits, perApproved(last), round1),
      target: "Falling week over week",
      note: week.credits.approved ? `${week.credits.approved} approved, ${week.credits.spent} credits` : null,
    },
    {
      key: "replans",
      value: replans,
      unit: "count",
      change: replans === null || !anything(last) ? null : replans - last.replans,
      target: "Few",
      note: null,
    },
  ];
}
