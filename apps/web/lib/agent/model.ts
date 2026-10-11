import "server-only";

/**
 * Picks the Assistant's provider.
 *
 * - `OPENCMO_AGENT_FAKE=1` (never in production): the scripted model for CI/E2E.
 * - Otherwise Claude, when the server has an Anthropic key.
 *
 * A session is bound to its model (native history): `providerForModel` rebuilds that provider, or
 * returns null when the server can no longer run it. Chats saved while Gemini was a provider stay
 * readable through `formatFor` but cannot be continued.
 */

import { resolveAgent, type AgentId } from "@/lib/cmo/agents/registry";

import { ANTHROPIC_MODEL, anthropicFormat, anthropicProvider } from "./providers/anthropic";
import { fakeProvider } from "./providers/fake";
import { geminiFormat } from "./providers/gemini-history";
import type { Format, Provider, ProviderKind } from "./providers/types";

function fakeAllowed(): boolean {
  return process.env.OPENCMO_AGENT_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

const hasAnthropicKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Provider for a NEW session, or null when the Assistant is not set up. */
export function agentProvider(): Provider | null {
  if (fakeAllowed()) return fakeProvider;
  return hasAnthropicKey() ? anthropicProvider() : null;
}

/**
 * Provider for a CMO agent that chats (H1): model and key come from the agent registry
 * (`CMO_AGENT_<ID>_*`), not from the editor Assistant. Null when the agent has no key.
 */
export function agentChatProvider(id: AgentId): Provider | null {
  if (fakeAllowed()) return fakeProvider;
  const agent = resolveAgent(id);
  return agent.apiKey ? anthropicProvider(agent.model, agent.apiKey) : null;
}

/** Provider family of a saved model id. */
export const kindOf = (model: string): ProviderKind =>
  model === "fake" ? "fake" : model.startsWith("gemini") ? "gemini" : "anthropic";

/** History format of a session — needs no key, used to draw the panel. */
export const formatFor = (model: string): Format =>
  kindOf(model) === "gemini" ? geminiFormat : { kind: kindOf(model), ...anthropicFormat };

/** Provider to continue an existing session; null when the server cannot run it any more. */
export function providerForModel(model: string): Provider | null {
  switch (kindOf(model)) {
    case "fake":
      return fakeAllowed() ? fakeProvider : null;
    case "gemini":
      return null;
    default:
      return hasAnthropicKey() && model === ANTHROPIC_MODEL ? anthropicProvider() : null;
  }
}

/** Models the panel can offer (only those the server has a key for), default first. */
export function availableModels(): { id: string; label: string }[] {
  if (fakeAllowed()) return [{ id: "fake", label: "Test model" }];
  return hasAnthropicKey() ? [{ id: ANTHROPIC_MODEL, label: "Claude Opus 5" }] : [];
}
