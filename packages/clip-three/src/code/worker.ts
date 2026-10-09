/**
 * Web Worker của preview cảnh code trong editor (spec code-scenes §sandbox).
 * Chạy trong iframe sandbox (origin mờ, CSP riêng) → worker từ Blob: code của
 * agent không chạm được trang editor, và một vòng lặp vô hạn chỉ treo worker —
 * editor xoá iframe là xong.
 *
 * Cùng runtime với export (`createCodeScene` + sân khấu studio) nên ảnh agent
 * duyệt chính là khung của video. Vẽ bằng GPU của máy người dùng (OffscreenCanvas).
 */

import { createStage } from '../studio.ts';
import type { SceneSpec, Theme } from '../spec.ts';
import { createCodeScene, SceneCodeError } from './scene.ts';
import { sceneTriangles, type FrameReport } from './telemetry.ts';

export type PreviewRequest = {
	id: number;
	code: string;
	width: number;
	height: number;
	duration: number;
	theme?: Theme;
	brand?: SceneSpec['brand'];
	seed?: number;
	times: number[];
};

export type PreviewResponse =
	| { id: number; ok: true; images: ArrayBuffer[]; reports: FrameReport[]; msPerFrame: number; triangles: number; renderer: string }
	| { id: number; ok: false; phase: 'compile' | 'build' | 'frame'; message: string; at?: number };

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null;
	postMessage(message: PreviewResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
	const request = event.data;
	const canvas = new OffscreenCanvas(request.width, request.height);
	let dispose: (() => void) | null = null;
	try {
		const stage = createStage(canvas, { ...request, template: 'bars' } as unknown as SceneSpec);
		dispose = () => stage.renderer.dispose();
		const scene = createCodeScene(stage, request.code, request.duration);
		const images: ArrayBuffer[] = [];
		const reports: FrameReport[] = [];
		const started = Date.now();
		for (const t of request.times) {
			scene.update(t);
			stage.render(t);
			images.push(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer());
			reports.push(scene.report(t));
		}
		const gl = stage.renderer.getContext();
		const info = gl.getExtension('WEBGL_debug_renderer_info');
		const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
		scope.postMessage(
			{ id: request.id, ok: true, images, reports, msPerFrame: (Date.now() - started) / Math.max(1, request.times.length), triangles: sceneTriangles(stage.root), renderer },
			images,
		);
	} catch (error) {
		const failure = error instanceof SceneCodeError
			? { phase: error.phase, message: error.message, ...(error.at === undefined ? {} : { at: error.at }) }
			: { phase: 'build' as const, message: error instanceof Error ? error.message : String(error) };
		scope.postMessage({ id: request.id, ok: false, ...failure });
	} finally {
		dispose?.();
	}
};
