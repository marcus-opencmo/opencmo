/**
 * Schema document → `packages/contracts/clip-document.schema.json`.
 *
 *   node packages/clip-doc/scripts/json-schema.ts           # ghi
 *   node packages/clip-doc/scripts/json-schema.ts --check   # CI: đỏ nếu file cũ
 *
 * Worker Python (export trên Modal, A4) validate document bằng file này thay vì
 * viết lại schema lần hai. Nguồn sự thật vẫn là zod trong `src/schema.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { DOCUMENT_VERSION, DocumentSchema } from '../src/schema.ts';

const target = join(import.meta.dirname, '../../contracts/clip-document.schema.json');
const schema = {
  ...z.toJSONSchema(DocumentSchema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw', reused: 'ref' }),
  $id: 'https://opencmo.io/schemas/clip-document.json',
  title: `OpenCMO clip document v${DOCUMENT_VERSION}`,
};
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // thiếu file cũng là cũ
  }
  if (current !== text) {
    console.error('clip-document.schema.json đã cũ — chạy: node packages/clip-doc/scripts/json-schema.ts');
    process.exit(1);
  }
  console.log('clip-document.schema.json khớp schema zod');
} else {
  writeFileSync(target, text);
  console.log(`đã ghi ${target} (${text.length} byte)`);
}
