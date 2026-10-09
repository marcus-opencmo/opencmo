/**
 * Document của project editor ở phía server (spec editor-rewrite B1, C3).
 *
 * Document JSON là thứ duy nhất được lưu. Mọi lượt lưu đi qua `saveDocument`,
 * mọi document vào database đi qua `validate()` của clip-doc — cùng hàm với
 * editor và worker.
 *
 * `document_hash` (sha256 của `document::text`, SQL tính) là vân tay để chụp
 * revision cho Export: client gửi lại đúng chuỗi server đã trả, không tự tính.
 */

import { DocumentInvalidError, validate, type ClipDocument } from "@opencmo/clip-doc";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

export type StoredProject = {
  clip_id: string;
  document: unknown;
  document_hash: string;
  manifest?: unknown;
  version: number;
  updated_at?: string;
};

/** Cột đọc thẳng từ `editor_projects`; `document_hash` là trường tính của PostgREST. */
export const PROJECT_COLUMNS = "clip_id, document, document_hash, manifest, version, updated_at";

/**
 * Document của bộ sinh (`generate-project.ts`), đã qua `validate()` ở trong đó.
 * Bộ sinh chỉ ra thứ schema nhận (`generate-project.check.ts` kiểm mọi biến
 * thể), nên lỗi ở đây là lỗi của code, không phải của người dùng.
 */
export function generatedDocument(generate: () => ClipDocument): ClipDocument {
  try {
    return generate();
  } catch (err) {
    if (err instanceof DocumentInvalidError) {
      throw new ApiError(500, "Could not prepare this clip for editing. Please try again.");
    }
    throw err;
  }
}

/** Document đã kiểm từ client hay agent (PUT document, op). */
export function checkedDocument(input: unknown): ClipDocument {
  try {
    return validate(input);
  } catch (err) {
    if (err instanceof DocumentInvalidError) throw new ApiError(422, err.message);
    throw err;
  }
}

/** Document của một hàng đã lưu, qua `validate` (migrate schema cũ lên bản hiện hành). */
export function projectDocument(row: Pick<StoredProject, "document">): ClipDocument {
  try {
    return validate(row.document);
  } catch (err) {
    if (err instanceof DocumentInvalidError) {
      throw new ApiError(409, "This project could not be read. Reset it from Version history to keep editing.");
    }
    throw err;
  }
}

/** Hàng trả về client, với document đã kiểm. */
export function withDocument<T extends StoredProject>(row: T): T & { document: ClipDocument } {
  return { ...row, document: projectDocument(row) };
}

/** Lưu document với khoá lạc quan. */
export async function saveDocument(
  supabase: SupabaseClient,
  clipId: string,
  expectedVersion: number,
  document: ClipDocument,
  options: { manifest?: unknown } = {},
): Promise<StoredProject & { document: ClipDocument }> {
  const saved = await rpcOrThrow<StoredProject>(supabase, "save_editor_document", {
    p_clip_id: clipId,
    p_expected_version: expectedVersion,
    p_document: document,
    p_manifest: options.manifest ?? null,
  });
  return withDocument(saved);
}
