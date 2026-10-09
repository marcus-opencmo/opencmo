#!/usr/bin/env node
/**
 * Dry-run: mọi document đã lưu còn qua `validate()` của bản clip-doc hiện tại không.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run documents:check
 *
 * Chạy TRƯỚC khi deploy một bản siết schema (R5: `marks` có schema theo từng khoá).
 * Hàng không qua được thì sau khi deploy mở ra là 409 "could not be read", nên phải
 * biết trước. Script chỉ đọc: `editor_projects.document`, `generated_document` (bản
 * gốc cho Reset) và `editor_revisions.document` (bản chụp cho Export). In từng hàng
 * hỏng kèm lỗi đầu tiên, thoát mã 1 nếu có.
 */

import { createClient } from '@supabase/supabase-js';

import { validate } from '@opencmo/clip-doc';

const PAGE = 200;
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

async function* rows(table: string, columns: string, order: string): AsyncGenerator<Record<string, unknown>> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select(columns).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) yield row;
    if ((data ?? []).length < PAGE) return;
  }
}

const failures: string[] = [];
let checked = 0;
const check = (label: string, document: unknown) => {
  if (document == null) return;
  checked += 1;
  try {
    validate(document);
  } catch (error) {
    failures.push(`${label}: ${(error as Error).message}`);
  }
};

for await (const row of rows('editor_projects', 'clip_id, document, generated_document', 'clip_id')) {
  check(`project ${row.clip_id} document`, row.document);
  check(`project ${row.clip_id} generated_document`, row.generated_document);
}
for await (const row of rows('editor_revisions', 'id, clip_id, document', 'id')) {
  check(`revision ${row.id} (clip ${row.clip_id})`, row.document);
}

for (const line of failures) console.error(`HỎNG ${line}`);
console.log(`${checked} document đã kiểm · ${failures.length} hỏng`);
process.exit(failures.length ? 1 : 0);
