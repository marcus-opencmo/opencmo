/**
 * B4 brain plan eval (P6, `brain.md` §10): twenty fixed founders (`fixtures/profiles.ts`), each with an
 * approved goal for the week, through the real `plan_week` job; the plan is graded on the cascade.
 *
 * Code tier (final when it fails): the plan's shape as W1 checks it (5–10 items, one Reddit item a day at
 * most, video only when the strategy or brief asks), every item has a reason, no avoid words or invented
 * numbers, and stage fit: an early business is never asked to quote customers, results or reviews.
 * Judge tier (`plan-judge.ts`): would the founder accept the card, then goal fit, mix, stage fit and
 * feasibility, one question at a time. The judge's questions are in the report under `plan-judge`.
 */

import type { ProviderKind } from "@/lib/cmo/agents/registry";
import type { CaseResult } from "@/lib/eval/compare";

import { cascade } from "../../judge";
import { memoryStore } from "../../memory-store";
import { mondayOf } from "../../summarize-memory";
import type { PlanItem } from "../../types";
import { ideaIssues } from "../core";
import { BRAIN_PROFILES } from "../fixtures/profiles";
import { fakePlanJudge, planJudge, planText } from "../plan-judge";
import type { BrainEvalProfile, BrainStage } from "../studio-types";
import { PLAN_JUDGE_QUESTIONS, PLAN_JUDGE_VERSION } from "../studio-types";
import { registerCases, type EvalCase, type EvalEnv } from "../types";

const BUDGET_MS = 240_000;
const EARLY: ReadonlySet<BrainStage> = new Set(["pre_launch", "launched_no_users"]);
/** What an early business does not have yet: asking for it makes the plan undoable. */
const NEEDS_CUSTOMERS = /\b(testimonial|case stud(y|ies)|customer (story|stories|quote|review)s?|reviews? from|our (customers|users) (say|love)|results? (from|of) (our )?(customers|users))\b/i;

const mentionsVideo = (p: BrainEvalProfile) => /video|clip|record|reel|short|tiktok/i.test(`${JSON.stringify(p.docs.content_strategy ?? {})} ${p.brief ?? ""} ${p.goal}`);

/** Code-tier problems with one plan; empty when it passes. */
export function planIssues(profile: BrainEvalProfile, plan: readonly PlanItem[]): string[] {
  const issues: string[] = [];
  if (plan.length < 5 || plan.length > 10) issues.push(`${plan.length} items`);
  const salesPerDay = new Map<string, number>();
  for (const item of plan) if (item.department === "sales") salesPerDay.set(item.day, (salesPerDay.get(item.day) ?? 0) + 1);
  if ([...salesPerDay.values()].some((n) => n > 1)) issues.push("more than one Reddit item on a day");
  if (!mentionsVideo(profile) && plan.some((i) => i.department === "video")) issues.push("a video nobody asked for");
  plan.forEach((item, index) => {
    if (!item.reason.trim()) issues.push(`item ${index + 1}: no reason`);
    for (const issue of ideaIssues(item.idea, item.reason, profile.docs)) issues.push(`item ${index + 1}: ${issue}`);
    if (EARLY.has(profile.stage) && NEEDS_CUSTOMERS.test(`${item.idea} ${item.reason}`)) issues.push(`item ${index + 1}: needs customers the business does not have yet`);
  });
  return issues;
}

async function runProfile(profile: BrainEvalProfile, env: EvalEnv): Promise<CaseResult[]> {
  const id = (output: string) => `b4:${profile.name}:${output}`;
  const mem = memoryStore(profile.docs, []);
  mem.goals.push({ id: `goal-${profile.name}`, week: mondayOf(), goal: profile.goal, metric: "posts", target: 5, status: "approved", result: null });
  const run = mem.enqueue("plan_week", profile.brief ? { brief: profile.brief } : {});
  await env.drain(mem.store, { runId: run.id, budgetMs: BUDGET_MS });
  const state = mem.runs.find((r) => r.id === run.id);
  if (state?.status !== "done") return [{ id: id("run"), epoch: env.epoch, pass: false, decided_by: "error", notes: [state?.error ?? "the plan did not finish"] }];
  const plan = mem.items.filter((i) => i.run_id === run.id) as unknown as PlanItem[];
  const text = planText(plan);
  if (env.provider !== "fake") env.log(`${profile.name} (${profile.stage}, goal: ${profile.goal})\n${text}`);
  const judge = env.provider === "fake" ? fakePlanJudge() : planJudge({ drafter: env.provider as ProviderKind });
  return [
    { id: id("run"), epoch: env.epoch, pass: true, decided_by: "code" },
    await cascade(id("plan"), env.epoch, planIssues(profile, plan), judge, { job: profile.goal, docs: profile.docs, output: text, criteria: [...PLAN_JUDGE_QUESTIONS] }),
  ];
}

export const brainCase: EvalCase = {
  job: "b4",
  once: true,
  async run(_fixture, env) {
    // The judge's wording is part of the eval: a change shows up as a new version in the report.
    env.recordGen("plan-judge", { prompt_version: PLAN_JUDGE_VERSION });
    const results: CaseResult[] = [];
    for (const profile of BRAIN_PROFILES) results.push(...(await runProfile(profile, env)));
    const judged = results.filter((r) => r.id.endsWith(":plan") && r.decided_by === "judge");
    if (judged.length && env.provider !== "fake") {
      const asIs = judged.filter((r) => r.verdict === "accept_as_is").length;
      env.log(`b4: plans accepted as is ${asIs}/${judged.length}, passing ${judged.filter((r) => r.pass).length}/${judged.length}`);
    }
    return results;
  },
};

registerCases([brainCase]);
