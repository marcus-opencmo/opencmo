/**
 * Case shapes for the Studio squad evals and the brain's plan eval (P6 B0; `studio.md` §10,
 * `brain.md` §10). The cases themselves live in `eval/cases/studio.ts` and `eval/cases/brain.ts` and
 * register through `registerCases` like every other case file.
 *
 * Every case is reproducible: fixed inputs in `eval/fixtures/`, judge questions written here as
 * constants (they go into the report verbatim), no live network.
 */

import type { LookResult } from "@/lib/departments/studio/look-check";

import type { Documents } from "../types";

/** The three Studio squads that raise a video-like card. */
export const EVAL_SQUADS = ["long_take", "shorts", "slideshow"] as const;
export type EvalSquad = (typeof EVAL_SQUADS)[number];

/**
 * One squad case: a brief in, the squad's output, code checks first, then yes/no judge questions on the
 * cascade (`jobs/judge.ts` `cascade`). `look` is the output's look check result when the squad renders.
 */
export type SquadEvalCase<Brief = unknown, Output = unknown> = {
  id: string;
  squad: EvalSquad;
  brief: Brief;
  /** Code-only checks: each returns the problems found, empty when the output is fine. */
  checks: ((output: Output) => string[])[];
  /** Asked one by one to the judge, word for word; any "no" fails. Recorded in the report. */
  judgeQuestions: readonly string[];
};

/** What a squad case reports beyond pass/fail (`studio.md` §10). */
export type SquadEvalMeasures = {
  squad: EvalSquad;
  /** Judge said `post_as_is`: the share the founder would approve without changes. */
  approvedAsIs: boolean | null;
  /** The squad's own reviewer sent the work back (one revision used). */
  redone: boolean;
  look?: Pick<LookResult, "pass" | "round">;
};

/** Where a founder's business is. The plan has to fit it (`brain.md` §9 "Stage fit"). */
export const BRAIN_STAGES = ["pre_launch", "launched_no_users", "first_users", "growing"] as const;
export type BrainStage = (typeof BRAIN_STAGES)[number];

/**
 * One brain profile: a fixed founder (documents as onboarding writes them), where they are, and the goal
 * for the week. About 20 of them, written by hand from real product shapes; no invented metrics.
 */
export type BrainEvalProfile = {
  name: string;
  stage: BrainStage;
  goal: string;
  docs: Documents;
  /** The brief the founder typed for the week, if any (asks for a video, a launch…). */
  brief?: string;
};

/**
 * The plan judge's questions (`brain.md` §10: goal fit, mix, stage fit, feasibility). Asked one by one
 * after the code checks pass; any "no" fails. Changing a word here changes the eval: bump
 * `PLAN_JUDGE_VERSION` so a comparison across runs is not silently mixed.
 */
export const PLAN_JUDGE_QUESTIONS = [
  "Goal fit: most items move the founder's stated goal for this week forward.",
  "Mix: the week uses more than one department or angle where the goal allows, and no day is crowded with near-duplicate posts.",
  "Stage fit: nothing asks for things the business does not have yet at its stage (customers to quote, metrics, a launch that already happened).",
  "Feasibility: a solo founder can approve and publish this week without making new assets the plan does not provide.",
] as const;
export const PLAN_JUDGE_VERSION = "plan-judge-1";
