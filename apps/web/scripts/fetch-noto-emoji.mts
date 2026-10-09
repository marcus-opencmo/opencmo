/**
 * Tải emoji động Noto (Google, CC BY 4.0) theo danh mục `EMOJI_PACK` của
 * editor-core vào `packages/clip-media/lottie/emoji/<tên>.json` — chạy tay, một lần, rồi
 * commit file. Editor (CanvasKit) và export (Skottie) đọc cùng file đó.
 *
 *   npx tsx apps/web/scripts/fetch-noto-emoji.mts [--force]
 *
 * Emoji nào Noto không có bản động (404) thì báo và bỏ; danh mục phải sửa theo
 * (check `emoji.test` bắt tên trong danh mục mà thiếu file).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EMOJI_PACK } from '@opencmo/editor-core';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'clip-media', 'lottie');
const force = process.argv.includes('--force');
mkdirSync(join(OUT, 'emoji'), { recursive: true });

let bytes = 0;
const missing: string[] = [];
for (const entry of EMOJI_PACK) {
	const file = join(OUT, `${entry.name}.json`);
	if (existsSync(file) && !force) continue;
	const url = `https://fonts.gstatic.com/s/e/notoemoji/latest/${entry.codepoint}/lottie.json`;
	const response = await fetch(url);
	if (!response.ok) {
		missing.push(`${entry.name} (${entry.codepoint}): HTTP ${response.status}`);
		continue;
	}
	const data = (await response.json()) as { layers?: unknown[]; fr?: number };
	if (!Array.isArray(data.layers) || !data.fr) {
		missing.push(`${entry.name}: không phải Lottie`);
		continue;
	}
	const text = JSON.stringify(data);
	bytes += text.length;
	writeFileSync(file, text);
}
console.log(`đã tải ${(bytes / 1024 / 1024).toFixed(1)} MB`);
if (missing.length) {
	console.log(`thiếu ${missing.length}:\n  ${missing.join('\n  ')}`);
	process.exitCode = 1;
}
