/**
 * Which LLM provider can answer right now.
 *
 * The product runs on Claude, Gemini or an OpenAI-compatible API (Groq…). When one of them cannot answer (no
 * credit, a revoked key, rate limits, an outage), a call moves to the next and the failed one is skipped for a while, so
 * the next user does not pay for the same failure. The memory is per server instance: every
 * instance learns from its own first failure.
 *
 * Content moderation does NOT use this memory (`lib/generate/moderation.ts`): it asks its primary
 * checker every time, so nothing another feature does can move it to the standby.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";

import { OpenAiCompatError } from "./openai-compat";

export type LlmProvider = "anthropic" | "gemini" | "openai";

/**
 * `account`: the key or its credit; someone must fix it. `busy`: rate limit or outage; it passes.
 * `quota`: one model's daily quota is spent; it comes back tomorrow.
 */
export type Outage = "account" | "busy" | "quota";

const SKIP_MS: Record<Outage, number> = { account: 10 * 60_000, busy: 60_000, quota: 10 * 60_000 };

/** The kind of outage an SDK error means, or null when the provider answered and the request is at fault. */
export function outage(error: unknown): Outage | null {
  // A timeout belongs to the request, not to the provider: retrying it elsewhere would double its
  // time and cost, and one slow request must not move every user off the provider.
  if (error instanceof Anthropic.APIConnectionTimeoutError) return null;
  if (error instanceof Anthropic.APIConnectionError) return "busy";
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 401 || status === 403 || status === 402) return "account";
    // Anthropic reports an empty balance as a 400 invalid_request_error.
    if (status === 400 && /credit balance|billing/i.test(error.message)) return "account";
    return status === 429 || status >= 500 ? "busy" : null;
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 402 || error.status === 403) return "account";
    if (error.status === 400 && /api key/i.test(error.message)) return "account";
    if (error.status === 429 && /per_day/i.test(error.message)) return "quota";
    return error.status === 429 || error.status >= 500 ? "busy" : null;
  }
  if (error instanceof OpenAiCompatError) {
    // 404: this model id is not on the endpoint. It says nothing about the key or the provider's other models, so it
    // is remembered for this model only (quota-like), not as an account outage that would block all of them (review R6).
    if (error.status === 404) return "quota";
    if (error.status === 401 || error.status === 402 || error.status === 403) return "account";
    if (error.status === 429 && /per day|\(TPD\)|\(RPD\)|daily/i.test(error.message)) return "quota";
    return error.status === 0 || error.status === 429 || error.status >= 500 ? "busy" : null;
  }
  // @google/genai rethrows the raw fetch failure (DNS, refused, reset) instead of an ApiError: the provider could not be
  // reached, so the call fails over like Anthropic's APIConnectionError (review R6).
  if (error instanceof TypeError && /fetch failed|network|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
    return "busy";
  }
  return null;
}

/**
 * A key or credit problem takes down every model of the provider; a busy answer (rate limit,
 * overload) or a spent quota is about the one model that gave it.
 */
const accountDownUntil = new Map<LlmProvider, number>();
const busyUntil = new Map<string, number>();

export function markDown(provider: LlmProvider, kind: Outage, model: string, now: number = Date.now()): void {
  const until = now + SKIP_MS[kind];
  if (kind === "account") accountDownUntil.set(provider, Math.max(accountDownUntil.get(provider) ?? 0, until));
  else busyUntil.set(`${provider}:${model}`, Math.max(busyUntil.get(`${provider}:${model}`) ?? 0, until));
}

/** The provider's key or credit failed recently: every model of it is out, not one busy model. */
export const accountDown = (provider: LlmProvider, now: number = Date.now()): boolean => (accountDownUntil.get(provider) ?? 0) > now;

export const isDown = (provider: LlmProvider, model: string, now: number = Date.now()): boolean =>
  (accountDownUntil.get(provider) ?? 0) > now || (busyUntil.get(`${provider}:${model}`) ?? 0) > now;

export function clearHealth(): void {
  accountDownUntil.clear();
  busyUntil.clear();
}

export type Candidate = { provider: LlmProvider; model: string };

/**
 * `candidates` in configured order, healthy ones first. All down: the configured order, to try anyway. A candidate on a
 * key of its own (`shared` false) is never skipped: the shared key's outage says nothing about it (review R6).
 */
export function healthyFirst<A extends Candidate>(candidates: A[], shared: (candidate: A) => boolean = () => true): A[] {
  const up = candidates.filter((candidate) => !shared(candidate) || !isDown(candidate.provider, candidate.model));
  return up.length ? up : candidates;
}

/**
 * Runs `call` on the first healthy candidate and moves to the next only when the provider itself
 * could not answer. Any other error is the caller's to report. When every candidate is out, the
 * first one's error is thrown: that is the provider the configuration asked for.
 *
 * `shared`: false for a candidate that runs on a key of its own (one agent's). Its failure says
 * nothing about the server's key, so it is not remembered for everyone else.
 */
export async function withFailover<A extends Candidate, T>(
  candidates: A[],
  call: (candidate: A) => Promise<T>,
  shared: (candidate: A) => boolean = () => true,
): Promise<T> {
  const order = healthyFirst(candidates, shared);
  let first: unknown;
  for (const [index, candidate] of order.entries()) {
    try {
      return await call(candidate);
    } catch (error) {
      const kind = outage(error);
      if (!kind) throw error;
      if (shared(candidate)) markDown(candidate.provider, kind, candidate.model);
      if (index === 0) first = error;
      if (kind === "account") console.error(`[llm] ${candidate.provider} cannot answer (key or credit)${index < order.length - 1 ? "; using the next provider" : ""}`);
    }
  }
  throw first;
}
