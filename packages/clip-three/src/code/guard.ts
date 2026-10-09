/**
 * Biên dịch code cảnh do agent viết (spec code-scenes): THÂN của
 * `function (THREE, stage, kit) { … return (t) => { … } }`.
 *
 * Đây KHÔNG phải ranh giới bảo mật — code chạy trong iframe sandbox (editor) hay
 * container không mạng, không secret (Modal). Thứ guard giữ là TẤT ĐỊNH: cùng t
 * phải ra cùng khung, vì preview và export vẽ khung theo thứ tự khác nhau. Nên
 * che những thứ làm khung phụ thuộc đồng hồ hay ngẫu nhiên, và những thứ không
 * có nghĩa trong một cảnh (mạng, hẹn giờ).
 */

import { MAX_CODE_CHARS } from '../spec.ts';

export { MAX_CODE_CHARS };

/** Giai đoạn hỏng: agent cần biết để sửa đúng chỗ. */
export type ScenePhase = 'compile' | 'build' | 'frame';

export class SceneCodeError extends Error {
	readonly phase: ScenePhase;
	/** Giây của khung hỏng (phase `frame`). */
	readonly at?: number;

	constructor(message: string, phase: ScenePhase, at?: number) {
		super(message);
		this.name = 'SceneCodeError';
		this.phase = phase;
		if (at !== undefined) this.at = at;
	}
}

/** Tên toàn cục bị che bằng tham số `undefined`. `eval`/`arguments` không làm tên tham số được trong strict mode. */
const SHADOWED = [
	'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker',
	'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask',
	'Date', 'performance', 'crypto', 'Function',
	'globalThis', 'self', 'window', 'document', 'navigator', 'location',
	'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'postMessage',
] as const;

/** Math y nguyên trừ `random`: ngẫu nhiên phải đi qua `stage.random()` có seed. */
const SEEDED_MATH: Math = Object.freeze(
	Object.assign(Object.create(Math) as Math, {
		random: () => {
			throw new Error('Math.random is not allowed: call stage.random() while building the scene (it is seeded).');
		},
	}),
);

export type SceneFactory<Three, Stage, Kit> = (three: Three, stage: Stage, kit: Kit) => unknown;

/** Code → hàm dựng cảnh. Lỗi cú pháp ra `SceneCodeError('compile')` với câu của JS engine. */
export function compileScene<Three, Stage, Kit>(code: string): SceneFactory<Three, Stage, Kit> {
	if (typeof code !== 'string' || !code.trim()) throw new SceneCodeError('The scene code is empty.', 'compile');
	if (code.length > MAX_CODE_CHARS) throw new SceneCodeError(`The scene code is longer than ${MAX_CODE_CHARS} characters.`, 'compile');
	let body: (...args: unknown[]) => unknown;
	try {
		// Chính đây là chỗ cần eval: code của cảnh LÀ chương trình (spec code-scenes §sandbox).
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		body = new Function('THREE', 'stage', 'kit', 'Math', ...SHADOWED, `"use strict";\n${code}`) as (...args: unknown[]) => unknown;
	} catch (error) {
		throw new SceneCodeError(`Syntax error: ${(error as Error).message}`, 'compile');
	}
	return (three, stage, kit) => body(three, stage, kit, SEEDED_MATH, ...SHADOWED.map(() => undefined));
}
