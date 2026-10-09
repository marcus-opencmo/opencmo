import "server-only";

/**
 * Chọn provider cho Assistant.
 *
 * - `OPENCMO_AGENT_FAKE=1` (không bao giờ trên production): model giả của CI/E2E.
 * - `AGENT_PROVIDER=gemini|anthropic`: chọn tường minh.
 * - Không đặt: có key nào dùng key đó, **ưu tiên Claude** (quyết định của
 *   Marcus 26/09, spec agent-editor §3.6: agent dựng nhiều bước cần model dùng
 *   tool giỏi nhất). Chỉ có `GEMINI_API_KEY` thì dùng Gemini.
 *
 * Phiên đã có gắn với model của nó (lịch sử native): `providerForModel` dựng
 * lại đúng provider đó, hoặc null khi server không còn khoá cho nó.
 */

import { resolveAgent, type AgentId } from "@/lib/cmo/agents/registry";

import { ANTHROPIC_MODEL, anthropicFormat, anthropicProvider } from "./providers/anthropic";
import { fakeProvider } from "./providers/fake";
import { GEMINI_MODEL, geminiFormat, geminiProvider } from "./providers/gemini";
import type { Format, Provider } from "./providers/types";

function fakeAllowed(): boolean {
  return process.env.OPENCMO_AGENT_FAKE === "1" && process.env.VERCEL_ENV !== "production";
}

const hasAnthropicKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

/** Provider cho phiên MỚI, hoặc null khi Assistant chưa được cấu hình. */
export function agentProvider(): Provider | null {
  if (fakeAllowed()) return fakeProvider;
  const wanted = process.env.AGENT_PROVIDER;
  if (wanted === "anthropic") return hasAnthropicKey() ? anthropicProvider() : null;
  if (wanted === "gemini") return geminiKey() ? geminiProvider(geminiKey()) : null;
  if (hasAnthropicKey()) return anthropicProvider();
  if (geminiKey()) return geminiProvider(geminiKey());
  return null;
}

/**
 * Provider cho một agent CMO có chat (H1): provider/model/khoá theo sổ agent
 * (`CMO_AGENT_<ID>_*`, mặc định Gemini), không theo `AGENT_PROVIDER` của Assistant editor.
 * Null khi agent chưa có khoá.
 */
export function agentChatProvider(id: AgentId): Provider | null {
  if (fakeAllowed()) return fakeProvider;
  const agent = resolveAgent(id);
  if (!agent.apiKey) return null;
  return agent.provider === "anthropic" ? anthropicProvider(agent.model, agent.apiKey) : geminiProvider(agent.apiKey, undefined, agent.model);
}

/** Họ provider của một id model đã lưu. */
export const kindOf = (model: string): Provider["kind"] =>
  model === "fake" ? "fake" : model.startsWith("gemini") ? "gemini" : "anthropic";

/** Định dạng lịch sử của một phiên — không cần khoá, dùng để vẽ panel. */
export const formatFor = (model: string): Format =>
  kindOf(model) === "gemini" ? geminiFormat : { kind: kindOf(model), ...anthropicFormat };

/** Provider để chạy tiếp một phiên đã có; null khi server không còn khoá cho nó. */
export function providerForModel(model: string): Provider | null {
  switch (kindOf(model)) {
    case "fake":
      return fakeAllowed() ? fakeProvider : null;
    case "gemini":
      // Model của phiên có thể là một id cụ thể do `modelVersion` trả về; phiên
      // chạy tiếp bằng model đang cấu hình — cùng họ, cùng định dạng lịch sử.
      return geminiKey() ? geminiProvider(geminiKey()) : null;
    default:
      return hasAnthropicKey() && model === ANTHROPIC_MODEL ? anthropicProvider() : null;
  }
}

/** Model người dùng chọn được ở panel (chỉ những model server có khoá), mặc định đứng đầu. */
export function availableModels(): { id: string; label: string }[] {
  if (fakeAllowed()) return [{ id: "fake", label: "Test model" }];
  const out: { id: string; label: string }[] = [];
  if (hasAnthropicKey()) out.push({ id: ANTHROPIC_MODEL, label: "Claude Opus 5" });
  if (geminiKey()) out.push({ id: GEMINI_MODEL, label: "Gemini Pro" });
  // Mặc định (`agentProvider`) lên đầu — AGENT_PROVIDER có thể đổi thứ tự.
  const preferred = agentProvider()?.model;
  return out.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
}

export { GEMINI_MODEL };
