/**
 * SPIKE (01/10): Gemini đọc script → viết brief + code three.js → render trên
 * sân khấu studio. Đo: code chạy được ngay / sau 1 lần sửa, ms/khung, ảnh.
 *
 *   GEMINI_API_KEY=… CHROMIUM_PATH=… node spike/run.mts <transcript.json> <out-dir>
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';

import { chromiumArgs } from '../src/render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const [transcriptPath, outDir] = process.argv.slice(2) as [string, string];
const MODEL = process.env.SPIKE_MODEL ?? 'gemini-pro-latest';
const KEY = process.env.GEMINI_API_KEY!;
// 540: đủ để đánh giá hình, nhẹ gấp 4 lần khi vẽ bằng CPU.
const SIZE = Number(process.env.SPIKE_SIZE ?? 540);

type Segment = { text: string; words: { start: number; end: number }[] };
const segments = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Segment[];
const offset = segments[0]!.words[0]!.start;
const script = segments.map((s) => `[${(s.words[0]!.start - offset).toFixed(1)}s] ${s.text}`).join('\n');

const BEATS = [
	{ id: 'staircase', quote: "So I'd start off light, and I'd bump it up in the middle months, and then at the end, I would kick it up into high gear just like a little staircase.", duration: 6 },
	{ id: 'countdown', quote: 'And then two months turned into one month, which turned into two weeks. And one day I woke up with three days until the deadline', duration: 6 },
	{ id: 'all-nighters', quote: 'I wrote 90 pages over 72 hours, pulling not one but two all-nighters', duration: 5 },
];

type Answer = { brief: Record<string, unknown>; code: string };

async function gemini(contents: { role: string; parts: { text: string }[] }[]): Promise<{ answer: Answer; seconds: number }> {
	const started = Date.now();
	const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: readFileSync(join(HERE, 'prompt.md'), 'utf8') }] },
			contents,
			generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
		}),
	});
	if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 400)}`);
	const body = (await response.json()) as { candidates: { content: { parts: { text?: string; thought?: boolean }[] } }[] };
	const text = body.candidates[0]!.content.parts.filter((part) => !part.thought && part.text).map((part) => part.text).join('');
	return { answer: JSON.parse(text) as Answer, seconds: (Date.now() - started) / 1000 };
}

const page = await (async () => {
	const bundle = await build({ entryPoints: [join(HERE, 'code-page.ts')], bundle: true, format: 'iife', write: false, minify: true, loader: { '.json': 'json' }, logLevel: 'silent' });
	return bundle.outputFiles[0]!.text;
})();

async function stills(browserPage: Page, code: string, duration: number) {
	const times = [0.4, duration * 0.3, duration * 0.55, duration * 0.8, duration - 0.05];
	return browserPage.evaluate(([c, d, at, size]) => window.spike.stills(c as string, { width: size as number, height: size as number, duration: d as number }, at as number[]), [code, duration, times, SIZE] as const);
}

async function renderMp4(browserPage: Page, code: string, duration: number, out: string) {
	const encoder = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${SIZE}x${SIZE}`, '-r', '30', '-i', 'pipe:0', '-vf', 'vflip,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'inherit'] });
	const exited = once(encoder, 'close');
	const server = createServer((request, response) => {
		request.on('data', (chunk: Buffer) => {
			if (!encoder.stdin.write(chunk)) {
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
	try {
		const result = await browserPage.evaluate(([c, d, e, size]) => window.spike.render(c as string, { width: size as number, height: size as number, duration: d as number }, e as string), [code, duration, endpoint, SIZE] as const);
		encoder.stdin.end();
		await exited;
		return result;
	} finally {
		server.close();
	}
}

mkdirSync(outDir, { recursive: true });
// Modal L4: OPENCMO_3D_GPU=1 (ANGLE/Vulkan); máy dev thì SwiftShader.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: chromiumArgs(process.env.OPENCMO_3D_GPU === '1') });
const report: Record<string, unknown>[] = [];
try {
	const only = process.env.SPIKE_BEATS?.split(',');
	for (const beat of BEATS.filter((item) => !only || only.includes(item.id))) {
		const browserPage = await browser.newPage();
		const errors: string[] = [];
		browserPage.on('pageerror', (error) => errors.push(error.message));
		await browserPage.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script>${page}</script></body>`);

		const ask = `Full script of the clip:\n${script}\n\nBEAT (the animation plays over these words, ${beat.duration} seconds long):\n"${beat.quote}"`;
		const history = [{ role: 'user', parts: [{ text: ask }] }];
		console.log(`[spike] ${beat.id}: hỏi ${MODEL}…`);
		const first = await gemini(history);
		console.log(`[spike] ${beat.id}: code về sau ${first.seconds.toFixed(0)} s, vẽ thử ảnh tĩnh…`);
		let answer = first.answer;
		let attempts = 1;
		let firstError: string | null = null;
		let shots: Awaited<ReturnType<typeof stills>> | null = null;
		for (;;) {
			try {
				errors.length = 0;
				shots = await stills(browserPage, answer.code, beat.duration);
				console.log(`[spike] ${beat.id}: ảnh tĩnh xong (${Math.round(shots.msPerFrame)} ms/khung)`);
				break;
			} catch (error) {
				const message = `${(error as Error).message}${errors.length ? ` | ${errors.join(' | ')}` : ''}`.slice(0, 1200);
				firstError ??= message;
				if (attempts >= 2) break;
				attempts++;
				console.log(`[spike] ${beat.id}: code lỗi, gửi lỗi cho model sửa: ${message.slice(0, 200)}`);
				// Một lần sửa: trả lỗi thật cho model, như vòng tự sửa của agent.
				history.push({ role: 'model', parts: [{ text: JSON.stringify(answer) }] }, { role: 'user', parts: [{ text: `The code threw when rendering: ${message}\nFix it and return the full JSON again.` }] });
				answer = (await gemini(history)).answer;
			}
		}
		writeFileSync(join(outDir, `${beat.id}.json`), JSON.stringify(answer, null, 2));
		const entry: Record<string, unknown> = { beat: beat.id, geminiSeconds: first.seconds, attempts, firstError, ok: Boolean(shots) };
		if (shots) {
			shots.images.forEach((url, index) => writeFileSync(join(outDir, `${beat.id}-${index}.jpg`), Buffer.from(url.split(',')[1]!, 'base64')));
			console.log(`[spike] ${beat.id}: render MP4…`);
			const video = await renderMp4(browserPage, answer.code, beat.duration, join(outDir, `${beat.id}.mp4`)).catch((error: Error) => ({ error: error.message }));
			Object.assign(entry, { triangles: shots.triangles, stillMs: Math.round(shots.msPerFrame), video });
		}
		console.log(JSON.stringify(entry));
		report.push(entry);
		await browserPage.close();
	}
} finally {
	await browser.close();
	writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
}
