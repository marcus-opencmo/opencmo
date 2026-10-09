/**
 * Render một spec 3D Studio ra MP4: bundle `page.ts` bằng esbuild, mở trong
 * Chromium headless, trang tự vẽ từng khung và POST pixel về server HTTP nội
 * bộ, server đổ thẳng vào ffmpeg (không giữ khung nào trong RAM Node).
 *
 * GPU: `OPENCMO_3D_GPU=1` bật ANGLE/EGL của NVIDIA (Modal L4). Không có thì SwiftShader —
 * cùng hình, chậm (spike 30/09: ~180–530 ms/khung), đủ cho dev và test.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

import { brandTypeface, sceneChars } from './brand-font.ts';
import { SceneSpecSchema, type SceneSpec } from './spec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Watchdog: khoảng tối đa giữa hai khung (GPU ~0,15 s/khung; SwiftShader dev ~1–3 s). */
const FRAME_MS = Number(process.env.OPENCMO_3D_FRAME_MS ?? 10_000);
const FIRST_FRAME_MS = FRAME_MS * 3;

export type RenderResult = { frames: number; seconds: number; msPerFrame: number; renderer: string };

let bundled: Promise<string> | null = null;
/** Bundle trang một lần mỗi tiến trình. */
export function pageBundle(): Promise<string> {
	bundled ??= build({
		entryPoints: [join(HERE, 'page.ts')],
		bundle: true,
		format: 'iife',
		write: false,
		minify: true,
		loader: { '.json': 'json' },
		logLevel: 'silent',
	}).then((result) => result.outputFiles[0]!.text);
	return bundled;
}

/** Không gọi mạng ra ngoài (Modal không cần, sandbox chặn): tắt cập nhật, dịch vụ nền. */
const QUIET = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps'];

/**
 * Code cảnh do agent viết chạy trong trang này, nên Chromium tự cắt mạng ra
 * ngoài: mọi request đi qua một proxy chết, không phân giải DNS, WebRTC không
 * được gửi UDP. Chỉ còn loopback (Chromium tự bỏ qua proxy cho 127.0.0.1) để
 * nạp trang và đẩy khung. Lớp này thay `block_network` của Modal: cờ đó chặn cả
 * đường Modal tải kết quả > 2 MiB lên kho blob, nên MP4 không về được (01/10).
 */
const OFFLINE = [
	'--proxy-server=http://127.0.0.1:9',
	'--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
	'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

export function chromiumArgs(gpu: boolean): string[] {
	return [...QUIET, ...OFFLINE, ...chromiumGpuArgs(gpu)];
}

/**
 * GPU: ANGLE trên EGL/OpenGL ES của driver NVIDIA, KHÔNG phải Vulkan. Trên L4,
 * ANGLE/Vulkan mất WebGL context ở khung thứ 2 của mọi video (ảnh tĩnh thì
 * không); three.js dựng lại shader nên vật vẫn hiện, nhưng nền gradient, ánh
 * sáng môi trường (PMREM) và sàn gương mất hẳn — MP4 tối sầm mà không có lỗi
 * nào (đo 02/10, `spike/gpu-variants.mts`: 4 bộ cờ Vulkan đều mất, EGL không,
 * cùng ~180 ms/khung ở 1080×1920).
 */
function chromiumGpuArgs(gpu: boolean): string[] {
	return gpu
		? ['--use-angle=gl-egl', '--ignore-gpu-blocklist']
		: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
}

/** Code của cảnh hỏng (biên dịch, dựng, hay một khung): lỗi của agent, không phải của renderer. */
export class SceneCodeFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SceneCodeFailure';
	}
}

/** Lỗi ném trong trang → SceneCodeFailure nếu nó là SceneCodeError của runtime code. */
function codeFailure(message: string): SceneCodeFailure | null {
	const match = /SceneCodeError: ([^\n]*)/.exec(message);
	return match ? new SceneCodeFailure(match[1]!.trim()) : null;
}

export async function renderToFile(input: SceneSpec, out: string, options: { gpu?: boolean; executablePath?: string; crf?: number; code?: string; log?: (line: string) => void; args?: string[] } = {}): Promise<RenderResult> {
	const spec = SceneSpecSchema.parse(input);
	const gpu = options.gpu ?? process.env.OPENCMO_3D_GPU === '1';
	const encoder = spawn(
		'ffmpeg',
		[
			'-v', 'error', '-y',
			'-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${spec.width}x${spec.height}`, '-r', '30', '-i', 'pipe:0',
			'-vf', 'vflip,format=yuv420p',
			'-c:v', 'libx264', '-preset', process.env.OPENCMO_3D_PRESET ?? 'medium', '-crf', String(options.crf ?? 16),
			'-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
			'-movflags', '+faststart', out,
		],
		{ stdio: ['pipe', 'ignore', 'pipe'] },
	);
	let stderr = '';
	encoder.stderr.on('data', (chunk) => (stderr += chunk));
	const exited = once(encoder, 'close');

	const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><script>${await pageBundle()}</script></body>`;
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end(html);
	});
	// Khung đi qua WebSocket nhị phân, không phải HTTP: POST một Uint8Array 8,3 MB
	// mất ~600 ms (Chromium chép body chậm), Blob thì nhanh hơn nhưng nằm trong
	// kho blob tới khi GC chạy — container Modal hết chỗ sau vài chục khung
	// (ERR_BLOB_OUT_OF_MEMORY, đo L4 01/10). Một kết nối nên khung tới đúng thứ
	// tự; ffmpeg chậm thì dừng đọc socket, TCP đẩy ngược về `bufferedAmount` của
	// trang — RAM chỉ giữ vài khung. Trang gửi "done" sau khung cuối.
	const sockets = new WebSocketServer({ server, maxPayload: spec.width * spec.height * 4 + 1024 });
	// Watchdog: code của agent có thể lặp vô hạn — trang treo cứng, không tự thoát
	// được. Mỗi khung tới là một nhịp; quá hạn thì đóng trình duyệt (finally).
	let lastFrame = Date.now();
	let firstFrame = true;
	const received = new Promise<void>((resolve, reject) => {
		sockets.on('connection', (socket) => {
			const raw = (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket;
			socket.on('message', (data, binary) => {
				if (!binary) {
					if (String(data) === 'done') resolve();
					return;
				}
				lastFrame = Date.now();
				firstFrame = false;
				if (!encoder.stdin.write(data as Buffer)) {
					raw.pause();
					encoder.stdin.once('drain', () => raw.resume());
				}
			});
			socket.on('error', reject);
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/frames`;

	const browser = await chromium.launch({
		executablePath: options.executablePath ?? process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
		args: options.args ?? chromiumArgs(gpu),
	});
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
		await page.goto(endpoint.replace('ws://', 'http://').replace('/frames', '/'));
		const font = spec.brand?.font ? await brandTypeface(spec.brand.font, sceneChars(spec)) : null;
		lastFrame = Date.now();
		let watchdog: ReturnType<typeof setInterval> | undefined;
		const stalled = new Promise<never>((_, reject) => {
			watchdog = setInterval(() => {
				// Khung đầu gồm cả dựng cảnh + chạy trước trạng thái cuối: rộng tay hơn.
				const limit = firstFrame ? FIRST_FRAME_MS : FRAME_MS;
				if (Date.now() - lastFrame <= limit) return;
				reject(
					options.code !== undefined
						? new SceneCodeFailure(`The scene code took longer than ${Math.round(limit / 1000)} s to draw a frame (an endless loop?).`)
						: new Error(`3D render stalled for ${Math.round(limit / 1000)} s`),
				);
			}, 1000);
		});
		const result = await Promise.race([
			page.evaluate(([value, url, face, code]) => window.clipThree.render(value as never, url as string, 0, undefined, face, code ?? undefined), [spec, endpoint, font, options.code ?? null] as const).catch((error: Error) => {
				throw codeFailure(error.message) ?? new Error(`${error.message}${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}`);
			}),
			stalled,
		]).finally(() => clearInterval(watchdog));
		await received;
		options.log?.(`3d: ${result.frames} khung, ${(result.ms / result.frames).toFixed(0)} ms/khung, ${result.renderer}`);
		// Mất context thì các khung sau thiếu texture dựng một lần (nền, PMREM, sàn
		// gương): video vẫn ra nhưng hỏng. Báo hỏng để worker hoàn credit.
		if (result.lost.length) throw new Error(`WebGL mất context ở khung ${result.lost.join(',')} (${result.renderer})`);
		encoder.stdin.end();
		const [code] = await exited;
		if (code !== 0) throw new Error(`ffmpeg lỗi (${code}): ${stderr.trim()}`);
		return { frames: result.frames, seconds: spec.duration, msPerFrame: result.ms / result.frames, renderer: result.renderer };
	} finally {
		await browser.close();
		sockets.close();
		server.close();
		if (encoder.exitCode === null) encoder.kill('SIGKILL');
	}
}

/** PNG ở các mốc giây (duyệt hình, test). */
export async function renderStills(input: SceneSpec, times: number[], options: { gpu?: boolean; executablePath?: string } = {}): Promise<Buffer[]> {
	const spec = SceneSpecSchema.parse(input);
	const browser = await chromium.launch({ executablePath: options.executablePath ?? process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: chromiumArgs(options.gpu ?? process.env.OPENCMO_3D_GPU === '1') });
	try {
		const page = await browser.newPage();
		await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${await pageBundle()}</script></body>`);
		const font = spec.brand?.font ? await brandTypeface(spec.brand.font, sceneChars(spec)) : null;
		const urls = await page.evaluate(([value, at, face]) => window.clipThree.stills(value as never, at as number[], face), [spec, times, font] as const);
		return urls.map((url) => Buffer.from(url.split(',')[1]!, 'base64'));
	} finally {
		await browser.close();
	}
}

/** Cảnh code: ảnh JPEG + báo cáo bố cục ở các mốc giây, hoặc lỗi theo giai đoạn (test, preview phía server). */
export async function renderCodeStills(input: import('./page.ts').CodeInput, times: number[], options: { gpu?: boolean; executablePath?: string } = {}): Promise<import('./page.ts').CodeStills> {
	const browser = await chromium.launch({ executablePath: options.executablePath ?? process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: chromiumArgs(options.gpu ?? process.env.OPENCMO_3D_GPU === '1') });
	try {
		const page = await browser.newPage();
		await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>${await pageBundle()}</script></body>`);
		return await page.evaluate(([value, at]) => window.clipThree.code(value as never, at as number[]), [input, times] as const);
	} finally {
		await browser.close();
	}
}
