import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { formatValue, frameCount, PRODUCTS, SceneSpecSchema } from './spec.ts';

const base = { duration: 4, width: 128, height: 128 };

describe('spec', () => {
	it('mỗi template đòi đúng dữ liệu của nó', () => {
		expect(() => SceneSpecSchema.parse({ ...base, template: 'bars' })).toThrow(/bars/);
		expect(() => SceneSpecSchema.parse({ ...base, template: 'number' })).toThrow(/value/);
		expect(() => SceneSpecSchema.parse({ ...base, template: 'rise', points: [1, 2] })).toThrow();
		expect(() => SceneSpecSchema.parse({ ...base, template: 'product', object: 'car' })).toThrow();
		expect(SceneSpecSchema.parse({ ...base, template: 'number', value: 42 }).value).toBe(42);
	});
	it('cỡ khung chẵn (H.264 yuv420p)', () => {
		expect(() => SceneSpecSchema.parse({ ...base, width: 129, template: 'number', value: 1 })).toThrow(/even/);
	});
	it('số đọc như người: K/M/B, dấu phẩy nghìn', () => {
		expect(formatValue(1234)).toBe('1,234');
		expect(formatValue(98000)).toBe('98K');
		expect(formatValue(2_400_000)).toBe('2.4M');
		expect(formatValue(3_000_000_000)).toBe('3B');
		expect(formatValue(12.5, 1)).toBe('12.5');
		expect(frameCount({ duration: 4 })).toBe(120);
	});
});

// Vẽ thật trong Chromium (SwiftShader): chỉ chạy khi máy có Chromium của Playwright.
const chromium = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
describe.skipIf(!existsSync(chromium))('render (Chromium)', () => {
	it('mọi template + mọi vật thể vẽ ra ảnh không trống', { timeout: 240_000 }, async () => {
		const { renderStills } = await import('./render.ts');
		const specs = [
			{ ...base, template: 'bars', bars: [{ label: 'A', value: 1 }, { label: 'B', value: 3, highlight: true }], title: 'Tiêu đề Việt' },
			{ ...base, template: 'number', value: 2_400_000, prefix: '$', label: 'raised' },
			{ ...base, template: 'rise', points: [1, 3, 2, 8] },
			...PRODUCTS.map((object) => ({ ...base, template: 'product', object, label: object })),
		];
		for (const spec of specs) {
			const [png] = await renderStills(spec as never, [2.5]);
			// PNG 128² có nội dung thì nặng hơn nhiều so với ảnh một màu.
			expect(png!.length, `${spec.template}/${(spec as { object?: string }).object ?? ''}`).toBeGreaterThan(8_000);
		}
	});
});
