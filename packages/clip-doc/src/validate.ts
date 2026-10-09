/**
 * Cửa duy nhất để một document vào database: server (route, agent, worker) và
 * editor gọi CÙNG hàm này (spec editor-rewrite §9). Thêm một luật ở đây là mọi
 * đường ghi có luật đó.
 */

import { z } from 'zod';

import { migrate } from './migrate.ts';
import type { ClipDocument } from './schema.ts';

/** Cùng trần với cột `source` (256 KB): một project thật chỉ vài KB. */
export const MAX_DOCUMENT_BYTES = 262_144;

export class DocumentInvalidError extends Error {}

/** JSON chuẩn hoá theo RFC 8785 (JCS): thứ tự khoá không đổi được hash. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DocumentInvalidError('document contains a number that cannot be saved');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new DocumentInvalidError('document contains a value that cannot be saved');
}

/** sha256 hex của bản JCS — chạy được trong trình duyệt lẫn Node (Web Crypto). */
export async function documentHash(document: ClipDocument): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(document)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * `migrate` + những luật schema zod không diễn đạt được: cỡ, và id không trùng.
 * Id trùng làm `update_element`/`delete_element` sửa nhầm node — lỗi im lặng.
 */
export function validate(input: unknown): ClipDocument {
  let document: ClipDocument;
  try {
    document = migrate(input);
  } catch (error) {
    throw new DocumentInvalidError(`document is not valid: ${firstIssue(error)}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(document)).length;
  if (bytes >= MAX_DOCUMENT_BYTES) throw new DocumentInvalidError('project is too large to save');
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string') {
      if (seen.has(record.id)) throw new DocumentInvalidError(`document has two elements with id "${record.id}"`);
      seen.add(record.id);
    }
    for (const [key, item] of Object.entries(record)) {
      // `src` có thể là khai báo asset: dữ liệu, không phải phần tử của cây.
      if (key !== 'src') visit(item);
    }
  };
  visit(document.stage);
  return document;
}

/**
 * Một dòng đọc được: `stage.children.0.marks: Unrecognized key: "wobble"`. Lỗi zod
 * mặc định là JSON nhiều dòng, và dòng đầu của nó chỉ là `[`.
 */
function firstIssue(error: unknown): string {
  if (!(error instanceof z.ZodError)) return (error as Error).message.split('\n')[0]!;
  const issue = error.issues[0]!;
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
