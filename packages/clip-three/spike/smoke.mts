/**
 * SPIKE: Chromium trên container GPU có thật sự vẽ WebGL bằng GPU không, và
 * với cờ nào. In renderer + thời gian một khung cho từng bộ cờ, mỗi bộ có hạn.
 */
import { chromium } from 'playwright-core';

const QUIET = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps'];
const SETS: Record<string, string[]> = {
	'vulkan (production)': ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-vulkan-surface'],
	'egl': ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
	'swiftshader': ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};
const withTimeout = <T,>(promise: Promise<T>, ms: number, what: string) =>
	Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms: ${what}`)), ms))]);

for (const [name, flags] of Object.entries(SETS)) {
	const started = Date.now();
	try {
		const browser = await withTimeout(chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: [...QUIET, ...flags] }), 60_000, 'launch');
		try {
			const page = await browser.newPage();
			const result = await withTimeout(
				page.evaluate(() => {
					const canvas = document.createElement('canvas');
					canvas.width = canvas.height = 1080;
					const gl = canvas.getContext('webgl2');
					if (!gl) return { renderer: 'NO WEBGL2', ms: 0 };
					const info = gl.getExtension('WEBGL_debug_renderer_info');
					const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
					const t = performance.now();
					for (let i = 0; i < 30; i++) {
						gl.clearColor(i / 30, 0, 0, 1);
						gl.clear(gl.COLOR_BUFFER_BIT);
						const px = new Uint8Array(1080 * 1080 * 4);
						gl.readPixels(0, 0, 1080, 1080, gl.RGBA, gl.UNSIGNED_BYTE, px);
					}
					return { renderer, ms: (performance.now() - t) / 30 };
				}),
				60_000,
				'webgl',
			);
			console.log(`[smoke] ${name}: ${result.renderer} · clear+readPixels ${result.ms.toFixed(1)} ms/khung · ${Date.now() - started} ms tổng`);
		} finally {
			await browser.close();
		}
	} catch (error) {
		console.log(`[smoke] ${name}: LỖI ${(error as Error).message}`);
	}
}
