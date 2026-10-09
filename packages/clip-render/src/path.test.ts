import { createCanvas } from '@napi-rs/canvas';
import type { ClipDocument } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { createRenderer } from './index.ts';

const NO_MEDIA = { image: () => null, video: () => null, duration: () => null };

const doc = (children: unknown[]): ClipDocument =>
	({ version: 1, stage: { children: [{ kind: 'scene', id: 'sc', width: 100, height: 100, fill: '#000000', children }] } }) as unknown as ClipDocument;

function pixels(children: unknown[], seconds: number, points: [number, number][]): number[][] {
	const renderer = createRenderer(doc(children), NO_MEDIA);
	const canvas = createCanvas(100, 100);
	renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(seconds));
	const ctx = canvas.getContext('2d');
	return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

describe('path', () => {
	it('viewBox scale vào hộp, fill theo luật evenodd', () => {
		// Hai hình vuông lồng nhau: evenodd đục lỗ ở giữa.
		const ring = {
			kind: 'path',
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			viewBox: [0, 0, 10, 10],
			d: 'M0 0 H10 V10 H0 Z M3 3 H7 V7 H3 Z',
			fill: '#FFFFFF',
			fillRule: 'evenodd',
		};
		expect(pixels([ring], 0, [[10, 10], [50, 50]])).toEqual([WHITE, BLACK]);
		expect(pixels([{ ...ring, fillRule: 'nonzero' }], 0, [[50, 50]])).toEqual([WHITE]);
	});

	it('trimEnd keyframe vẽ nét dần; fill chỉ hiện khi vẽ trọn', () => {
		const line = {
			kind: 'path',
			width: 100,
			height: 100,
			d: 'M0 50 L100 50',
			strokes: [{ color: '#FFFFFF', width: 10 }],
			tracks: [{ property: 'trimEnd', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }],
		};
		// Ở 0.5 giây: nửa trái đã vẽ, nửa phải chưa.
		expect(pixels([line], 0.5, [[20, 50], [80, 50]])).toEqual([WHITE, BLACK]);
		expect(pixels([line], 1, [[80, 50]])).toEqual([WHITE]);

		const box = { kind: 'path', width: 100, height: 100, d: 'M10 10 H90 V90 H10 Z', fill: '#FFFFFF', trimEnd: 0.5 };
		expect(pixels([box], 0, [[50, 50]])).toEqual([BLACK]);
	});

	it('đường con của mũi tên vẽ lần lượt, không hiện đầu trước', () => {
		const arrow = {
			kind: 'path',
			width: 100,
			height: 100,
			d: 'M0 50 L90 50 M80 40 L90 50 L80 60',
			strokes: [{ color: '#FFFFFF', width: 4 }],
			trimEnd: 0.4,
		};
		// Đầu mũi tên (80,42) chưa hiện khi mới vẽ 40%.
		expect(pixels([arrow], 0, [[20, 50], [81, 41]])).toEqual([WHITE, BLACK]);
	});
});

describe('morph (track d)', () => {
	it('nội suy hình giữa hai mốc, hai đầu đúng hình', () => {
		// Hình vuông nhỏ ở trái → hình vuông ở phải (cùng viewBox 100).
		const box = {
			kind: 'path',
			width: 100,
			height: 100,
			d: 'M0 40 H20 V60 H0 Z',
			fill: '#FFFFFF',
			tracks: [{ property: 'd', keyframes: [{ time: 0, value: 'M0 40 H20 V60 H0 Z' }, { time: 1, value: 'M80 40 H100 V60 H80 Z' }] }],
		};
		expect(pixels([box], 0, [[10, 50], [90, 50]])).toEqual([WHITE, BLACK]);
		expect(pixels([box], 0.5, [[10, 50], [50, 50], [90, 50]])).toEqual([BLACK, WHITE, BLACK]);
		expect(pixels([box], 1, [[10, 50], [90, 50]])).toEqual([BLACK, WHITE]);
	});
});
