/**
 * Tải thêm họ font OFL tự host cho Brand Kit (spec brand-kit BK2) — chạy một
 * lần, kết quả commit vào `packages/clip-media/fonts`:
 *
 *   npx tsx scripts/fetch-fonts.mts            # tải + đo, in các dòng cho FONTS
 *
 * Giống 10 họ có sẵn: một file woff2 subset `latin` mỗi họ, bản VARIABLE nếu
 * Google có (một file phủ cả dải weight), không thì bản đơn weight của font
 * display. `emTop` đo bằng Chromium (chú thích ở `clip-render/src/fonts.ts`) —
 * không tự tính. Giấy phép: OFL.txt của từng họ gộp vào `LICENSE-OFL.txt`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'clip-media', 'fonts');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** [tên họ, trục wght trong URL css2 (null = đơn weight), thư mục trong google/fonts]. */
const FAMILIES: [string, string | null, string][] = [
	['Anton', null, 'anton'],
	['Bebas Neue', null, 'bebasneue'],
	['Archivo Black', null, 'archivoblack'],
	['DM Serif Display', null, 'dmserifdisplay'],
	['Caveat Brush', null, 'caveatbrush'],
	['Pacifico', null, 'pacifico'],
	['Oswald', '200..700', 'oswald'],
	['Raleway', '100..900', 'raleway'],
	['Rubik', '300..900', 'rubik'],
	['Work Sans', '100..900', 'worksans'],
	['Manrope', '200..800', 'manrope'],
	['Plus Jakarta Sans', '200..800', 'plusjakartasans'],
	['Sora', '100..800', 'sora'],
	['Outfit', '100..900', 'outfit'],
	['Lexend', '100..900', 'lexend'],
	['Space Grotesk', '300..700', 'spacegrotesk'],
	['DM Sans', '100..1000', 'dmsans'],
	['Playfair Display', '400..900', 'playfairdisplay'],
	['Archivo', '100..900', 'archivo'],
	['Unbounded', '200..900', 'unbounded'],
	['Fraunces', '100..900', 'fraunces'],
	['Caveat', '400..700', 'caveat'],
];

const slug = (family: string) => family.toLowerCase().replace(/\s+/g, '-');

async function latinFace(family: string, axis: string | null): Promise<{ url: string; weights: [number, number] }> {
	const query = `${family.replace(/ /g, '+')}${axis ? `:wght@${axis}` : ''}`;
	const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=swap`, { headers: { 'user-agent': UA } })).text();
	const block = css.split('/* latin */')[1];
	if (!block) throw new Error(`${family}: không có subset latin`);
	const url = /src: url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
	const weight = /font-weight: (\d+)(?: (\d+))?;/.exec(block);
	if (!url || !weight) throw new Error(`${family}: không đọc được @font-face`);
	return { url, weights: [Number(weight[1]), Number(weight[2] ?? weight[1])] };
}

const entries: string[] = [];
const licenses: string[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.setContent('<!doctype html><canvas></canvas>');

for (const [family, axis, dir] of FAMILIES) {
	const file = `${slug(family)}.woff2`;
	const face = await latinFace(family, axis);
	const path = join(OUT, file);
	if (!existsSync(path)) writeFileSync(path, Buffer.from(await (await fetch(face.url)).arrayBuffer()));
	const bytes = [...readFileSync(path)];
	const emTop = await page.evaluate(
		async ([name, data]) => {
			const font = new FontFace(name as string, new Uint8Array(data as number[]));
			await font.load();
			document.fonts.add(font);
			const ctx = document.querySelector('canvas')!.getContext('2d')!;
			ctx.font = `100px "${name as string}"`;
			ctx.textBaseline = 'top';
			return Math.round((Math.abs(ctx.measureText('H').alphabeticBaseline) / 100) * 10000) / 10000;
		},
		[family, bytes] as const,
	);
	entries.push(`  '${family}': { file: '${file}', weights: [${face.weights[0]}, ${face.weights[1]}], emTop: ${emTop} },`);
	const ofl = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`);
	if (!ofl.ok) throw new Error(`${family}: không tải được OFL.txt (${ofl.status})`);
	licenses.push(`===== ${family} (${file}) =====\n\n${(await ofl.text()).trim()}\n`);
	console.error(`${family}: ${file} ${face.weights.join('–')} emTop ${emTop}`);
}
await browser.close();

writeFileSync(
	join(OUT, 'LICENSE-OFL.txt'),
	`Các font dưới đây phát hành theo SIL Open Font License 1.1, tải từ Google Fonts\n(bản subset latin), tự host cho clip của OpenCMO.\n\n${licenses.join('\n')}`,
);
console.log(entries.join('\n'));
