import { describe, expect, it } from 'vitest';

import { validate, type ClipDocument } from '@opencmo/clip-doc';

import { checkDocument } from './check';
import { applyOps, type OpContext } from './ops';
import { formatValue } from './visuals/chart';
import { parseGraph as parseExpr } from './visuals/graph';
import { wrapLabel } from './visuals/common';
import { BUILTIN_LOTTIES, findLotties } from './visuals/lottie';
import { existsSync } from 'node:fs';

const ctx = { master: { width: 1920, height: 1080 }, readTranscript: async () => [], saveTranscript: async () => 'x' } as unknown as OpContext;
const base = {
	version: 1,
	stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, fill: '#000000', workarea: [0, 10], active: true, children: [] }] },
} as unknown as ClipDocument;

type Entity = Record<string, unknown> & { children?: Entity[] };
const scene = (document: ClipDocument) => document.stage.children[0] as unknown as Entity;
const lastChild = (document: ClipDocument) => scene(document).children!.at(-1)!;

describe('op visual', () => {
	it('mỗi loại dựng ra document hợp lệ, check không báo lỗi', async () => {
		const ops = [
			{ op: 'add_shape', start: 0, end: 3, shape: 'arrow', from: [0.1, 0.2], to: [0.6, 0.3] },
			{ op: 'add_shape', start: 0, end: 3, shape: 'highlight', box: { x: 0.1, y: 0.5, width: 0.5, height: 0.05 } },
			{ op: 'add_diagram', start: 1, end: 6, nodes: [{ label: 'Plan' }, { label: 'Build' }, { label: 'Ship' }] },
			{ op: 'add_diagram', start: 1, end: 6, layout: 'compare', nodes: [{ label: 'A', items: ['x'] }, { label: 'B', items: ['y', 'z'] }] },
			{ op: 'add_chart', start: 2, end: 7, type: 'bar', data: [{ label: 'a', value: 3 }, { label: 'b', value: -1 }] },
			{ op: 'add_chart', start: 2, end: 7, type: 'donut', data: [{ label: 'yes', value: 7 }, { label: 'no', value: 3 }] },
			{ op: 'add_chart', start: 2, end: 7, type: 'stat', unit: '%', data: [{ label: 'up', value: 47 }] },
			{ op: 'add_graph', start: 3, end: 9, expr: '1/x', x: [-4, 4] },
		];
		const { document } = await applyOps(base, ops as never, ctx);
		expect(() => validate(document)).not.toThrow();
		expect(scene(document).children).toHaveLength(ops.length);
		const report = checkDocument(document, { duration: () => null });
		expect(report.issues.filter((issue) => issue.severity === 'error' && issue.code !== 'no-visuals' && issue.code !== 'black-gap')).toEqual([]);
	});

	it('visual là group có mark để sửa lại; path có hộp bao riêng', async () => {
		const { document } = await applyOps(base, [{ op: 'add_diagram', start: 1, end: 5, nodes: [{ label: 'One' }, { label: 'Two' }] }] as never, ctx);
		const group = lastChild(document);
		expect(group.kind).toBe('group');
		expect(group.start).toBe(1);
		expect(group.end).toBe(5);
		expect((group.marks as { visual: { op: string } }).visual.op).toBe('add_diagram');
		const path = group.children!.find((child) => child.kind === 'path')!;
		expect(path.viewBox).toEqual([path.x, path.y, path.width, path.height]);
	});

	it('update_visual sinh lại với nhãn mới, giữ id và thời gian', async () => {
		const first = await applyOps(base, [{ op: 'add_diagram', start: 1, end: 5, nodes: [{ label: 'One' }, { label: 'Two' }] }] as never, ctx);
		const id = lastChild(first.document).id as string;
		const { document } = await applyOps(first.document, [{ op: 'update_visual', id, changes: { nodes: [{ label: 'Uno' }, { label: 'Dos' }, { label: 'Tres' }] } }] as never, ctx);
		const group = lastChild(document);
		expect(group.id).toBe(id);
		expect(group.start).toBe(1);
		const texts = group.children!.filter((child) => child.kind === 'text').map((child) => child.text);
		expect(texts).toEqual(['Uno', 'Dos', 'Tres']);
		await expect(applyOps(document, [{ op: 'update_visual', id, changes: { layout: 'spiral' } }] as never, ctx)).rejects.toThrow();
		// Kéo + đổi cỡ bằng tay rồi sửa nhãn: vị trí và cỡ còn nguyên.
		const moved = await applyOps(document, [{ op: 'set_props', element_id: id, props: { x: 120, y: -40, scale: 0.8 } }] as never, ctx);
		const again = await applyOps(moved.document, [{ op: 'update_visual', id, changes: { nodes: [{ label: 'A' }, { label: 'B' }] } }] as never, ctx);
		expect(lastChild(again.document)).toMatchObject({ x: 120, y: -40, scale: 0.8 });
		await expect(applyOps(document, [{ op: 'update_visual', id: 'sc', changes: {} }] as never, ctx)).rejects.toThrow(/not a visual/);
	});

	it('stagger: trễ so le, chạy lại không chồng animation', async () => {
		const first = await applyOps(base, [{ op: 'add_diagram', start: 0, end: 5, build: false, nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }] as never, ctx);
		const ids = lastChild(first.document).children!.filter((child) => child.kind === 'text').map((child) => child.id as string);
		const stagger = { op: 'stagger', element_ids: ids, type: 'slideUp', step: 0.2, delay: 0.5 };
		const once = await applyOps(first.document, [stagger] as never, ctx);
		const twice = await applyOps(once.document, [stagger] as never, ctx);
		const delays = lastChild(twice.document).children!.filter((child) => child.kind === 'text').map((child) => (child.animations as { delay?: number }[]).map((a) => a.delay));
		expect(delays).toEqual([[0.5], [0.7], [0.9]]);
	});

	it('lỗi đọc được: công thức sai, thời gian ngoài clip, cạnh trỏ ô không có', async () => {
		await expect(applyOps(base, [{ op: 'add_graph', start: 0, end: 3, expr: 'x^^2' }] as never, ctx)).rejects.toThrow();
		await expect(applyOps(base, [{ op: 'add_chart', start: 12, end: 14, type: 'stat', data: [{ label: '', value: 1 }] }] as never, ctx)).rejects.toThrow(/inside the clip/);
		await expect(applyOps(base, [{ op: 'add_diagram', start: 0, end: 3, nodes: [{ label: 'A' }], edges: [{ from: 0, to: 4 }] }] as never, ctx)).rejects.toThrow();
	});
});

describe('parseExpr', () => {
	it('toán tử, ưu tiên, nhân ngầm, hàm, hằng', () => {
		const f = (source: string, x: number) => parseExpr(source)(x);
		expect(f('x^2', 3)).toBe(9);
		expect(f('2x+1', 3)).toBe(7);
		expect(f('-x^2', 3)).toBe(-9);
		expect(f('2^3^2', 0)).toBe(512);
		expect(f('3(x+1)', 1)).toBe(6);
		expect(f('sin(pi/2)', 0)).toBeCloseTo(1);
		expect(f('x sin(x)', Math.PI / 2)).toBeCloseTo(Math.PI / 2);
		expect(f('sqrt(abs(x))', -16)).toBe(4);
	});

	it('từ chối thứ không phải công thức — không eval', () => {
		expect(() => parseExpr('alert(1)')).toThrow(/Unknown name/);
		expect(() => parseExpr('x;1')).toThrow(/Unexpected/);
		expect(() => parseExpr('(x+1')).toThrow(/not closed/);
		expect(() => parseExpr('')).toThrow();
	});
});

describe('phụ trợ', () => {
	it('số rút gọn, nhãn ngắt dòng cân', () => {
		expect(formatValue(1_234_567)).toBe('1.2M');
		expect(formatValue(12_500, ' views')).toBe('12.5k views');
		expect(formatValue(47, '%')).toBe('47%');
		expect(wrapLabel('Cut the best part')).toEqual(['Cut the', 'best part']);
		expect(wrapLabel('Short')).toEqual(['Short']);
	});
});

describe('add_3d', () => {
	it('đặt scene3d trong vùng, schema kiểm công thức', async () => {
		const { document } = await applyOps(base, [{ op: 'add_3d', start: 0, end: 4, title: 'Waves', objects: [{ type: 'axes' }, { type: 'surface', expr: 'sin(x) cos(y)' }], camera: { orbit: 15 } }] as never, ctx);
		const group = lastChild(document);
		const node = group.children!.find((child) => child.kind === 'scene3d')!;
		expect((node.objects as unknown[]).length).toBe(2);
		expect(() => validate(document)).not.toThrow();
		await expect(applyOps(base, [{ op: 'add_3d', start: 0, end: 4, objects: [{ type: 'surface', expr: 'import(x)' }] }] as never, ctx)).rejects.toThrow();
	});
});

describe('add_icon', () => {
	it('icon Lucide thành path 24×24, motion là keyframe', async () => {
		const { document } = await applyOps(base, [
			{ op: 'add_icon', start: 0, end: 4, name: 'rotate-cw', motion: 'spin', period: 2 },
			{ op: 'add_icon', start: 0, end: 4, name: 'move-right', at: [0.2, 0.3], to: [0.8, 0.3], motion: 'fly', orient: true },
			{ op: 'add_icon', start: 0, end: 4, name: 'person-standing', motion: 'bounce', label: 'You' },
		] as never, ctx);
		expect(() => validate(document)).not.toThrow();
		const [spin, fly, bounce] = scene(document).children!.map((group) => group.children![0]!);
		expect(spin).toMatchObject({ kind: 'path', viewBox: [0, 0, 24, 24] });
		// Quay đều: một đoạn từ 0 tới 2 vòng trong 4 giây, chu kỳ 2 giây.
		const rotation = (spin!.tracks as { property: string; keyframes: { value: number }[] }[]).find((t) => t.property === 'rotation')!;
		expect(rotation.keyframes.map((k) => k.value)).toEqual([0, 720]);
		const tracks = (fly!.tracks as { property: string; keyframes: { value: number }[] }[]).map((t) => t.property);
		expect(tracks).toEqual(expect.arrayContaining(['x', 'y', 'rotation']));
		const xs = (fly!.tracks as { property: string; keyframes: { value: number }[] }[]).find((t) => t.property === 'x')!.keyframes;
		expect(xs.at(-1)!.value).toBeGreaterThan(xs[0]!.value);
		expect(scene(document).children![2]!.children!.some((child) => child.kind === 'text' && child.text === 'You')).toBe(true);
		expect((bounce!.tracks as { property: string }[]).some((t) => t.property === 'y')).toBe(true);
	});

	it('tên icon sai và fly thiếu điểm đến báo lỗi đọc được', async () => {
		await expect(applyOps(base, [{ op: 'add_icon', start: 0, end: 2, name: 'no-such-icon' }] as never, ctx)).rejects.toThrow(/find_icons/);
		await expect(applyOps(base, [{ op: 'add_icon', start: 0, end: 2, name: 'rocket', motion: 'fly' }] as never, ctx)).rejects.toThrow(/"to"/);
	});
});

describe('ca biên (review 29/09)', () => {
	type Track = { property: string; keyframes: { time: number; value: number }[] };
	it('fly ngược chiều có cong: góc không nhảy ±360 giữa hai mốc', async () => {
		const { document } = await applyOps(base, [
			{ op: 'add_icon', start: 0, end: 3, name: 'arrow-right', at: [0.8, 0.5], to: [0.2, 0.5], bend: 0.6, motion: 'fly', orient: true },
		] as never, ctx);
		const icon = scene(document).children![0]!.children![0]!;
		const angles = (icon.tracks as Track[]).find((t) => t.property === 'rotation')!.keyframes.map((k) => k.value);
		for (let k = 1; k < angles.length; k++) expect(Math.abs(angles[k]! - angles[k - 1]!)).toBeLessThan(90);
	});

	it('chu kỳ ngắn trên visual dài: chuyển động kéo tới hết, không đứng im giữa chừng', async () => {
		const { document } = await applyOps(base, [{ op: 'add_icon', start: 0, end: 10, name: 'star', motion: 'orbit', period: 0.2 }] as never, ctx);
		const icon = scene(document).children![0]!.children![0]!;
		const xs = (icon.tracks as Track[]).find((t) => t.property === 'x')!.keyframes;
		expect(xs.length).toBeLessThanOrEqual(401);
		expect(xs.at(-1)!.time).toBeGreaterThan(9.5);
	});

	it('mask khung của add_graph nằm đúng khung đồ thị (toạ độ của path)', async () => {
		const { document } = await applyOps(base, [{ op: 'add_graph', start: 0, end: 4, expr: 'sin(x)', x_range: [-6, 6] }] as never, ctx);
		const curve = scene(document).children![0]!.children!.find((child) => Array.isArray(child.masks))!;
		const mask = (curve.masks as Record<string, number>[])[0]!;
		// Mask theo toạ độ của path: gốc path + mask phải chứa trọn đường cong.
		const [vx, vy, vw, vh] = curve.viewBox as number[];
		expect(mask.x).toBeLessThanOrEqual(0.5);
		expect(mask.y).toBeLessThanOrEqual(0.5);
		expect(mask.x + mask.width).toBeGreaterThanOrEqual(vw! - 0.5);
		expect(mask.y + mask.height).toBeGreaterThanOrEqual(vh! - 0.5);
		expect(vx! + mask.x).toBeGreaterThan(0);
		expect(vy! + mask.y).toBeGreaterThan(0);
	});
});

describe('add_lottie', () => {
	it('bộ có sẵn thành node lottie builtin:, file thư viện giữ path; lật + nhãn', async () => {
		const { document } = await applyOps(base, [
			{ op: 'add_lottie', start: 0, end: 3, animation: 'walk', flip: true, speed: 1.5, label: 'Day one' },
			{ op: 'add_lottie', start: 1, end: 3, animation: 'folder/rocket.json', loop: false },
		] as never, ctx);
		expect(() => validate(document)).not.toThrow();
		const [walk, upload] = scene(document).children!;
		expect(walk!.children![0]).toMatchObject({ kind: 'lottie', src: 'builtin:walk', speed: 1.5, scaleX: -1 });
		expect(walk!.children!.some((child) => child.kind === 'text' && child.text === 'Day one')).toBe(true);
		expect(upload!.children![0]).toMatchObject({ kind: 'lottie', src: 'folder/rocket.json', loop: false });
	});

	it('tên lạ báo lỗi kèm danh sách; tìm theo tag', async () => {
		await expect(applyOps(base, [{ op: 'add_lottie', start: 0, end: 2, animation: 'dance' }] as never, ctx)).rejects.toThrow(/walk, run/);
		expect(findLotties('celebrate win').map((entry) => entry.name)).toEqual(expect.arrayContaining(['cheer', 'confetti']));
	});

	it('emoji Noto: builtin:emoji/<tên>, tìm theo nghĩa, tên duy nhất và có file', async () => {
		const { document } = await applyOps(base, [{ op: 'add_lottie', start: 0, end: 2, animation: 'emoji/fire', size: 0.25 }] as never, ctx);
		expect(scene(document).children![0]!.children![0]).toMatchObject({ kind: 'lottie', src: 'builtin:emoji/fire' });
		expect(findLotties('laugh funny').slice(0, 3).map((entry) => entry.name)).toEqual(expect.arrayContaining(['emoji/joy']));
		expect(findLotties('idea')[0]!.name).toMatch(/lightbulb|light-bulb/);
		const names = BUILTIN_LOTTIES().map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		// Danh mục khớp file đã tải/sinh: tên nào thiếu file là nút bấm ra ô "thiếu media".
		const root = new URL('../../clip-media/lottie/', import.meta.url);
		const missing = names.filter((name) => !existsSync(new URL(`${name}.json`, root)));
		expect(missing).toEqual([]);
	});
});
