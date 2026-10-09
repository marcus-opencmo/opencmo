/** Bước 0: thời gian từng khâu của đường export 3D (cảnh `number`, 1080×1920): vẽ, readPixels, POST, ffmpeg. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright-core';

import { chromiumArgs, pageBundle } from '../src/render.ts';

const W = 1080, H = 1920, FRAMES = 90;
const ffmpeg = process.env.BENCH_FFMPEG === '1';
const encoder = ffmpeg
	? spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', '30', '-i', 'pipe:0', '-vf', 'vflip,format=yuv420p', '-c:v', 'libx264', '-preset', process.env.BENCH_PRESET ?? 'medium', '-crf', '16', '/tmp/bench.mp4'], { stdio: ['pipe', 'ignore', 'inherit'] })
	: null;
const html = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${await pageBundle()}</script></body>`;
const server = createServer((request, response) => {
	if (request.method === 'GET') {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end(html);
		return;
	}
	request.on('data', (chunk: Buffer) => {
		if (encoder && !encoder.stdin.write(chunk)) {
			request.pause();
			encoder.stdin.once('drain', () => request.resume());
		}
	});
	request.on('end', () => {
		response.writeHead(204, { 'access-control-allow-origin': '*' });
		response.end();
	});
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/frame`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: chromiumArgs(process.env.OPENCMO_3D_GPU === '1') });
try {
	const page = await browser.newPage();
	await page.goto(endpoint.replace('/frame', '/'));
	const parts = await page.evaluate(async ([w, h, url]) => {
		const canvas = document.createElement('canvas');
		canvas.width = w as number;
		canvas.height = h as number;
		const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })!;
		const px = new Uint8Array((w as number) * (h as number) * 4);
		let t = performance.now();
		for (let i = 0; i < 20; i++) {
			gl.clearColor(i / 20, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.readPixels(0, 0, w as number, h as number, gl.RGBA, gl.UNSIGNED_BYTE, px);
		}
		const read = (performance.now() - t) / 20;
		t = performance.now();
		for (let i = 0; i < 10; i++) await fetch(`${url}?frame=${i}`, { method: 'POST', body: px });
		const post = (performance.now() - t) / 10;
		t = performance.now();
		for (let i = 0; i < 10; i++) await fetch(`${url}?frame=${i}`, { method: 'POST', body: new Blob([px]) });
		const blob = (performance.now() - t) / 10;
		return { read, post, blob };
	}, [W, H, endpoint] as const);
	console.log(`[bench] readPixels ${parts.read.toFixed(1)} ms · POST Uint8Array ${parts.post.toFixed(0)} ms · POST Blob ${parts.blob.toFixed(0)} ms`);
	if (process.env.BENCH_ONLY_PARTS === '1') process.exit(0);
	const started = Date.now();
	const result = await page.evaluate(([spec, url, frames]) => window.clipThree.render(spec as never, url as string, 0, frames as number), [{ template: 'number', value: 90, label: 'pages in 72 hours', width: W, height: H, duration: 6 }, endpoint, FRAMES] as const);
	console.log(`[bench] ffmpeg=${ffmpeg} preset=${process.env.BENCH_PRESET ?? 'medium'}: ${(result.ms / result.frames).toFixed(0)} ms/khung (${result.frames} khung, ${Date.now() - started} ms)`);
} finally {
	await browser.close();
	server.close();
	encoder?.stdin.end();
}
