/**
 * Điểm vào chạy TRONG trang Chromium (esbuild bundle): dựng cảnh từ spec, vẽ
 * từng khung theo giây và gửi pixel ra ngoài bằng HTTP nhị phân — nhanh hơn
 * base64 qua CDP (spike 30/09: 63 so với 147 ms/khung ở 540²).
 */

import { createCodeScene, SceneCodeError } from './code/scene.ts';
import { sceneTriangles, type FrameReport } from './code/telemetry.ts';
import { SceneSpecSchema, type SceneSpec, type Theme } from './spec.ts';
import { createStage, useDisplayFont, type Stage } from './studio.ts';
import { TEMPLATES } from './templates/index.ts';

/** Số khung chờ gửi tối đa trong bộ đệm socket của trang (≤ 2 × 8,3 MB ở 1080×1920). */
const IN_FLIGHT = 2;

/** Cảnh code (spec code-scenes): code + khung + giao diện; seed cho `stage.random()`. */
export type CodeInput = { code: string; width: number; height: number; duration: number; theme?: Theme; brand?: SceneSpec['brand']; seed?: number };
export type CodeStills =
	| { ok: true; images: string[]; reports: FrameReport[]; msPerFrame: number; triangles: number }
	| { ok: false; phase: 'compile' | 'build' | 'frame'; message: string; at?: number };

/**
 * `update(t)` của một cảnh: template dựng sẵn, hoặc code của agent (template
 * `code` — code đi kèm lời gọi vì spec chỉ mang `code_ref`). Lỗi của code ra
 * `SceneCodeError`; render.ts đổi nó thành mã thoát 4.
 */
function sceneUpdate(stage: Stage, spec: SceneSpec, code?: string): (t: number) => void {
	if (spec.template !== 'code') return TEMPLATES[spec.template](stage, spec);
	if (typeof code !== 'string') throw new SceneCodeError('This scene needs its code.', 'build');
	const scene = createCodeScene(stage, code, spec.duration);
	return scene.update;
}

declare global {
	interface Window {
		clipThree: {
			render: (spec: SceneSpec, endpoint: string, from?: number, to?: number, font?: unknown, code?: string) => Promise<{ frames: number; ms: number; renderer: string; lost: number[] }>;
			stills: (spec: SceneSpec, times: number[], font?: unknown, code?: string) => string[];
			code: (input: CodeInput, times: number[]) => CodeStills;
		};
	}
}

window.clipThree = {
	/** Ảnh JPEG + báo cáo bố cục của một cảnh code ở vài mốc giây (preview cho agent, test). */
	code(input, times) {
		const canvas = document.createElement('canvas');
		canvas.width = input.width;
		canvas.height = input.height;
		// `template` chỉ để createStage quyết sàn gương; cảnh code giữ sàn gương.
		const stage = createStage(canvas, { ...input, template: 'bars' } as SceneSpec);
		try {
			const scene = createCodeScene(stage, input.code, input.duration);
			const images: string[] = [];
			const reports: FrameReport[] = [];
			const started = performance.now();
			for (const t of times) {
				scene.update(t);
				stage.render(t);
				images.push(canvas.toDataURL('image/jpeg', 0.85));
				reports.push(scene.report(t));
			}
			return { ok: true, images, reports, msPerFrame: (performance.now() - started) / Math.max(1, times.length), triangles: sceneTriangles(stage.root) };
		} catch (error) {
			if (error instanceof SceneCodeError) return { ok: false, phase: error.phase, message: error.message, ...(error.at === undefined ? {} : { at: error.at }) };
			return { ok: false, phase: 'build', message: error instanceof Error ? error.message : String(error) };
		}
	},
	/** Ảnh PNG (data URL) ở vài mốc giây — để duyệt hình nhanh, không encode video. */
	stills(input, times, font, code) {
		const spec = SceneSpecSchema.parse(input);
		useDisplayFont(font ?? null);
		const canvas = document.createElement('canvas');
		canvas.width = spec.width;
		canvas.height = spec.height;
		const stage = createStage(canvas, spec);
		const update = sceneUpdate(stage, spec, code);
		return times.map((t) => {
			update(t);
			stage.render(t);
			return canvas.toDataURL('image/png');
		});
	},
	async render(input, endpoint, from = 0, to, font, code) {
		const spec = SceneSpecSchema.parse(input);
		useDisplayFont(font ?? null);
		const canvas = document.createElement('canvas');
		canvas.width = spec.width;
		canvas.height = spec.height;
		document.body.appendChild(canvas);
		// Khung đang vẽ lúc mất WebGL context — render.ts báo hỏng thay vì ra video tối.
		const lost: number[] = [];
		let current = -1;
		canvas.addEventListener('webglcontextlost', () => lost.push(current));
		const stage = createStage(canvas, spec);
		const update = sceneUpdate(stage, spec, code);
		const gl = stage.renderer.getContext();
		const info = gl.getExtension('WEBGL_debug_renderer_info');
		const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
		const pixels = new Uint8Array(spec.width * spec.height * 4);
		const total = Math.max(1, Math.ceil(spec.duration * 30));
		const last = Math.min(total, to ?? total);
		const socket = new WebSocket(endpoint);
		socket.binaryType = 'arraybuffer';
		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error('frame socket failed'));
		});
		const frameBytes = pixels.byteLength;
		const started = performance.now();
		for (let frame = from; frame < last; frame++) {
			current = frame;
			update(frame / 30);
			stage.render(frame / 30);
			// readPixels đọc từ dưới lên: ffmpeg lật lại (vflip), rẻ hơn lật ở JS.
			gl.readPixels(0, 0, spec.width, spec.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
			// send() chép bộ đệm ngay, nên dùng lại `pixels` được. Server/ffmpeg chậm
			// thì `bufferedAmount` tăng: chờ khi vượt ~2 khung (RAM trang có trần).
			socket.send(pixels);
			while (socket.bufferedAmount > frameBytes * IN_FLIGHT) await new Promise((resolve) => setTimeout(resolve, 2));
		}
		while (socket.bufferedAmount > 0) await new Promise((resolve) => setTimeout(resolve, 2));
		socket.send('done');
		return { frames: last - from, ms: performance.now() - started, renderer, lost };
	},
};
