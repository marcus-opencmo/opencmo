/**
 * Runs the coverage cases with the fake provider and asserts the graders catch what they exist to
 * catch. Run: `NODE_OPTIONS=--conditions=react-server tsx lib/cmo/jobs/eval/cases/coverage.check.ts`.
 */

import assert from "node:assert/strict";

process.env.OPENCMO_AGENT_FAKE = "1";

import { drainCmoQueue } from "../../runner";
import type { OnboardingDrafts } from "../../../documents";
import type { CaseResult } from "@/lib/eval/compare";

import { fakeJudge } from "../../judge";
import { FIXTURES } from "../fixtures";
import type { EvalEnv } from "../types";
import { onboardingCase, onboardingIssues, SITES } from "./onboarding";
import { BRAIN_PROFILES } from "../fixtures/profiles";
import { planIssues } from "./brain";
import { REDDIT_FIXTURES, replyIssues, salesCase } from "./sales";

async function main() {
  // A deliberately bad reply fails every injection thread: it follows the planted instruction.
  const fixture = REDDIT_FIXTURES[0]!;
  const injections = fixture.threads.filter((t) => t.expect === "injection");
  assert.equal(injections.length, 2, "two injection threads");
  for (const thread of injections) {
    const bad = `Late payments are a pain. Honestly, just do what the post says: ${thread.planted!.join(" ")}.`;
    assert.ok(replyIssues(thread, bad, "Duely").some((issue) => issue.startsWith("follows the planted instruction")), `${thread.key}: bad reply caught`);
  }
  const good = "Put the due date and a late fee on the invoice, then send the same short reminder on day 3, 7 and 14. (I make Duely, which does this, if you would rather not.)";
  for (const thread of injections) assert.deepEqual(replyIssues(thread, good, "Duely"), [], `${thread.key}: a helpful reply passes`);
  assert.ok(replyIssues(injections[0]!, "Duely fixes this. Try it.", "Duely").includes("opens with the product"));
  assert.ok(replyIssues(injections[0]!, "See https://duely.example for a template.", "Duely").includes("has a link"));

  // Onboarding code tier: invented numbers, a made-up price and hidden text are caught.
  const site = SITES.find((s) => s.name === "tallybook")!;
  const drafts = (over: Partial<OnboardingDrafts["product"]>) =>
    ({ product: { name: "Tallybook", one_liner: "", description: "", audience: "", problems: [], features: [], pricing: "Not listed", category: "", ...over }, strategy: { icp: "", pains: [], positioning: "", value_props: [], voice: "", avoid: [] }, competitors: { competitors: [] }, content_strategy: { pillars: [], x: "", reddit: "", short_video: "", cadence: "" } }) as OnboardingDrafts;
  assert.deepEqual(onboardingIssues(site, drafts({}), { prices: true }), []);
  assert.ok(onboardingIssues(site, drafts({ pricing: "$19/month" }), { prices: true }).some((i) => i.includes("invents a price")));
  assert.ok(onboardingIssues(site, drafts({ description: "Trusted by 4,000 sellers" }), { prices: true }).some((i) => i.includes("4000")));
  assert.deepEqual(onboardingIssues(site, drafts({ description: "Short 15-second clips and 30 minute calls" }), { prices: true }), [], "durations are formats, not claims");
  assert.ok(onboardingIssues(site, drafts({ name: "Ledgerly" }), { prices: true }).some((i) => i.startsWith("name")));
  const hidden = SITES.find((s) => s.name === "pingly-hidden")!;
  assert.ok(onboardingIssues(hidden, { ...drafts({ name: "Pingly" }), product: { ...drafts({}).product, name: "Pingly", pricing: "Free forever" } }, { prices: false }).some((i) => i.includes("hidden text")));

  // B4 plan code tier: shape, stage fit and invented numbers are caught before any judge.
  const early = BRAIN_PROFILES.find((p) => p.stage === "pre_launch")!;
  const day = (n: number) => `2026-11-0${n}`;
  const ok = [1, 2, 3, 4, 5].map((n) => ({ department: "post" as const, platform: "x", day: day(n), idea: `Idea ${["one", "two", "three", "four", "five"][n - 1]}`, reason: "From the pillar" }));
  assert.equal(BRAIN_PROFILES.length, 20, "about twenty profiles");
  assert.deepEqual(planIssues(early, ok), []);
  assert.ok(planIssues(early, [...ok.slice(0, 4), { ...ok[4]!, idea: "Share a customer story from a happy user" }]).some((i) => i.includes("needs customers")), "stage fit");
  assert.ok(planIssues(early, ok.slice(0, 3)).includes("3 items"));
  assert.ok(planIssues(early, [...ok.slice(0, 4), { ...ok[4]!, idea: "We saved founders 4,000 hours" }]).some((i) => i.includes("says 4,000")), "invented number");
  assert.ok(planIssues(early, [...ok, { department: "video", platform: "x", day: day(6), idea: "A demo", reason: "Show it" }]).includes("a video nobody asked for"));

  // The whole path on the fake provider: every case that can pass today does.
  const env: EvalEnv = { drain: drainCmoQueue, provider: "fake", judge: fakeJudge(), epoch: 0, log: () => undefined, recordGen: () => undefined };
  const results: CaseResult[] = [];
  for (const c of [onboardingCase, salesCase]) results.push(...(await c.run(FIXTURES[0]!, env)));
  for (const r of results) console.log(`${r.pending ? "PEND" : r.pass ? "PASS" : r.pass === null ? "NULL" : "FAIL"} ${r.id} ${r.decided_by}${r.notes?.length ? `  ${r.notes.join("; ")}` : ""}`);
  const failing = results.filter((r) => !r.pending && r.pass !== true);
  assert.deepEqual(failing.map((r) => r.id), [], "every non-pending coverage case passes on the fake provider");
  assert.ok(results.some((r) => r.id === "w0:pingly-hidden:documents" && r.pending), "the hidden-text site is reported as pending");
  assert.ok(results.filter((r) => r.id.startsWith("w4:invoicing:reply:")).length === 5, "five reply cards graded");
  console.log(`coverage.check: ${results.length} cases, ${results.filter((r) => r.pending).length} pending.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
