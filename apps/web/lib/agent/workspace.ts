/**
 * Chỗ tool của agent đọc và ghi một clip (spec agent-editor §3.2).
 *
 * Tool không biết Supabase: chúng nói với `AgentWorkspace`. Hai bản cài:
 * - `dbWorkspace` (ở `db-workspace.ts`, server): đọc/ghi qua `applyToClip` —
 *   CAS, checkpoint lượt đầu, lưu;
 * - `memoryWorkspace` (dưới đây): document trong bộ nhớ, cho eval và test.
 * Cùng `applyOps`, cùng op, nên eval đo đúng thứ người dùng chạy.
 */

import type { Manifest } from "@opencmo/clip-assets";
import type { AssetInput, ClipDocument } from "@opencmo/clip-doc";
import type { Transcript as RenderTranscript } from "@opencmo/clip-render";
import { applyOps, type OpContext, type OpResult, type Transcript } from "@opencmo/editor-core";

export type Snapshot = { version: number; document: ClipDocument; manifest: Manifest };

/** `before`/`after`: document trước và sau lượt áp — để tính delta cho agent. */
export type Applied = { changed: boolean; version: number; results: OpResult[]; before: ClipDocument; after: ClipDocument };

export interface AgentWorkspace {
  read(): Promise<Snapshot>;
  /** `OpContext` có độ dài media + transcript đã nạp cho document này. */
  opContext(document: ClipDocument, manifest: Manifest): Promise<OpContext>;
  /** Áp op theo thứ tự; op hỏng ném `ApiError` 4xx (bản DB) hay `OpError` (bản bộ nhớ). */
  apply(ops: unknown[]): Promise<Applied>;
}

export type MemoryFiles = {
  /** Độ dài nguồn theo đường dẫn thư viện (`assets/master.mp4`, `assets/broll.mp4`). */
  durations: Record<string, number>;
  /** Transcript theo đường dẫn (`assets/transcript.json`). */
  transcripts: Record<string, Transcript>;
  master: { width: number; height: number };
};

/** Workspace trong bộ nhớ: eval chạy agent thật trên nó mà không cần database. */
export function memoryWorkspace(start: Snapshot, files: MemoryFiles) {
  let current = structuredClone(start);
  const transcripts = new Map(Object.entries(files.transcripts));
  let saved = 0;
  const context = (): OpContext => ({
    master: files.master,
    media: {
      duration: (src: AssetInput) => (typeof src === "string" ? (files.durations[src] ?? null) : null),
      transcript: (src: string) => (transcripts.get(src) as unknown as RenderTranscript | undefined) ?? null,
    },
    readTranscript: async (path) => {
      const found = transcripts.get(path);
      if (!found) throw new Error(`missing transcript ${path}`);
      return found;
    },
    saveTranscript: async (transcript) => {
      const path = `assets/transcripts/eval-${++saved}.json`;
      transcripts.set(path, transcript);
      return path;
    },
  });
  const workspace: AgentWorkspace & { snapshot(): Snapshot } = {
    snapshot: () => current,
    read: async () => structuredClone(current),
    opContext: async () => context(),
    async apply(ops) {
      const before = current.document;
      const applied = await applyOps(before, ops, context());
      const changed = JSON.stringify(applied.document) !== JSON.stringify(before);
      if (changed) current = { ...current, version: current.version + 1, document: applied.document };
      return { changed, version: current.version, results: applied.results, before, after: current.document };
    },
  };
  return workspace;
}
