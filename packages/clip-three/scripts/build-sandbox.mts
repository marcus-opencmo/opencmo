/**
 * Sinh trang sandbox preview cảnh code cho editor (spec code-scenes §sandbox):
 *
 *   tsx scripts/build-sandbox.mts <out.html>
 *
 * Một file HTML tĩnh, tự đủ: runtime (three.js + sân khấu studio + kit) nằm
 * trong trang dưới dạng CHUỖI và chạy trong Web Worker tạo từ Blob. Vì sao vậy:
 * - Trang được phục vụ với CSP `sandbox allow-scripts` → origin mờ. Origin mờ
 *   không tạo được worker từ URL cùng host, cũng không fetch được file nào
 *   (`connect-src 'none'`); Blob thì được.
 * - Worker chứ không chạy thẳng trong iframe: iframe sandbox chưa chắc nằm ở
 *   tiến trình riêng, vòng lặp vô hạn trong đó có thể treo luôn editor.
 *
 * Giao thức với editor (postMessage, `'*'` vì origin mờ không biết tên mình;
 * editor kiểm `event.source`): trang gửi `{ready: true}` khi sẵn sàng; editor
 * gửi `PreviewRequest`, nhận `PreviewResponse` (ảnh là ArrayBuffer, chuyển quyền).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const out = process.argv[2];
if (!out) {
	process.stderr.write('dùng: build-sandbox.mts <out.html>\n');
	process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
	entryPoints: [join(HERE, '../src/code/worker.ts')],
	bundle: true,
	format: 'iife',
	write: false,
	minify: true,
	loader: { '.json': 'json' },
	logLevel: 'silent',
	target: 'es2022',
});
const source = bundle.outputFiles[0]!.text;

// Chuỗi trong <script>: chặn `</script>` và `<!--` đóng thẻ sớm.
const literal = JSON.stringify(source).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

const html = `<!doctype html>
<meta charset="utf-8">
<title>3D preview sandbox</title>
<script>
"use strict";
const SOURCE = ${literal};
let worker = null;
const start = () => {
  worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })));
  worker.onmessage = (event) => {
    const data = event.data;
    parent.postMessage(data, "*", data && data.ok ? data.images : []);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    parent.postMessage({ id: -1, ok: false, phase: "build", message: String(event.message || "The 3D preview crashed.") }, "*");
  };
};
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  if (!worker) start();
  worker.postMessage(event.data);
});
parent.postMessage({ ready: true }, "*");
</script>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
process.stdout.write(`sandbox 3D: ${out} (${Math.round(html.length / 1024)} KB)\n`);
