/**
 * SPIKE (01/10): cảnh 3D do agent TỰ VIẾT code three.js, chạy trên sân khấu
 * studio sẵn có. Không nối vào production — chỉ để đo: code của model chạy
 * được bao nhiêu phần, vẽ mất bao lâu, và có khớp script/đẹp hơn 4 template không.
 *
 * Code của agent là THÂN của `function (THREE, stage, kit) { … return (t) => {…} }`.
 */

import * as THREE from 'three';

import { createStage, clamp01, easeInOutCubic, easeOutBack, easeOutCubic, easeOutExpo, fitDistance, glossy, metal, orbit, phase, rng, textGeometry, textMesh, type Stage } from '../src/studio.ts';

type Options = { width: number; height: number; duration: number; theme?: 'midnight' | 'aurora' | 'sunset' | 'mono'; seed?: number };

const kit = { phase, clamp01, easeOutCubic, easeInOutCubic, easeOutExpo, easeOutBack, orbit, fitDistance, glossy, metal, textMesh, textGeometry, rng };

function build(code: string, options: Options): { canvas: HTMLCanvasElement; stage: Stage; update: (t: number) => void } {
	const canvas = document.createElement('canvas');
	canvas.width = options.width;
	canvas.height = options.height;
	// `product` không có sàn gương; cảnh tự do giữ gương (template nào khác cũng được).
	const stage = createStage(canvas, { template: 'bars', theme: options.theme ?? 'midnight', width: options.width, height: options.height, duration: options.duration, seed: options.seed ?? 7 } as never);
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const factory = new Function('THREE', 'stage', 'kit', `"use strict";\n${code}`) as (three: typeof THREE, stage: Stage, k: typeof kit) => unknown;
	const update = factory(THREE, stage, kit);
	if (typeof update !== 'function') throw new Error('The scene code must return a function (t) => { … }.');
	return { canvas, stage, update: update as (t: number) => void };
}

declare global {
	interface Window {
		spike: {
			stills: (code: string, options: Options, times: number[]) => { images: string[]; triangles: number; msPerFrame: number };
			render: (code: string, options: Options, endpoint: string) => Promise<{ frames: number; ms: number; renderer: string }>;
		};
	}
}

window.spike = {
	stills(code, options, times) {
		const { canvas, stage, update } = build(code, options);
		const started = performance.now();
		const images = times.map((t) => {
			update(t);
			stage.render(t);
			return canvas.toDataURL('image/jpeg', 0.85);
		});
		return { images, triangles: stage.renderer.info.render.triangles, msPerFrame: (performance.now() - started) / times.length };
	},
	async render(code, options, endpoint) {
		const { canvas, stage, update } = build(code, options);
		document.body.appendChild(canvas);
		const gl = stage.renderer.getContext();
		const info = gl.getExtension('WEBGL_debug_renderer_info');
		const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
		const pixels = new Uint8Array(options.width * options.height * 4);
		const total = Math.ceil(options.duration * 30);
		const started = performance.now();
		for (let frame = 0; frame < total; frame++) {
			update(frame / 30);
			stage.render(frame / 30);
			gl.readPixels(0, 0, options.width, options.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
			const response = await fetch(`${endpoint}?frame=${frame}`, { method: 'POST', body: pixels });
			if (!response.ok) throw new Error(`frame ${frame}: ${response.status}`);
		}
		return { frames: total, ms: performance.now() - started, renderer };
	},
};
