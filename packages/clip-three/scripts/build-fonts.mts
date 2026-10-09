/**
 * Font TTF → JSON "typeface" của three (`FontLoader.parse`) cho chữ 3D đùn
 * khối. Chạy tay khi đổi font:
 *
 *   npx tsx packages/clip-three/scripts/build-fonts.mts
 *
 * Tải font lúc render (TTFLoader) cần opentype.js trong trang và mạng; sinh sẵn
 * một lần thì trang render chạy offline trên Modal. Chỉ lấy bộ ký tự Latin +
 * số + dấu hay gặp trong số liệu — đủ cho nhãn và con số, file nhỏ.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHARS =
	' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz{|}~€£¥×÷±°…–—’“”·→←↑↓ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư';

for (const [file, out] of [
	['montserrat-800.ttf', 'montserrat-800.json'],
	['inter-600.ttf', 'inter-600.json'],
]) {
	const buffer = readFileSync(join(HERE, '..', 'fonts', file));
	const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
	const scale = 100000 / ((font.unitsPerEm || 2048) * 72);
	const glyphs: Record<string, { ha: number; x_min: number; x_max: number; o: string }> = {};
	for (const char of CHARS) {
		const glyph = font.charToGlyph(char);
		if (!glyph || glyph.index === 0) continue;
		const commands: string[] = [];
		for (const c of glyph.path.commands) {
			const p = (x: number, y: number) => `${Math.round(x * scale)} ${Math.round(y * scale)}`;
			if (c.type === 'M') commands.push(`m ${p(c.x, c.y)}`);
			else if (c.type === 'L') commands.push(`l ${p(c.x, c.y)}`);
			else if (c.type === 'Q') commands.push(`q ${p(c.x, c.y)} ${p(c.x1, c.y1)}`);
			else if (c.type === 'C') commands.push(`b ${p(c.x, c.y)} ${p(c.x1, c.y1)} ${p(c.x2, c.y2)}`);
		}
		const box = glyph.getBoundingBox();
		glyphs[char] = { ha: Math.round((glyph.advanceWidth ?? 0) * scale), x_min: Math.round(box.x1 * scale), x_max: Math.round(box.x2 * scale), o: commands.join(' ') };
	}
	const json = {
		glyphs,
		familyName: font.names.fontFamily?.en ?? file,
		ascender: Math.round(font.ascender * scale),
		descender: Math.round(font.descender * scale),
		underlinePosition: Math.round((font.tables.post?.underlinePosition ?? 0) * scale),
		underlineThickness: Math.round((font.tables.post?.underlineThickness ?? 0) * scale),
		boundingBox: { xMin: Math.round(font.tables.head.xMin * scale), yMin: Math.round(font.tables.head.yMin * scale), xMax: Math.round(font.tables.head.xMax * scale), yMax: Math.round(font.tables.head.yMax * scale) },
		resolution: 1000,
		original_font_information: font.tables.name,
	};
	writeFileSync(join(HERE, '..', 'src', 'fonts', out), JSON.stringify(json));
	console.log(out, Object.keys(glyphs).length, 'glyph');
}
