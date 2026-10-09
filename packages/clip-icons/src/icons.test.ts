import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parsePath, pathBounds } from '@opencmo/clip-doc';

import { findIcons, iconCount, iconPath } from './index.ts';

describe('clip-icons', () => {
	it('mọi icon đọc được bằng parser của clip-doc và nằm trong hộp 24×24', async () => {
		const { icons } = JSON.parse(readFileSync(new URL('../data/icons.json', import.meta.url), 'utf8')) as { icons: Record<string, { d: string }> };
		const bad: string[] = [];
		for (const [name, icon] of Object.entries(icons)) {
			try {
				const bounds = pathBounds(parsePath(icon.d));
				if (bounds.x < -1 || bounds.y < -1 || bounds.x + bounds.width > 25 || bounds.y + bounds.height > 25) bad.push(`${name}: out of box`);
			} catch (error) {
				bad.push(`${name}: ${(error as Error).message}`);
			}
		}
		expect(bad).toEqual([]);
		expect(await iconCount()).toBeGreaterThan(1500);
	});

	it('tìm theo tên và tag; nhiều từ khớp mọi từ', async () => {
		expect((await findIcons('bow arrow'))[0]?.name).toBe('bow-arrow');
		expect((await findIcons('rotate')).map((icon) => icon.name)).toContain('rotate-cw');
		expect((await findIcons('person')).length).toBeGreaterThan(0);
		expect(await findIcons('')).toEqual([]);
		expect(await iconPath('rocket')).toMatch(/^M/);
		expect(await iconPath('no-such-icon')).toBeNull();
	});

	it('giữ giấy phép ISC của Lucide đi kèm dữ liệu', () => {
		expect(readFileSync(new URL('../data/LUCIDE-LICENSE', import.meta.url), 'utf8')).toMatch(/ISC License/);
	});
});
