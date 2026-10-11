import "server-only";

/**
 * Một cửa gọi model cho mọi việc CMO (W0, W1, W2…): structured output ép theo schema zod, ánh
 * xạ lỗi API về câu tiếng Anh cho người dùng. Provider/model/khoá theo AGENT gọi (H1): mỗi job
 * nói "tôi là agent nào", sổ agent quyết định chạy bằng gì.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { resolveAgent, type AgentId } from "@/lib/cmo/agents/registry";

import { LlmError } from "./llm-error";

export { LlmError };

/** Bản giả cho CI/E2E. Không bao giờ bật trên production. */
export function fakeAllowed(): boolean {
  return process.env.OPENCMO_AGENT_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

/** Agent chạy được: bản giả, hoặc đã có khoá cho provider của nó. */
export function llmReady(agent: AgentId = "planner"): boolean {
  return fakeAllowed() || Boolean(resolveAgent(agent).apiKey);
}

type Options<S extends z.ZodType> = {
  /** Agent trong sổ (`lib/cmo/agents/registry.ts`) — quyết định provider, model, khoá. */
  agent: AgentId;
  system: string;
  prompt: string;
  schema: S;
  maxTokens?: number;
  /** Nhãn cho log nội bộ. */
  label: string;
  /** Câu báo lỗi chung cho người dùng (tiếng Anh). */
  failure: string;
};

export async function structured<S extends z.ZodType>(opts: Options<S>): Promise<z.infer<S>> {
  const agent = resolveAgent(opts.agent);
  if (!agent.apiKey) throw new LlmError("The AI CMO is not set up on this server yet.");
  const client = new Anthropic({ apiKey: agent.apiKey });
  // Haiku 4.5 không có `effort` và không có fallback phía server; Opus thì có.
  const isOpus = agent.model.startsWith("claude-opus");
  let response;
  try {
    response = await client.beta.messages.parse({
      model: agent.model,
      max_tokens: opts.maxTokens ?? 8000,
      output_config: isOpus
        ? { effort: "medium", format: betaZodOutputFormat(opts.schema) }
        : { format: betaZodOutputFormat(opts.schema) },
      ...(isOpus ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) throw new LlmError("Our AI is busy right now. Try again in a minute.");
    if (error instanceof Anthropic.APIError) console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): lỗi API`, error.status, error.message);
    else console.error(`[cmo] ${opts.label}: parse/khác`, error);
    throw new LlmError(opts.failure);
  }
  if (response.stop_reason === "refusal") throw new LlmError(opts.failure);
  if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new LlmError(opts.failure);
  return response.parsed_output as z.infer<S>;
}
