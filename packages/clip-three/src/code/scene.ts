/**
 * Cảnh code (spec code-scenes): code của agent + sân khấu studio + kit v2.
 * Cùng module này chạy ở preview (Web Worker trong iframe sandbox của editor) và
 * ở export (trang Chromium trên Modal), nên ảnh agent duyệt chính là video ra.
 *
 * Trình tự: biên dịch → dựng cảnh (code chạy một lần, trả `update`) → chạy
 * trước `update(duration)` để chốt hộp bao trạng thái cuối (camera không giật)
 * → mỗi khung: `update(t)`, nhãn bám vật, (tự canh khung nếu code không gọi
 * `kit.frame`), vẽ.
 */

import * as THREE from 'three';

import type { Stage } from '../studio.ts';
import { compileScene, SceneCodeError } from './guard.ts';
import { createKit, type Kit } from './kit.ts';
import { frameReport, type FrameReport } from './telemetry.ts';

export type CodeScene = {
	/** Đặt cảnh về giây `t` (chưa vẽ). Lỗi của code ra `SceneCodeError('frame')`. */
	update(t: number): void;
	/** Báo cáo bố cục của trạng thái hiện tại (sau `update`). */
	report(t: number): FrameReport;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCodeScene(stage: Stage, code: string, duration: number): CodeScene {
	const factory = compileScene<typeof THREE, Stage, Kit>(code);
	// Không tách bằng spread: `framed` là getter, spread chụp giá trị lúc tách.
	const runtime = createKit(stage);
	const { kit } = runtime;
	let update: (t: number) => void;
	try {
		const result = factory(THREE, stage, kit);
		if (typeof result !== 'function') throw new Error('The scene code must end with `return (t) => { … }`.');
		update = result as (t: number) => void;
	} catch (error) {
		throw new SceneCodeError(message(error), 'build');
	}

	const step = (t: number) => {
		try {
			update(t);
		} catch (error) {
			throw new SceneCodeError(message(error), 'frame', t);
		}
		if (!runtime.framed) kit.frame();
		runtime.afterUpdate();
	};

	// Trạng thái cuối trước: hộp bao của nó là khung cho cả cảnh.
	step(duration);
	runtime.settle();

	return {
		update: step,
		// Khung cuối (±0,1 s) bị đòi chặt hơn: nó đứng lâu nhất trên màn hình.
		report: (t) => frameReport(stage, t, t >= duration - 0.1),
	};
}

export { SceneCodeError } from './guard.ts';
