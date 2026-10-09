/**
 * Font tiêu đề của Brand Kit cho chữ 3D (spec brand-kit BK4): đọc CÙNG file woff2
 * mà editor và exporter 2D dùng (`packages/clip-media/fonts`, `OPENCMO_EDITOR_FONTS`),
 * lấy instance đậm của font variable, rồi dựng JSON "typeface" của three chỉ cho
 * các ký tự cảnh cần — vài chục glyph, nhỏ.
 *
 * Chỉ chạy ở Node (renderer), không vào bundle của trang.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fontkit from 'fontkit';
import { decompress } from 'wawoff2';

import type { SceneSpec } from './spec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR = process.env.OPENCMO_EDITOR_FONTS ?? join(HERE, '..', '..', 'clip-media', 'fonts');

/** Chữ số + dấu của số liệu luôn có (số đếm lên đi qua mọi giá trị trung gian). */
const ALWAYS = ' 0123456789.,:%$€£¥+-–—/()KMB';

/** Tên họ → file, cùng quy ước của `clip-render/src/fonts.ts` (chữ thường, cách → gạch). */
export const fontFile = (family: string): string => join(FONTS_DIR, `${family.toLowerCase().replace(/\s+/g, '-')}.woff2`);

/** Mọi ký tự cảnh có thể vẽ bằng font tiêu đề. */
export function sceneChars(spec: SceneSpec): string {
	// Cảnh code: chữ nằm trong code, nên spec khai `glyphs` (mọi chữ cảnh vẽ ra).
	const texts = [spec.title, spec.label, spec.prefix, spec.suffix, spec.glyphs, ...(spec.bars ?? []).map((bar) => bar.label)];
	return [...new Set([...ALWAYS, ...texts.filter(Boolean).join('')])].join('');
}

type Command = { command: string; args: number[] };

/**
 * JSON typeface (định dạng `FontLoader.parse`) — cùng cách đổi lệnh vẽ như
 * `scripts/build-fonts.mts`. `q`/`b` ghi điểm CUỐI trước điểm điều khiển.
 */
export async function brandTypeface(family: string, chars: string, weight = 800): Promise<unknown | null> {
	const file = fontFile(family);
	if (!existsSync(file)) return null;
	// fontkit đọc được woff2 nhưng `getVariation` trên woff2 mất bảng cmap: giải nén sang TTF trước.
	const ttf = Buffer.from(await decompress(readFileSync(file)));
	const base = fontkit.create(ttf) as fontkit.Font;
	const axis = (base.variationAxes as Record<string, { min: number; max: number }> | undefined)?.wght;
	const font = axis ? base.getVariation({ wght: Math.min(axis.max, Math.max(axis.min, weight)) }) : base;
	const scale = 100000 / (font.unitsPerEm * 72);
	const n = (value: number) => Math.round(value * scale);
	const glyphs: Record<string, { ha: number; x_min: number; x_max: number; o: string }> = {};
	for (const char of chars) {
		const glyph = font.glyphForCodePoint(char.codePointAt(0)!);
		if (!glyph || glyph.id === 0) continue;
		const out: string[] = [];
		for (const { command, args } of glyph.path.commands as Command[]) {
			const p = (i: number) => `${n(args[i]!)} ${n(args[i + 1]!)}`;
			if (command === 'moveTo') out.push(`m ${p(0)}`);
			else if (command === 'lineTo') out.push(`l ${p(0)}`);
			else if (command === 'quadraticCurveTo') out.push(`q ${p(2)} ${p(0)}`);
			else if (command === 'bezierCurveTo') out.push(`b ${p(4)} ${p(0)} ${p(2)}`);
		}
		const box = glyph.bbox;
		glyphs[char] = { ha: n(glyph.advanceWidth), x_min: n(box.minX), x_max: n(box.maxX), o: out.join(' ') };
	}
	return {
		glyphs,
		familyName: family,
		ascender: n(font.ascent),
		descender: n(font.descent),
		underlinePosition: n(font.underlinePosition),
		underlineThickness: n(font.underlineThickness),
		boundingBox: { xMin: n(font.bbox.minX), yMin: n(font.bbox.minY), xMax: n(font.bbox.maxX), yMax: n(font.bbox.maxY) },
		resolution: 1000,
	};
}
