/**
 * Áp op của `@opencmo/editor-core` lên project của một clip, trên server.
 *
 * Một hàm cho hai người gọi: route `POST /api/v1/editor/ops` (UI, "áp style
 * cho mọi clip") và Assistant (`lib/agent`). Hai bản của thứ tự "CAS → áp →
 * checkpoint → lưu" là hai chỗ để một bản quên bước checkpoint.
 */

import { normalizeManifest, type Manifest } from "@opencmo/clip-assets";
import { canonicalJson, type AssetInput, type ClipDocument } from "@opencmo/clip-doc";
import { mediaSources, type Transcript as RenderTranscript } from "@opencmo/clip-render";
import { applyOps, MASTER_SRC, OpError, type OpContext, type OpResult } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import type { ClipContext } from "@/lib/api/clips";
import { notFound, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { projectDocument, saveDocument } from "@/lib/editor/document";
import { editorSource, NoEditorSourceError } from "@/lib/editor/media";
import { EDITED_TRANSCRIPT, MASTER_TRANSCRIPT, readProjectTranscript } from "@/lib/editor/transcript";

export type EditorProjectRow = {
  clip_id: string;
  document: ClipDocument;
  document_hash: string;
  version: number;
  /** Thư viện của project (đã `normalizeManifest` khi đọc) — agent đọc độ dài/loại media từ đây. */
  manifest?: unknown;
};
export type RevisionRow = {
  id: string;
  number: number;
  kind: string;
  label: string | null;
  created_at: string;
};

export type Checkpoint = { kind: "manual" | "agent"; label: string };

/** `OpContext` phía server: transcript qua RLS + RPC theo nội dung, kích thước master từ manifest. */
export function serverOpContext(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  media?: OpContext["media"],
): OpContext {
  let master: OpContext["master"] = null;
  try {
    const source = editorSource(context, clipId);
    master = { width: source.width, height: source.height };
  } catch (err) {
    if (!(err instanceof NoEditorSourceError)) throw err;
  }
  return {
    master,
    media,
    readTranscript: (path) => readProjectTranscript(supabase, context, clipId, path),
    saveTranscript: async (transcript) => {
      const hash = await rpcOrThrow<string>(supabase, "put_editor_transcript", {
        p_clip_id: clipId,
        p_body: JSON.stringify(transcript),
      });
      return `assets/transcripts/${hash}.json`;
    },
  };
}

/**
 * Độ dài nguồn + transcript đã nạp, cho op timeline chạy trên SERVER (agent,
 * route ops). Thiếu nó thì renderer coi mọi nguồn dài 16 giây: `trim`/`split`
 * của agent lệch âm thầm so với cái người dùng thấy trong editor.
 *
 * Nguồn: master từ `media_manifest` của job, file thư viện từ manifest của
 * project. Khai báo `generate.*` chưa có độ dài ở server — renderer mặc định.
 */
export async function serverMedia(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  document: ClipDocument,
  manifest: Manifest | undefined,
): Promise<NonNullable<OpContext["media"]>> {
  const durations = new Map<string, number>();
  try {
    const source = editorSource(context, clipId);
    if (source.duration > 0) durations.set(MASTER_SRC, source.duration);
  } catch (err) {
    if (!(err instanceof NoEditorSourceError)) throw err;
  }
  for (const record of manifest?.assets ?? []) {
    const duration = (record as { duration?: number }).duration;
    if (typeof duration === "number" && duration > 0) durations.set(record.path, duration);
  }
  const transcripts = new Map<string, RenderTranscript>();
  // Chỉ transcript server ĐỌC ĐƯỢC loại đó (gốc, bản đã sửa) mới tính là hỏng; file
  // .srt/.vtt của thư viện chỉ nằm trên trình duyệt, null ở đây là "không biết".
  const failed = new Set<string>();
  await Promise.all(
    mediaSources(document)
      .filter((item) => item.kind === "transcript" && typeof item.src === "string")
      .map(async ({ src }) => {
        try {
          transcripts.set(src as string, (await readProjectTranscript(supabase, context, clipId, src as string)) as never);
        } catch {
          // Transcript thiếu: phụ đề coi như rỗng, như renderer — và `check` báo ra.
          if (src === MASTER_TRANSCRIPT || EDITED_TRANSCRIPT.test(src as string)) failed.add(src as string);
        }
      }),
  );
  return {
    duration: (src: AssetInput) => (typeof src === "string" ? (durations.get(src) ?? null) : null),
    transcript: (src: string) => transcripts.get(src) ?? null,
    transcriptFailed: (src: string) => failed.has(src),
  };
}

/** Project đã lưu, với document đã kiểm và vân tay của nó. */
export async function readEditorProject(supabase: SupabaseClient, clipId: string): Promise<EditorProjectRow> {
  const { data } = await supabase
    .from("editor_projects")
    .select("clip_id, document, document_hash, version, manifest")
    .eq("clip_id", clipId)
    .maybeSingle();
  if (!data) throw notFound("Open this clip in the editor first.");
  const row = data as { clip_id: string; document: unknown; document_hash: string; version: number; manifest: unknown };
  return {
    clip_id: row.clip_id,
    document_hash: row.document_hash,
    version: row.version,
    document: projectDocument(row),
    manifest: normalizeManifest(row.manifest),
  };
}

export type Applied = {
  project: EditorProjectRow;
  /** Document trước khi áp. */
  before: EditorProjectRow["document"];
  results: OpResult[];
  checkpoint: RevisionRow | null;
  changed: boolean;
};

/**
 * Thứ tự là một phần của hợp đồng:
 *
 * 1. `expectedVersion` lệch → 409 kèm project hiện hành, TRƯỚC khi áp gì: op
 *    tính trên bản cũ là op sai. Không truyền thì dùng bản vừa đọc.
 * 2. Áp op lên document trong bộ nhớ. Op hỏng → 422 kèm `{index, op}`; không có gì được lưu
 *    (transcript đã lưu giữa chừng là hàng theo nội dung, vô hại).
 * 3. Có gì đổi và có xin checkpoint → chụp bản đang lưu — bản "Undo" đưa về.
 *    `ops` rỗng + checkpoint là một lượt chụp tường minh.
 * 4. Lưu document bằng `save_editor_document` — cùng khoá lạc
 *    quan với autosave, nên một tab ghi chen vào giữa bước 1 và bước này vẫn
 *    bị bắt.
 */
export async function applyToClip(
  supabase: SupabaseClient,
  context: ClipContext,
  clipId: string,
  ops: unknown[],
  options: { expectedVersion?: number; checkpoint?: Checkpoint | null } = {},
): Promise<Applied> {
  const project = await readEditorProject(supabase, clipId);
  const expected = options.expectedVersion ?? project.version;
  if (project.version !== expected) {
    // Cùng hình dạng với 409 của `save_editor_document`: `detail` là project hiện hành.
    throw new ApiError(409, "This clip was changed in another tab.", project);
  }

  let applied;
  try {
    const media = await serverMedia(supabase, context, clipId, project.document, normalizeManifest(project.manifest));
    applied = await applyOps(project.document, ops, serverOpContext(supabase, context, clipId, media));
  } catch (err) {
    if (err instanceof OpError) {
      // `detail` thay cho `message` trong body lỗi (`handler.ts`), nên câu phải nằm trong nó.
      throw new ApiError(422, err.message, { message: err.message, index: err.index, op: err.op });
    }
    throw err;
  }

  // Theo nội dung, không theo tham chiếu: op có thể trả một bản sao y hệt.
  const changed = canonicalJson(applied.document) !== canonicalJson(project.document);
  const checkpoint =
    options.checkpoint && (changed || ops.length === 0)
      ? await rpcOrThrow<RevisionRow>(supabase, "checkpoint_editor_project", {
          p_clip_id: clipId,
          p_kind: options.checkpoint.kind,
          p_label: options.checkpoint.label,
        })
      : null;

  const saved = !changed ? project : await saveDocument(supabase, clipId, expected, applied.document);

  return {
    project: { clip_id: saved.clip_id, document: saved.document, document_hash: saved.document_hash, version: saved.version },
    // Bản trước khi áp: agent so với bản sau để biết op đổi gì (delta), không phải đọc lại.
    before: project.document,
    results: applied.results,
    checkpoint,
    changed,
  };
}
