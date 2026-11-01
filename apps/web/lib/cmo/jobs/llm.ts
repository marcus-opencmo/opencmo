import "server-only";

/**
 * Một cửa gọi model cho mọi việc CMO (W0, W1, W2…): structured output ép theo schema zod, ánh
 * xạ lỗi API về câu tiếng Anh cho người dùng. Provider/model/khoá theo AGENT gọi (H1): mỗi job
 * nói "tôi là agent nào", sổ agent quyết định chạy bằng gì.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { agentCandidates, type AgentId, type ProviderKind, type ResolvedAgent } from "@/lib/cmo/agents/registry";
import { compatJson, OpenAiCompatError } from "@/lib/openai-compat";

import { outage, withFailover } from "@/lib/llm-health";

import { LlmError } from "./llm-error";
import { isProduction } from "@/lib/production";

export { LlmError };

/** Bản giả cho CI/E2E. Không bao giờ bật trên production. */
export function fakeAllowed(): boolean {
  return process.env.OPENCMO_AGENT_FAKE === "1" && !isProduction();
}

/** The agent can run: the fake, or the server has a key for some provider of it. */
export function llmReady(agent: AgentId = "planner"): boolean {
  return fakeAllowed() || agentCandidates(agent).length > 0;
}

export type StructuredOptions<S extends z.ZodType> = {
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
  /** Request time limit; the SDK default is ten minutes. */
  timeoutMs?: number;
  /** Token usage of the call, for callers that charge it (the editor's Video agent team). */
  onUsage?: (usage: LlmUsage) => void | Promise<void>;
  /**
   * Run as this provider first, whatever the agent is configured for. The eval judge uses it so a
   * model never grades its own provider's drafts.
   */
  prefer?: ProviderKind;
};

export type LlmUsage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

const usageListeners = new Set<(usage: LlmUsage, agent: AgentId) => void>();

/**
 * Every structured call's usage, process-wide. Only the eval CLIs listen (to cap what a run spends);
 * a server never registers one, so production has no shared state here.
 */
export function onLlmUsage(listener: (usage: LlmUsage, agent: AgentId) => void): () => void {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

async function structuredGemini<S extends z.ZodType>(opts: StructuredOptions<S>, agent: ResolvedAgent): Promise<z.infer<S>> {
  let response;
  try {
    response = await new GoogleGenAI({ apiKey: agent.apiKey }).models.generateContent({
      model: agent.model,
      contents: opts.prompt,
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(opts.schema),
        // Gemini's thinking tokens count against this cap: without the extra room the JSON is cut off.
        maxOutputTokens: (opts.maxTokens ?? 8000) + 16_000,
        ...(opts.timeoutMs ? { httpOptions: { timeout: opts.timeoutMs } } : {}),
      },
    });
  } catch (error) {
    // The provider itself cannot answer: `structured` decides whether another one can.
    if (outage(error)) throw error;
    console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): Gemini error`, error instanceof ApiError ? error.status : "", error instanceof Error ? error.message : error);
    throw new LlmError(opts.failure);
  }
  const meta = response.usageMetadata;
  const cached = meta?.cachedContentTokenCount ?? 0;
  await opts.onUsage?.({
    model: response.modelVersion ?? agent.model,
    input: Math.max(0, (meta?.promptTokenCount ?? 0) - cached),
    output: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cacheRead: cached,
    cacheWrite: 0,
  });
  // Gemini's schema shapes the output but does not guarantee it: zod is still the gate.
  let parsed;
  try {
    parsed = opts.schema.safeParse(JSON.parse(response.text ?? ""));
  } catch {
    throw new LlmError(opts.failure);
  }
  if (!parsed.success) {
    console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): Gemini output does not match the schema`, parsed.error.issues.slice(0, 3));
    throw new LlmError(opts.failure);
  }
  return parsed.data;
}

async function structuredOpenAi<S extends z.ZodType>(opts: StructuredOptions<S>, agent: ResolvedAgent): Promise<z.infer<S>> {
  let answer;
  try {
    answer = await compatJson({
      baseUrl: agent.baseUrl,
      apiKey: agent.apiKey,
      model: agent.model,
      system: opts.system,
      content: opts.prompt,
      schema: z.toJSONSchema(opts.schema) as Record<string, unknown>,
      maxTokens: opts.maxTokens ?? 8000,
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    if (outage(error)) throw error;
    console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): OpenAI-compatible error`, error instanceof OpenAiCompatError ? error.status : "", error instanceof Error ? error.message : error);
    throw new LlmError(opts.failure);
  }
  await opts.onUsage?.({ model: answer.model, input: answer.usage.input, output: answer.usage.output, cacheRead: answer.usage.cacheRead, cacheWrite: 0 });
  const parsed = opts.schema.safeParse(answer.json);
  if (!parsed.success) {
    console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): output does not match the schema`, parsed.error.issues.slice(0, 3));
    throw new LlmError(opts.failure);
  }
  return parsed.data;
}

/** One call on exactly this provider; an outage is thrown as is, for the caller to fall through. */
export function structuredOn<S extends z.ZodType>(opts: StructuredOptions<S>, agent: ResolvedAgent): Promise<z.infer<S>> {
  if (agent.provider === "gemini") return structuredGemini(opts, agent);
  if (agent.provider === "openai") return structuredOpenAi(opts, agent);
  return structuredAnthropic(opts, agent);
}

/**
 * One structured call. The agent's configured provider answers; when that provider cannot (no
 * credit, a bad key, rate limits, an outage), the call runs on the next provider of the order the
 * server has a key for (`CMO_LLM_PROVIDERS`), on that provider's model of the same tier.
 */
export async function structured<S extends z.ZodType>(input: StructuredOptions<S>): Promise<z.infer<S>> {
  const opts: StructuredOptions<S> = usageListeners.size
    ? {
        ...input,
        onUsage: async (usage) => {
          for (const listener of usageListeners) listener(usage, input.agent);
          await input.onUsage?.(usage);
        },
      }
    : input;
  const candidates = agentCandidates(opts.agent, process.env, opts.prefer);
  if (!candidates.length) throw new LlmError("The AI CMO is not set up on this server yet.");
  try {
    return await withFailover(candidates, (agent) => structuredOn(opts, agent), (agent) => !agent.ownKey);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    const kind = outage(error);
    if (!kind) throw error;
    console.error(`[cmo] ${opts.label} (${opts.agent}): no provider could answer`, error instanceof Error ? error.message : error);
    throw new LlmError(kind === "account" ? opts.failure : "Our AI is busy right now. Try again in a minute.");
  }
}

async function structuredAnthropic<S extends z.ZodType>(opts: StructuredOptions<S>, agent: ResolvedAgent): Promise<z.infer<S>> {
  const client = new Anthropic({ apiKey: agent.apiKey });
  // Opus and Sonnet 5.5 have server-side fallback; Haiku has none. Haiku 5.5 thinks by default
  // (effort medium): a check runs at low. Haiku 4.5 rejects `effort`.
  const drafts = agent.model.startsWith("claude-opus") || agent.model.startsWith("claude-sonnet-5-5");
  const effort = drafts ? "medium" : agent.model.startsWith("claude-haiku-5") ? "low" : undefined;
  let response;
  try {
    response = await client.beta.messages.parse({
      model: agent.model,
      max_tokens: opts.maxTokens ?? 8000,
      output_config: effort ? { effort, format: betaZodOutputFormat(opts.schema) } : { format: betaZodOutputFormat(opts.schema) },
      ...(drafts ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      // Each agent's system prompt is fixed text (motion director, video director: several
      // thousand tokens), so repeat calls and fix rounds read it from the cache.
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.prompt }],
    }, opts.timeoutMs ? { timeout: opts.timeoutMs, maxRetries: 1 } : undefined);
  } catch (error) {
    if (outage(error)) throw error;
    if (error instanceof Anthropic.APIError) console.error(`[cmo] ${opts.label} (${agent.id}/${agent.model}): lỗi API`, error.status, error.message);
    else console.error(`[cmo] ${opts.label}: parse/khác`, error);
    throw new LlmError(opts.failure);
  }
  await opts.onUsage?.({
    model: response.model,
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  });
  if (response.stop_reason === "refusal") throw new LlmError(opts.failure);
  if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new LlmError(opts.failure);
  return response.parsed_output as z.infer<S>;
}
