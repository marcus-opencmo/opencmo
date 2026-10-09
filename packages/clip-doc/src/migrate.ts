/**
 * Đọc document đã lưu ở version bất kỳ → version hiện tại, rồi validate.
 *
 * Mỗi lần đổi schema theo kiểu không tương thích thì tăng `DOCUMENT_VERSION` và
 * thêm MỘT bước vào `STEPS`: bước n nhận document version n, trả version n+1.
 * Không bao giờ sửa một bước đã có — document cũ trong database đi qua đúng chuỗi
 * đó mãi mãi.
 */

import { DOCUMENT_VERSION, DocumentSchema, type ClipDocument } from './schema.ts';

type Step = (document: Record<string, unknown>) => Record<string, unknown>;

/** `STEPS[n]` đưa version n lên n + 1. Chưa có bước nào: version 1 là bản đầu. */
const STEPS: Record<number, Step> = {};

export function migrate(input: unknown): ClipDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('document must be an object');
  }
  let document = input as Record<string, unknown>;
  let version = document.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`document has no valid version (got ${JSON.stringify(version)})`);
  }
  if (version > DOCUMENT_VERSION) {
    throw new Error(`document version ${version} is newer than this editor (${DOCUMENT_VERSION}); reload the page`);
  }
  while (version < DOCUMENT_VERSION) {
    const step = STEPS[version];
    if (!step) throw new Error(`no migration from document version ${version}`);
    document = step(document);
    version += 1;
    document.version = version;
  }
  return DocumentSchema.parse(document);
}
