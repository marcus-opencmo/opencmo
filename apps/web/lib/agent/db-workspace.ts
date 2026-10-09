import "server-only";

/**
 * `AgentWorkspace` trên database: đọc `editor_projects`, ghi qua
 * `applyToClip` (CAS → áp → checkpoint lượt ghi đầu → lưu). Checkpoint chỉ
 * chụp MỘT lần mỗi lượt người dùng — Undo đưa về trước cả lượt.
 */

import { normalizeManifest } from "@opencmo/clip-assets";

import type { ClipContext } from "@/lib/api/clips";
import type { SupabaseClient } from "@/lib/api/handler";
import { applyToClip, readEditorProject, serverMedia, serverOpContext, type Checkpoint } from "@/lib/editor/apply";

import type { AgentWorkspace } from "./workspace";

export type CheckpointHooks = {
  /** Checkpoint cho lượt ghi ĐẦU TIÊN của lượt người dùng; sau đó null. */
  take: () => Checkpoint | null;
  mark: (revisionId: string) => Promise<void>;
};

export function dbWorkspace(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  checkpoint: CheckpointHooks,
): AgentWorkspace {
  return {
    async read() {
      const project = await readEditorProject(supabase, clipId);
      return { version: project.version, document: project.document, manifest: normalizeManifest(project.manifest) };
    },
    async opContext(document, manifest) {
      const media = await serverMedia(supabase, context, clipId, document, manifest);
      return serverOpContext(supabase, context, clipId, media);
    },
    async apply(ops) {
      const applied = await applyToClip(supabase, context, clipId, ops, { checkpoint: checkpoint.take() });
      if (applied.checkpoint) await checkpoint.mark(applied.checkpoint.id);
      return { changed: applied.changed, version: applied.project.version, results: applied.results, before: applied.before, after: applied.project.document };
    },
  };
}
