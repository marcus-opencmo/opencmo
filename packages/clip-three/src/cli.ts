#!/usr/bin/env node
/**
 *   clip-three <spec.json> <out.mp4>   # in JSON kết quả ra stdout
 *
 * `spec.json` là spec render (`SceneSpec`) hoặc spec Generate của model
 * `studio-3d` (`{scene, aspectRatio, duration, seed}`) — worker gửi dạng sau.
 * Cảnh `code` có thêm `code` (chuỗi): worker tải theo `scene.code_ref` rồi gắn vào.
 *
 * Mã thoát: 2 sai tham số · 3 spec hỏng · 4 code của cảnh hỏng (lỗi của agent,
 * không retry, câu lỗi ở stderr dòng cuối) · 1 lỗi render khác.
 * Trên Modal chạy với `OPENCMO_3D_GPU=1` trong image có GPU.
 *
 * `OPENCMO_3D_SCALE` (0.25–1, chỉ dev): thu nhỏ khung để SwiftShader render
 * cho kịp. Không bao giờ đặt trên production — hash spec không biết tới nó.
 */

import { readFileSync } from 'node:fs';

import { renderToFile, SceneCodeFailure } from './render.ts';
import { fromGeneration, SceneSpecSchema, type SceneGeneration, type SceneSpec } from './spec.ts';

const [file, out] = process.argv.slice(2);
if (!file || !out) {
	process.stderr.write('dùng: clip-three <spec.json> <out.mp4>\n');
	process.exit(2);
}

function scaled(spec: SceneSpec): SceneSpec {
	const scale = Math.min(1, Math.max(0.25, Number(process.env.OPENCMO_3D_SCALE) || 1));
	if (scale === 1) return spec;
	const even = (value: number) => Math.max(64, Math.round((value * scale) / 2) * 2);
	return { ...spec, width: even(spec.width), height: even(spec.height) };
}

try {
	const input = JSON.parse(readFileSync(file, 'utf8')) as (SceneSpec | SceneGeneration) & { code?: string };
	const code = typeof input.code === 'string' ? input.code : undefined;
	delete input.code;
	let spec: SceneSpec;
	try {
		spec = 'scene' in input ? fromGeneration(input) : SceneSpecSchema.parse(input);
	} catch (error) {
		// Mã 3 = spec hỏng: worker chốt lỗi (không retry), không phải lỗi render.
		process.stderr.write(`spec không hợp lệ: ${String((error as Error).message)}\n`);
		process.exit(3);
	}
	const result = await renderToFile(scaled(spec), out, { code, log: (line) => process.stderr.write(`${line}\n`) });
	process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
	if (error instanceof SceneCodeFailure) {
		process.stderr.write(`${error.message}\n`);
		process.exit(4);
	}
	process.stderr.write(`${String((error as Error).stack ?? error)}\n`);
	process.exit(1);
}
