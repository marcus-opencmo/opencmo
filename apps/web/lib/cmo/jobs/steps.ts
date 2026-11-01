/**
 * Every model call a CMO job can send to the inbox, by its step label (`ThinkOptions.label`):
 * which job it belongs to, the zod schema its answer must meet, and the MCP tool that submits it.
 * The submit tools validate with these schemas before anything is stored; the replay validates
 * again with the same ones (`think.ts`).
 */

import type { z } from "zod";

import { POST_PROFILES } from "../platforms";
import { InsightSchema } from "./competitor-research";
import { DraftSchema, REVIEW_SYSTEM } from "./draft-post";
import { PlanSchema } from "./plan-week";
import { ReviewSchema } from "./review-week";
import { PASS_SCORE, QueriesSchema, ReplySchema, RulesSchema, ScoreSchema } from "./sales-scan";
import { ThreadDraftSchema } from "../writer/types";
import { LessonSchema } from "./summarize-memory";
import type { CmoJobKind } from "./types";

export type SubmitTool = "submit_plan" | "submit_post_draft" | "submit_sales_scan" | "submit_memory" | "submit_research";

export type InboxStep = { kind: CmoJobKind; schema: z.ZodType; submit: SubmitTool };

export const INBOX_STEPS = {
  plan_week: { kind: "plan_week", schema: PlanSchema, submit: "submit_plan" },
  review_week: { kind: "review_week", schema: ReviewSchema, submit: "submit_plan" },
  draft_post: { kind: "post_draft", schema: DraftSchema, submit: "submit_post_draft" },
  // An X thread asked for over MCP (`create_task` with thread: true): without this step the item had no submit tool.
  draft_thread: { kind: "post_draft", schema: ThreadDraftSchema, submit: "submit_post_draft" },
  make_queries: { kind: "sales_scan", schema: QueriesSchema, submit: "submit_sales_scan" },
  score_thread: { kind: "sales_scan", schema: ScoreSchema, submit: "submit_sales_scan" },
  check_rules: { kind: "sales_scan", schema: RulesSchema, submit: "submit_sales_scan" },
  draft_reply: { kind: "sales_scan", schema: ReplySchema, submit: "submit_sales_scan" },
  summarize_memory: { kind: "summarize_memory", schema: LessonSchema, submit: "submit_memory" },
  competitor_research: { kind: "competitor_research", schema: InsightSchema, submit: "submit_research" },
} satisfies Record<string, InboxStep>;

export type InboxStepName = keyof typeof INBOX_STEPS;
export const INBOX_STEP_NAMES = Object.keys(INBOX_STEPS) as InboxStepName[];

export const isInboxStep = (step: string): step is InboxStepName => Object.hasOwn(INBOX_STEPS, step);

/** Steps a submit tool accepts. */
export const stepsFor = (tool: SubmitTool): InboxStepName[] => INBOX_STEP_NAMES.filter((step) => INBOX_STEPS[step].submit === tool);

/** The answer checked against its step's schema: the data, or one English sentence for Claude. */
export function parseAnswer(step: InboxStepName, answer: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const parsed = INBOX_STEPS[step].schema.safeParse(answer);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`);
  return { ok: false, error: `The answer does not match the schema of step "${step}" (${issues.join("; ")}). Read the item's schema again.` };
}

/**
 * What a draft must pass before the founder sees it. In the app a separate checker model reads
 * the drafts; over MCP Claude reviews its own draft against this, and the server's code checks
 * (length, words to avoid, numbers that are not in the documents) stay the last gate.
 */
export function checkRubric(kind: CmoJobKind): string {
  const shared = [
    "Use only facts and numbers from the founder's documents. Never invent customers, results, numbers or personal experiences.",
    "Respect the brand voice and the words to avoid in the strategy.",
    "Nothing is posted by OpenCMO: every draft becomes a card the founder approves and posts themselves.",
  ];
  switch (kind) {
    case "post_draft":
      return [
        REVIEW_SYSTEM,
        "",
        "Code checks after you submit (a version that fails one is dropped; if all fail, the item comes back with the reasons):",
        `- Within the platform's limit (the <platform> block says which): ${POST_PROFILES.map((p) => `${p.label} ${p.limit}`).join(", ")} characters.`,
        "- None of the strategy's words to avoid.",
        "- Any number of 10 or more, and any percentage, must appear in the documents (years are fine).",
        "- No links and no hashtags.",
        "",
        ...shared.map((line) => `- ${line}`),
      ].join("\n");
    case "sales_scan":
      return [
        `A thread becomes a card only when its score reaches ${PASS_SCORE} of 100. Pain (0-25) and Evidence (0-15) count only with a quote copied exactly from the thread; the server checks every quote. Timing and Reach are computed by the server.`,
        "Replies: help first, with advice the person can use without buying anything; mention the product at most once, at the end, saying plainly it is the founder's own; no links, no hype, under 120 words.",
        "Exclude health, medical, personal finance or legal advice, off-topic threads, and vendors promoting their own product.",
        ...shared,
      ].join("\n");
    default:
      return shared.join("\n");
  }
}
