import { createCanvas } from '@napi-rs/canvas';
import type { ClipDocument } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { createRenderer } from './index.ts';
import { cube, surface } from './three/mesh.ts';

const NO_MEDIA = { image: () => null, video: () => null, duration: () => null };

function render(objects: unknown[], seconds = 0, extra: object = {}) {
	const document = {
		version: 1,
		stage: { children: [{ kind: 'scene', id: 'sc', width: 200, height: 200, fill: '#000000', children: [{ kind: 'scene3d', width: 200, height: 200, objects, ...extra }] }] },
	} as unknown as ClipDocument;
	const renderer = createRenderer(document, NO_MEDIA);
	const canvas = createCanvas(200, 200);
	renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(seconds));
	const ctx = canvas.getContext('2d');
	return (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}

describe('scene3d', () => {
	it('khối ở gốc hiện ở giữa khung, được tô sáng (không đen, không nguyên màu)', () => {
		const at = render([{ type: 'cube', size: 3, color: '#FF0000' }]);
		const [r, g, b] = at(100, 100);
		expect(r).toBeGreaterThan(60);
		expect(g).toBeLessThan(20);
		expect(b).toBeLessThan(20);
		expect(at(5, 5)).toEqual([0, 0, 0]);
	});

	it('mặt gần che mặt xa (painter): cầu đỏ trước cầu xanh', () => {
		// Camera nhìn từ −y (theta −90°, phi 90°): cầu ở y = −2 gần hơn.
		const at = render(
			[
				{ type: 'sphere', radius: 1, position: [0, 2, 0], color: '#0000FF' },
				{ type: 'sphere', radius: 1, position: [0, -2, 0], color: '#FF0000' },
			],
			0,
			{ camera: { phi: 90, theta: -90, distance: 10 } },
		);
		const [r, , b] = at(100, 100);
		expect(r).toBeGreaterThan(b);
	});

	it('progress 0 → không vẽ gì; opacity 0 → không vẽ gì', () => {
		const hidden = render([{ type: 'cube', size: 3, tracks: [{ property: 'progress', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] }]);
		expect(hidden(100, 100)).toEqual([0, 0, 0]);
		expect(render([{ type: 'cube', size: 3, opacity: 0 }])(100, 100)).toEqual([0, 0, 0]);
	});

	it('lưới: lập phương 6 mặt, mặt cong theo công thức, t đổi hình', () => {
		expect(cube(2).faces).toHaveLength(6);
		const flat = surface('0', [-1, 1], [-1, 1], 4, 0);
		expect(flat.faces).toHaveLength(16);
		const wave0 = surface('sin(x + t)', [0, 1], [0, 1], 2, 0).faces[0]!.rings[0]![0]![2];
		const wave1 = surface('sin(x + t)', [0, 1], [0, 1], 2, 1).faces[0]!.rings[0]![0]![2];
		expect(wave0).toBeCloseTo(0);
		expect(wave1).toBeCloseTo(Math.sin(1));
	});
});

describe('ngân sách mặt (stress 29/09)', async () => {
	const { FACE_BUDGET, sceneMeshes } = await import('./three/render.ts');
	it('vượt ngân sách thì giảm độ chia đều, không vật nào mất mặt', () => {
		const objects = Array.from({ length: 64 }, (_, k) => ({ type: 'sphere' as const, radius: 0.3, resolution: 24, position: [k % 8, Math.floor(k / 8), 0] as [number, number, number] }));
		const meshes = sceneMeshes({ kind: 'scene3d', objects } as never, 0);
		const total = meshes.reduce((sum, mesh) => sum + mesh.faces.length, 0);
		expect(total).toBeLessThanOrEqual(FACE_BUDGET * 1.1);
		for (const mesh of meshes) expect(mesh.faces.length).toBeGreaterThan(8);
	});
	it('trong ngân sách thì giữ nguyên độ chia và dùng lại lưới đã dựng', () => {
		const object = { type: 'torus' as const, resolution: 20 };
		const node = { kind: 'scene3d', objects: [object] } as never;
		const [a] = sceneMeshes(node, 0);
		const [b] = sceneMeshes(node, 1);
		expect(a).toBe(b);
	});
});
