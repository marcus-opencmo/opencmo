/**
 * The progress check's classifier and the digest template (brain plan W1-4):
 *
 *     cd apps/web && npx tsx lib/cmo/jobs/progress.check.ts
 */
import assert from "node:assert/strict";

import { buildDigest, localClock } from "../digest";

import { readAll } from "./progress-run";
import { classifyOrder, nextCheckAt, progressReport, replanBrief, type OrderLedgerRow } from "./progress";

const NOW = new Date("2026-10-29T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const order = (over: Partial<OrderLedgerRow>): OrderLedgerRow => ({
  id: "o",
  parent_id: "root",
  kind: "post_draft",
  title: "Cut by words",
  department: "writer",
  status: "queued",
  due_at: null,
  budget_credits: 1,
  spent_credits: 0,
  updated_at: hoursAgo(1),
  brief: {},
  error: null,
  ...over,
});

// One order at a time.
assert.equal(classifyOrder(order({ status: "done" }), NOW), "done");
assert.equal(classifyOrder(order({ status: "cancelled" }), NOW), "done", "a cancelled order is no longer open");
assert.equal(classifyOrder(order({ status: "failed" }), NOW), "stuck");
assert.equal(classifyOrder(order({ status: "waiting_founder", updated_at: hoursAgo(72) }), NOW), "waiting_founder", "a card waiting is never stuck");
assert.equal(classifyOrder(order({ status: "running", updated_at: hoursAgo(1) }), NOW), "on_track");
assert.equal(classifyOrder(order({ status: "running", updated_at: hoursAgo(3) }), NOW), "stuck", "running for hours has lost its run");
assert.equal(classifyOrder(order({ status: "deferred", updated_at: hoursAgo(30) }), NOW), "stuck");
assert.equal(classifyOrder(order({ due_at: hoursAgo(30) }), NOW), "stuck", "a day past due and not started");
assert.equal(classifyOrder(order({ due_at: hoursAgo(2) }), NOW), "on_track", "a few hours late is still on track");
assert.equal(classifyOrder(order({ kind: "sales_scan", budget_credits: 0 }), NOW, 5), "over_budget", "planned past the weekly budget");
assert.equal(classifyOrder(order({ kind: "review_week", budget_credits: 0 }), NOW, 0), "on_track", "a free order needs no budget");

// The week: one replan, never a loop.
const tree: OrderLedgerRow[] = [
  order({ id: "root", parent_id: null, kind: "plan_week", status: "running" }),
  order({ id: "a", status: "failed", due_at: hoursAgo(20), error: { code: "run_failed", message: "The model did not answer." } }),
  order({ id: "b", status: "running", updated_at: hoursAgo(5), due_at: hoursAgo(40) }),
  order({ id: "c", kind: "pull_metrics", status: "failed" }),
  order({ id: "d", status: "failed", brief: { replanned_at: hoursAgo(24) } }),
  order({ id: "e", status: "waiting_founder" }),
  order({ id: "f", status: "done" }),
];
const report = progressReport(tree, NOW, { post_draft: 1 });
assert.equal(report.total, 6, "the root is the week, not an order");
assert.deepEqual(report.stuck.map((o) => o.id).sort(), ["a", "b", "c", "d"]);
assert.equal(report.replan?.id, "b", "the most overdue replannable order");
assert.equal(progressReport(tree.filter((o) => o.id !== "b"), NOW).replan?.id, "a");
assert.equal(progressReport([tree[0]!, tree[3]!, tree[4]!], NOW).replan, null, "a metrics run is not replanned; a replanned order never again");
assert.equal(progressReport([order({ status: "failed", brief: { replan_of: "x" } })], NOW).replan, null, "a replan's order is not replanned");
assert.match(replanBrief(tree[1]!, NOW), /^Replan: "Cut by words" is stuck\. It failed: The model did not answer\./);
assert.ok(replanBrief(order({ title: "x".repeat(400) }), NOW).length <= 300, "the brief fits the run input");
assert.equal(nextCheckAt(NOW).toISOString(), "2026-10-30T00:05:00.000Z");
assert.equal(nextCheckAt(new Date("2026-10-29T00:01:00Z")).toISOString(), "2026-10-29T00:05:00.000Z");

// The digest: links open cards, nothing decides, text is escaped.
const digest = buildDigest({
  appUrl: "https://opencmo.io/",
  dateLabel: "Thursday 29 Oct",
  waiting: [{ id: "card-1", title: "Most AI video tools <stop>", department: "writer" }],
  wentOut: [{ title: "Cut by words", where: "X" }],
  stuck: [{ title: "2 Reddit replies", department: "sales", reason: "Over budget." }],
});
assert.equal(digest.subject, "1 thing waits on you · Thursday 29 Oct");
const links = digest.text.match(/https?:\/\/\S+/g) ?? [];
assert.ok(
  links.some((link) => {
    const url = new URL(link);
    return url.origin === "https://opencmo.io" && url.pathname === "/app/inbox/card-1";
  }),
  "links open the card",
);
assert.ok(digest.html.includes("&lt;stop&gt;") && !digest.html.includes("<stop>"), "titles are escaped");
assert.ok(!/approve/i.test(digest.html.replace("until you approve it", "")), "no approve button in an email");
assert.equal(buildDigest({ appUrl: "x", dateLabel: "d", waiting: [], wentOut: [], stuck: [] }).empty, true);
assert.deepEqual(localClock(new Date("2026-10-29T00:30:00Z"), "Asia/Ho_Chi_Minh"), { hour: 7, dateLabel: "Thursday 29 Oct" });
assert.equal(localClock(new Date("2026-10-29T00:30:00Z"), "Not/AZone").hour, 0, "an unknown zone falls back to UTC");

// Paging: every row, pages never overlap (review item 7).
async function paging(): Promise<void> {
  const all = Array.from({ length: 2500 }, (_, i) => i);
  const calls: [number, number][] = [];
  const read = await readAll<number>(async (from, to) => {
    calls.push([from, to]);
    return { data: all.slice(from, to + 1), error: null };
  });
  assert.equal(read.length, 2500, "no row past a page is skipped");
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
}

void paging().then(
  () => console.log("progress.check: classifier, one replan per order, digest template ok"),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
