/**
 * The one place a CMO job asks a model. With OpenCMO's brain it is `structured()`; with the
 * founder's Claude (`input.brain = "claude"`) the call is not made: the run stops and the request
 * goes to the inbox (`NeedsClaude`), and a replay later hands the submitted answer back here,
 * validated with the same zod schema the model output would have met. The job code after the call
 * (deterministic checks, cards) is the same for both.
 */

import { z } from "zod";

import { fakeAllowed, LlmError, structured, type StructuredOptions } from "./llm";
import type { Brain, InboxRequest } from "./types";

export type ThinkOptions<S extends z.ZodType> = StructuredOptions<S> & {
  /** What the founder's Claude is asked to do, one line (the inbox shows it). */
  title: string;
  /** CI/E2E stand-in for the model (`OPENCMO_AGENT_FAKE`); never used for an inbox run. */
  fake?: () => z.infer<S>;
};

/** The run reached a model call it may not make: the runner writes `request` to the inbox. */
export class NeedsClaude extends Error {
  constructor(
    readonly step: string,
    readonly request: InboxRequest,
  ) {
    super("waiting for Claude");
  }
}

export async function think<S extends z.ZodType>(opts: ThinkOptions<S>, brain: Brain, answers: Record<string, unknown>): Promise<z.infer<S>> {
  if (brain === "claude") {
    if (Object.hasOwn(answers, opts.label)) {
      const parsed = opts.schema.safeParse(answers[opts.label]);
      if (parsed.success) return parsed.data;
      const issue = parsed.error.issues[0];
      throw new LlmError(`The answer does not match the expected shape${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}.`);
    }
    throw new NeedsClaude(opts.label, {
      title: opts.title,
      agent: opts.agent,
      system: opts.system,
      prompt: opts.prompt,
      schema: z.toJSONSchema(opts.schema) as Record<string, unknown>,
    });
  }
  if (opts.fake && fakeAllowed()) return opts.fake();
  return structured(opts);
}
