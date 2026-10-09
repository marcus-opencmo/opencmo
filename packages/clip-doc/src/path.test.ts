import { describe, expect, it } from 'vitest';

import { parsePath, pathBounds, pathLength, PathSyntaxError, transformPath } from './path.ts';
import { NodeSchema } from './schema.ts';

describe('parsePath', () => {
	it('lệnh tuyệt đối, tương đối, H/V và L ngầm sau M', () => {
		expect(parsePath('M10 10 h 20 v 20 H10 z')).toEqual([
			{ type: 'M', x: 10, y: 10 },
			{ type: 'L', x: 30, y: 10 },
			{ type: 'L', x: 30, y: 30 },
			{ type: 'L', x: 10, y: 30 },
			{ type: 'Z' },
		]);
		// Cặp số sau M là L (tương đối nếu m thường).
		expect(parsePath('m5 5 10 0 0 10')).toEqual([
			{ type: 'M', x: 5, y: 5 },
			{ type: 'L', x: 15, y: 5 },
			{ type: 'L', x: 15, y: 15 },
		]);
	});

	it('S và T phản chiếu điểm điều khiển', () => {
		const [, , s] = parsePath('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
		expect(s).toEqual({ type: 'C', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
		const [, , t] = parsePath('M0 0 Q 5 10 10 0 T 20 0');
		expect(t).toEqual({ type: 'Q', x1: 15, y1: -10, x: 20, y: 0 });
	});

	it('cung A thành cubic, cờ viết dính nhau vẫn đọc được', () => {
		const joined = parsePath('M0 0a5 5 0 1010 0');
		const spaced = parsePath('M0 0 a 5 5 0 1 0 10 0');
		expect(joined).toEqual(spaced);
		expect(spaced.slice(1).every((s) => s.type === 'C')).toBe(true);
		const last = spaced[spaced.length - 1] as { x: number; y: number };
		expect(last.x).toBeCloseTo(10);
		expect(last.y).toBeCloseTo(0);
	});

	it('số dạng .5, 1e2, dấu dính nhau', () => {
		expect(parsePath('M.5-.5L1e1,2')).toEqual([
			{ type: 'M', x: 0.5, y: -0.5 },
			{ type: 'L', x: 10, y: 2 },
		]);
	});

	it('đường hỏng báo lỗi rõ', () => {
		expect(() => parsePath('L 1 2')).toThrow(PathSyntaxError);
		expect(() => parsePath('M 1')).toThrow(/missing a number/);
		expect(() => parsePath('M 0 0 X 3')).toThrow(/Unexpected "X"/);
		expect(() => parsePath('')).toThrow(PathSyntaxError);
		expect(() => parsePath('M0 0 A 5 5 0 2 0 10 0')).toThrow(/Arc flags/);
	});
});

describe('pathLength', () => {
	it('hình vuông đóng, đường tròn từ hai cung', () => {
		expect(pathLength(parsePath('M0 0 H100 V100 H0 Z'))).toBeCloseTo(400);
		const circle = parsePath('M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50');
		expect(pathLength(circle)).toBeCloseTo(2 * Math.PI * 50, 0);
	});

	it('scale theo trục đổi độ dài đúng', () => {
		const line = transformPath(parsePath('M0 0 L10 0'), 3, 1);
		expect(pathLength(line)).toBeCloseTo(30);
		expect(pathBounds(parsePath('M10 20 L30 60'))).toEqual({ x: 10, y: 20, width: 20, height: 40 });
	});
});

describe('schema path', () => {
	it('nhận node path hợp lệ, từ chối d hỏng', () => {
		expect(NodeSchema.safeParse({ kind: 'path', d: 'M0 0 L100 0', trimEnd: 0.5, strokes: [{ color: '#FFFFFF', width: 8 }] }).success).toBe(true);
		const bad = NodeSchema.safeParse({ kind: 'path', d: 'L 1 2' });
		expect(bad.success).toBe(false);
		expect(bad.error?.issues[0]?.message).toMatch(/must start with a move/);
	});
});

describe('trimPath', () => {
	it('cắt theo độ dài, qua nhiều đoạn và giữ cong', async () => {
		const { trimPath } = await import('./path.ts');
		const square = parsePath('M0 0 H100 V100 H0 Z');
		// 0.25–0.625 của chu vi 400 = từ (100,0) đi 150: hết cạnh phải, nửa cạnh dưới.
		expect(trimPath(square, 0.25, 0.625)).toEqual([
			{ type: 'M', x: 100, y: 0 },
			{ type: 'L', x: 100, y: 100 },
			{ type: 'L', x: 50, y: 100 },
		]);
		const curve = parsePath('M0 0 C 0 100 100 100 100 0');
		const half = trimPath(curve, 0, 0.5);
		expect(pathLength(half)).toBeCloseTo(pathLength(curve) / 2, 0);
		const last = half[half.length - 1] as { x: number; y: number };
		// Cong đối xứng: nửa độ dài rơi đúng đỉnh (50, 75).
		expect(last.x).toBeCloseTo(50, 0);
		expect(last.y).toBeCloseTo(75, 0);
	});

	it('đường con vẽ lần lượt: đầu mũi tên chưa hiện khi thân chưa xong', async () => {
		const { trimPath } = await import('./path.ts');
		const arrow = parsePath('M0 0 L100 0 M90 -10 L100 0 L90 10');
		expect(trimPath(arrow, 0, 0.5)).toEqual([
			{ type: 'M', x: 0, y: 0 },
			{ type: 'L', x: expect.closeTo(64.14, 1), y: 0 },
		]);
		expect(trimPath(arrow, 0, 1).filter((s) => s.type === 'M')).toHaveLength(2);
		expect(trimPath(arrow, 0.6, 0.6)).toEqual([]);
	});
});

describe('morphPath', () => {
	it('t=0 và t=1 trùng hai đầu, giữa là trung bình; số đường con khác nhau vẫn nội suy', async () => {
		const { morphPath } = await import('./path.ts');
		const square = parsePath('M0 0 H100 V100 H0 Z');
		const line = parsePath('M0 50 L100 50');
		const at0 = morphPath(square, line, 0);
		const at1 = morphPath(square, line, 1);
		expect(pathBounds(at0)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
		const b1 = pathBounds(at1);
		expect(b1.height).toBeCloseTo(0);
		expect(b1.y).toBeCloseTo(50);
		// Một → hai đường con: đường thứ hai mọc ra từ điểm cuối của đường đầu.
		const two = parsePath('M0 0 L10 0 M20 0 L30 0');
		const start = morphPath(parsePath('M0 0 L10 0'), two, 0).filter((s) => s.type === 'M');
		expect(start).toHaveLength(2);
		expect(start[1]).toEqual({ type: 'M', x: 10, y: 0 });
		expect(morphPath(square, square, 0.5).filter((s) => s.type === 'Z')).toHaveLength(1);
	});
});
