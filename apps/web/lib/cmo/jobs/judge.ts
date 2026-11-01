/**
 * The cascade judge for CMO outputs in evals. Code checks run first and are final when they fail:
 * a rule break needs no model to call it a fail, and it costs nothing. Only outputs that pass the
 * code reach the model judge, which:
 *
 * - runs as `checker` on the provider that did NOT draft (`prefer`), so a model does not grade its
 *   own provider's writing;
 * - predicts what the founder would do with the draft (`post_as_is | small_edit | rewrite | skip`),
 *   reasons before the label so the label follows from them;
 * - then asks each binary criterion on its own, which agrees with people more than one rubric
 *   score does;
 * - never turns its own failure into a fail: an error, a timeout or a label we do not know is
 *   `pass: null` (unscored), which the comparison leaves out.
 *
 * Eval only: the judge's cost is internal and never charged to a user.
 */

import { z } from "zod";

import { otherProvider, type ProviderKind } from "@/lib/cmo/agents/registry";
import type { CaseResult } from "@/lib/eval/compare";
import { usageUsd } from "@/lib/eval/prices";

import { structured, type StructuredOptions } from "./llm";
import type { Documents } from "./types";

export const JUDGE_VERDICTS = ["post_as_is", "small_edit", "rewrite", "skip"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];
const PASSING: ReadonlySet<string> = new Set<JudgeVerdict>(["post_as_is", "small_edit"]);

export type JudgeInput = { job: string; docs: Documents; output: string; criteria?: string[] };
export type JudgeResult = { pass: boolean | null; verdict?: string; reasons?: string; cost_usd?: number };
export type Judge = (input: JudgeInput) => Promise<JudgeResult>;

/** Asked one at a time when `criteria` is not given. Specific to what our founders complain about. */
export const DEFAULT_CRITERIA = [
  "It is specific to this product: a different company could not post it unchanged.",
  "It sounds like the founder talking, not like a marketer or an ad.",
  "Every claim in it (numbers, features, prices, results, customers) is stated in the documents.",
];

const SYSTEM = `You review drafts that an AI marketing assistant wrote for a solo founder. The founder reads each draft and either posts it as is, makes a small edit, rewrites it, or skips it. You predict which, from the founder's documents and the draft alone.

Rules:
- The documents are the only facts. A claim that is not in them is unsupported, even if it sounds plausible.
- Judge the draft as the founder would: their product, their voice, their audience.
- Give your reasons first, then the answer. Be brief.`;

const VerdictSchema = z.object({ reasons: z.string(), verdict: z.enum(JUDGE_VERDICTS) });
const CriterionSchema = z.object({ reasons: z.string(), met: z.boolean() });

type Call = <S extends z.ZodType>(opts: StructuredOptions<S>) => Promise<z.infer<S>>;

const brief = (input: JudgeInput) =>
  `<documents>\n${JSON.stringify(input.docs, null, 1)}\n</documents>\n\n<task>${input.job}</task>\n\n<draft>\n${input.output}\n</draft>`;

/**
 * A model judge. `drafter` is the provider that wrote the outputs; the judge prefers the other
 * one and falls back to the same provider (separate context) only when the other has no key.
 * `call` is `structured` in production of the eval and a stub in tests.
 */
export function modelJudge(opts: { drafter: ProviderKind; call?: Call; timeoutMs?: number }): Judge {
  const call: Call = opts.call ?? structured;
  const prefer: ProviderKind = otherProvider(opts.drafter);
  return async (input) => {
    let cost = 0;
    const ask = <S extends z.ZodType>(label: string, prompt: string, schema: S) =>
      call({
        agent: "checker",
        prefer,
        system: SYSTEM,
        prompt,
        schema,
        maxTokens: 1500,
        label,
        failure: "The eval judge failed.",
        timeoutMs: opts.timeoutMs ?? 60_000,
        onUsage: (usage) => {
          cost += usageUsd(usage);
        },
      });
    const unscored = (reasons: string, verdict?: string): JudgeResult => ({ pass: null, reasons, cost_usd: cost, ...(verdict ? { verdict } : {}) });

    let answer: { reasons: string; verdict: string };
    try {
      answer = await ask("eval_judge", `${brief(input)}\n\nWhat will the founder do with this draft: post_as_is, small_edit, rewrite or skip?`, VerdictSchema);
    } catch (error) {
      return unscored(`judge error: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The schema should rule this out; a stub, a provider ignoring the schema or a renamed label must
    // not read as a pass or a fail.
    if (!(JUDGE_VERDICTS as readonly string[]).includes(answer.verdict)) return unscored(`unknown label "${answer.verdict}"`, answer.verdict);
    if (!PASSING.has(answer.verdict)) return { pass: false, verdict: answer.verdict, reasons: answer.reasons, cost_usd: cost };

    for (const criterion of input.criteria ?? DEFAULT_CRITERIA) {
      let met: { reasons: string; met: boolean };
      try {
        met = await ask("eval_judge_criterion", `${brief(input)}\n\nIs this true of the draft? "${criterion}"`, CriterionSchema);
      } catch (error) {
        return unscored(`judge error on "${criterion}": ${error instanceof Error ? error.message : String(error)}`, answer.verdict);
      }
      if (typeof met.met !== "boolean") return unscored(`no answer on "${criterion}"`, answer.verdict);
      if (!met.met) return { pass: false, verdict: answer.verdict, reasons: `${criterion} — ${met.reasons}`, cost_usd: cost };
    }
    return { pass: true, verdict: answer.verdict, reasons: answer.reasons, cost_usd: cost };
  };
}

/**
 * The fake provider's judge: the same path as `modelJudge` (prompt, parsing, criteria loop) with
 * fixed answers, so a CI run exercises everything but the network.
 */
export function fakeJudge(): Judge {
  const call: Call = async (opts) =>
    (opts.schema === (VerdictSchema as z.ZodType) ? { reasons: "fake judge", verdict: "small_edit" } : { reasons: "fake judge", met: true }) as never;
  return modelJudge({ drafter: "anthropic", call });
}

/**
 * One graded output: code issues decide alone (`decided_by: "code"`), otherwise the judge does.
 * `judge: null` keeps a case code-only (W1's plan shape).
 */
export async function cascade(id: string, epoch: number, issues: string[], judge: Judge | null, input: JudgeInput): Promise<CaseResult> {
  if (issues.length) return { id, epoch, pass: false, decided_by: "code", notes: issues };
  if (!judge) return { id, epoch, pass: true, decided_by: "code" };
  let judged: JudgeResult;
  try {
    judged = await judge(input);
  } catch (error) {
    return { id, epoch, pass: null, decided_by: "error", notes: [error instanceof Error ? error.message : String(error)] };
  }
  return {
    id,
    epoch,
    pass: judged.pass,
    decided_by: judged.pass === null ? "error" : "judge",
    ...(judged.verdict ? { verdict: judged.verdict } : {}),
    ...(judged.reasons ? { notes: [judged.reasons] } : {}),
    ...(judged.cost_usd ? { cost_usd: judged.cost_usd } : {}),
  };
}
