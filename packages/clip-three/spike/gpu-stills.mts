// Chẩn đoán 02/10: cảnh render trên L4 mất nền gradient, sàn phản chiếu, ánh sáng
// môi trường (SwiftShader thì đúng). Dựng cùng một khung với nhiều bộ cờ Chromium,
// in mọi dòng console + renderer, ghi JPEG để so.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { pageBundle } from '../src/render.ts';

const QUIET = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps'];
const SETS: Record<string, string[]> = {
	prod: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-vulkan-surface'],
	norast: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--disable-vulkan-surface'],
	egl: ['--use-angle=gl-egl', '--ignore-gpu-blocklist'],
	swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};
const [codePath, outDir] = process.argv.slice(2);
const code = readFileSync(codePath!, 'utf8');
for (const [name, args] of Object.entries(SETS)) {
	if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue;
	const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: [...QUIET, ...args] });
	try {
		const page = await browser.newPage();
		const lines: string[] = [];
		page.on('console', (m) => lines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
		page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
		await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${await pageBundle()}</script></body>`);
		const gl = await page.evaluate(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const i = c && c.getExtension('WEBGL_debug_renderer_info'); return c ? c.getParameter(i ? i.UNMASKED_RENDERER_WEBGL : c.RENDERER) : 'no webgl2'; })()`);
		const started = Date.now();
		const result = await page.evaluate(([value, at]) => (window as any).clipThree.code(value, at), [{ code, width: Number(process.env.W ?? 540), height: Number(process.env.H ?? 960), duration: 4 }, [3.7]] as const) as any;
		console.log(`\n== ${name}: ${gl} (${Date.now() - started} ms) ok=${result.ok} ${result.ok ? '' : result.message}`);
		for (const line of [...new Set(lines)].slice(0, 25)) console.log('  ' + line);
		if (result.ok) writeFileSync(`${outDir}/${name}.jpg`, Buffer.from(result.images[0].split(',').pop(), 'base64'));
	} finally {
		await browser.close();
	}
}
