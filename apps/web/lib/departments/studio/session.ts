/**
 * The clip scope Studio runs a tool in: the Assistant's own scope (`clipScopeWith`), so a cut, a
 * caption, a generation or an explainer goes through exactly the code the in-app Assistant uses —
 * editor-core ops via `workspace.apply`, the same CAS and checks, a Version history checkpoint for
 * every write, labelled with who wrote it.
 */

import { clipContext } from "@/lib/api/clips";
import type { SupabaseClient } from "@/lib/api/handler";
import { clipScopeWith, type ClipHost, type Scope } from "@/lib/agent/scope";
import type { LlmUsage } from "@/lib/cmo/jobs/llm";
import { ensureProject } from "@/lib/editor/project";
import { loadCatalog } from "@/lib/generate/models";

import type { StudioCaller } from "./types";

/** The Version history label of a write; the Assistant labels its own from the turn's prompt. */
const CHECKPOINT: Record<StudioCaller, string> = { mcp: "MCP", brain: "CMO", ui: "Studio", assistant: "Assistant" };

export type SessionOptions = {
  /** Scene code previewed in this request: add_explainer only takes code that was looked at. */
  previewed?: () => Promise<string[]>;
  /** Charges the video team's model calls; absent → none are expected (MCP brings its own plans). */
  recordUsage?: (usage: LlmUsage) => Promise<void>;
};

export type StudioSession = { scope: Scope; context: Awaited<ReturnType<typeof clipContext>> };

export async function studioSession(supabase: SupabaseClient, caller: StudioCaller, clipId: string, options: SessionOptions = {}): Promise<StudioSession> {
  await loadCatalog(supabase);
  const context = await clipContext(supabase, clipId);
  // The editor creates a clip's project the first time it opens it; outside the editor nobody opens
  // it, so the first call does the same (both keep a project that already exists).
  await ensureProject(supabase, context, clipId);
  const host: ClipHost = {
    checkpoint: { take: () => ({ kind: "agent" as const, label: CHECKPOINT[caller] }), mark: async () => undefined },
    recordUsage:
      options.recordUsage ??
      (async (usage) => {
        console.warn(`[studio:${caller}] unexpected model usage`, usage.model);
      }),
    previewed: options.previewed ?? (async () => []),
  };
  return { scope: await clipScopeWith(supabase, context, clipId, host), context };
}
