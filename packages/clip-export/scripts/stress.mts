/**
 * Stress test export cho visual nặng (Lottie + 3D) — KHÔNG chạy trong CI.
 *
 *   npx tsx packages/clip-export/scripts/stress.mts <out-dir> [lottie|3d|mixed|edge|plain|emoji ...]
 *     [--base <job.json có master + transcript>] [--res 720|1080]
 *
 * Mỗi ca: dựng document bằng op thật của editor-core, ghi job, chạy CLI export
 * dưới `/usr/bin/time -v`, rồi báo thời gian, RAM đỉnh, số khung đen và rút
 * vài khung PNG để NHÌN. `time -v` chỉ báo RSS của tiến trình con LỚN NHẤT;
 * export mở nhiều tiến trình (đoạn song song + ffmpeg) nên script còn lấy mẫu
 * TỔNG PSS cả cây tiến trình mỗi 100 ms — con số so với trần 2 GB. Ca `mixed` cần `--base` (job có video master).
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate, type ClipDocument } from '@opencmo/clip-doc';
import { applyOps, LOTTIE_PACK, type Op, type OpContext } from '@opencmo/editor-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CLI = join(ROOT, 'packages/clip-export/src/cli.ts');
const FONTS = join(ROOT, 'packages/clip-media/fonts');
const LOTTIE = join(ROOT, 'packages/clip-media/lottie');

const args = process.argv.slice(2);
const flag = (name: string) => {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const [value] = args.splice(index, 2).slice(1);
	return value;
};
const base = flag('--base');
const resolution = Number(flag('--res') ?? 1080) as 720 | 1080;
const KILL_MB = Number(flag('--kill-mb') ?? 3000);
const [outDir, ...wanted] = args;
if (!outDir) {
	process.stderr.write('dùng: stress.mts <out-dir> [lottie|3d|mixed|edge|plain|emoji ...] [--base job.json] [--res 720|1080]\n');
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const blank = (seconds: number): ClipDocument =>
	validate({
		version: 1,
		stage: { children: [{ kind: 'scene', id: 'sc', name: 'Clip', width: 1080, height: 1920, fill: '#0F172A', workarea: [0, seconds], active: true, children: [] }] },
	});

const memory = (transcript: unknown = []): OpContext =>
	({ master: { width: 1920, height: 1080 }, readTranscript: async () => transcript, saveTranscript: async () => 'assets/transcripts/stress.json' }) as unknown as OpContext;

type Node = Record<string, unknown> & { children?: Node[] };
const sceneOf = (document: ClipDocument) => document.stage.children[0] as unknown as Node;
/** Node lá cuối cùng mang `kind` trong group visual vừa thêm. */
const lastOf = (document: ClipDocument, kind: string): Node => {
	const groups = sceneOf(document).children!.filter((child) => child.marks && (child.marks as Record<string, unknown>).visual);
	const found = groups.at(-1)!.children!.find((child) => child.kind === kind);
	if (!found) throw new Error(`không thấy ${kind}`);
	return found;
};

/** Đường sao nhiều cánh, `points` đỉnh: extrude có `d` dài. */
function star(points: number): string {
	const out: string[] = [];
	for (let k = 0; k < points; k++) {
		const angle = (k / points) * Math.PI * 2;
		const radius = k % 2 ? 0.55 : 1;
		out.push(`${k ? 'L' : 'M'} ${(Math.cos(angle) * radius).toFixed(3)} ${(Math.sin(angle) * radius).toFixed(3)}`);
	}
	return `${out.join(' ')} Z`;
}

type Case = { name: string; document: ClipDocument; media: { src: unknown; file: string }[]; transcripts: { src: string; file: string }[]; times: number[] };

async function lottieCase(): Promise<Case> {
	const seconds = 30;
	const ops: Op[] = LOTTIE_PACK.slice(0, 12).map((entry, index) => ({
		op: 'add_lottie',
		start: 0,
		end: seconds,
		animation: entry.name,
		at: [0.2 + (index % 3) * 0.3, 0.12 + Math.floor(index / 3) * 0.22],
		size: index === 0 ? 1.4 : 0.3,
		speed: [0.25, 1, 3][index % 3],
		loop: index % 4 !== 3,
	})) as unknown as Op[];
	ops.push({ op: 'add_lottie', start: 0, end: seconds, animation: 'confetti', at: [0.5, 0.5], size: 1.5 } as unknown as Op);
	ops.push({ op: 'add_lottie', start: 0, end: seconds, animation: 'walk', at: [0.5, 0.9], size: 0.3 } as unknown as Op);
	let { document } = await applyOps(blank(seconds), ops, memory());
	// Offset lớn và phóng không đều — hai chỗ op không đặt được.
	document = structuredClone(document);
	lastOf(document, 'lottie').offset = 1000;
	const groups = sceneOf(document).children!.filter((child) => child.marks);
	groups[1]!.children!.find((child) => child.kind === 'lottie')!.scaleY = 3;
	return { name: 'lottie', document: validate(document), media: [], transcripts: [], times: [0.5, 7.3, 15, 29.5] };
}

async function threeCase(): Promise<Case> {
	const seconds = 30;
	const ops = [
		{
			op: 'add_3d',
			start: 0,
			end: seconds,
			region: { x: 0.02, y: 0.02, width: 0.96, height: 0.3 },
			camera: { orbit: 30 },
			objects: [{ type: 'surface', expr: 'sin(x + t) * cos(y)', xRange: [-3, 3], yRange: [-3, 3], resolution: 96, color: '#38BDF8', color2: '#F472B6', edges: '#0F172A' }],
		},
		{
			op: 'add_3d',
			start: 0,
			end: seconds,
			region: { x: 0.02, y: 0.34, width: 0.96, height: 0.3 },
			camera: { orbit: -45 },
			objects: [
				{ type: 'torus', size: 2, tube: 0.6, resolution: 96, color: '#FACC15', tracks: [{ property: 'rotateX', keyframes: [{ time: 0, value: 0 }, { time: seconds, value: 720 }] }] },
				{ type: 'sphere', radius: 1, resolution: 96, color: '#4ADE80', position: [0, 0, 2] },
				{ type: 'cone', radius: 1, height: 2, resolution: 96, color: '#F87171', position: [3, 0, 0] },
			],
		},
		{
			op: 'add_3d',
			start: 0,
			end: seconds,
			region: { x: 0.02, y: 0.66, width: 0.96, height: 0.32 },
			camera: { orbit: 20 },
			objects: [{ type: 'extrude', d: star(1000), depth: 0.4, color: '#A78BFA', edges: '#1E1B4B' }],
		},
	] as unknown as Op[];
	let { document } = await applyOps(blank(seconds), ops, memory());
	// 64 khối trong một cảnh (trần của schema node, op chỉ cho 16).
	document = structuredClone(document);
	const cubes = lastOf(document, 'scene3d');
	cubes.objects = Array.from({ length: 64 }, (_, k) => ({ type: 'sphere', radius: 0.3, resolution: 24, position: [(k % 8) - 3.5, Math.floor(k / 8) - 3.5, 0], color: '#E2E8F0' }));
	return { name: '3d', document: validate(document), media: [], transcripts: [], times: [0.5, 10, 20, 29.5] };
}

async function mixedCase(): Promise<Case> {
	if (!base) throw new Error('ca mixed cần --base <job.json>');
	const job = JSON.parse(readFileSync(base, 'utf8')) as { document: ClipDocument; media: Case['media']; transcripts: Case['transcripts'] };
	const transcript = JSON.parse(readFileSync(job.transcripts[0]!.file, 'utf8'));
	// Bỏ visual cũ + layout cũ, dựng lại từ đầu.
	const start = structuredClone(job.document);
	const scene = sceneOf(start);
	scene.children = scene.children!.filter((child) => !(child.marks as Record<string, unknown> | undefined)?.visual);
	const ops = [
		{ op: 'set_layout', mode: 'full' },
		{ op: 'set_layout', mode: 'split-top', start: 1, end: 9, ratio: 0.5 },
		{ op: 'set_layout', mode: 'split-bottom', start: 9, end: 15, ratio: 0.6 },
		{ op: 'set_layout', mode: 'visual-only', start: 15, end: 18 },
		...['walk', 'wave', 'confetti', 'pulse-ring', 'check-draw', 'typing-dots'].map((animation, index) => ({ op: 'add_lottie', start: 1 + index * 2.5, end: 4 + index * 2.5, animation, size: 0.25 })),
		{ op: 'add_3d', start: 2, end: 8, objects: [{ type: 'surface', expr: 'sin(sqrt(x*x + y*y) - t)', resolution: 64, color: '#38BDF8', color2: '#F472B6' }], camera: { orbit: 25 } },
		{ op: 'add_3d', start: 10, end: 14, objects: [{ type: 'torus', resolution: 64, color: '#FACC15' }, { type: 'axes', length: 3 }], camera: { orbit: -30 } },
		{ op: 'add_icon', start: 15.2, end: 17.8, name: 'arrow-right', at: [0.8, 0.3], to: [0.2, 0.6], bend: 0.5, motion: 'fly', orient: true },
	] as unknown as Op[];
	const { document } = await applyOps(start, ops, memory(transcript));
	return { name: 'mixed', document: validate(document), media: job.media, transcripts: job.transcripts, times: [0.5, 1.2, 5, 9, 9.2, 12, 15.2, 16.5, 18.5] };
}

/** Emoji Noto + bộ tự vẽ mới + split + 3D trên video thật (cần `--base`). */
async function emojiCase(): Promise<Case> {
	if (!base) throw new Error('ca emoji cần --base <job.json>');
	const job = JSON.parse(readFileSync(base, 'utf8')) as { document: ClipDocument; media: Case['media']; transcripts: Case['transcripts'] };
	const start = structuredClone(job.document);
	const scene = sceneOf(start);
	scene.children = scene.children!.filter((child) => !(child.marks as Record<string, unknown> | undefined)?.visual);
	const ops = [
		{ op: 'set_layout', mode: 'full' },
		{ op: 'set_layout', mode: 'split-top', start: 6, end: 11, ratio: 0.5 },
		{ op: 'add_lottie', start: 1, end: 5, animation: 'emoji/fire' },
		{ op: 'add_lottie', start: 2.5, end: 5.5, animation: 'emoji/exploding-head', at: [0.22, 0.2] },
		{ op: 'add_3d', start: 6.2, end: 10.8, objects: [{ type: 'torus', resolution: 48, color: '#FACC15' }], camera: { orbit: 30 } },
		{ op: 'add_lottie', start: 7, end: 10.5, animation: 'lightbulb-on', size: 0.2, at: [0.85, 0.62] },
		{ op: 'add_lottie', start: 11.5, end: 15, animation: 'emoji/party-popper' },
		{ op: 'add_lottie', start: 12, end: 15, animation: 'rocket-launch', at: [0.25, 0.25], size: 0.3 },
	] as unknown as Op[];
	const { document } = await applyOps(start, ops, memory());
	return { name: 'emoji', document: validate(document), media: job.media, transcripts: job.transcripts, times: [1.2, 3.5, 8, 10.4, 12.5, 14] };
}

/** Mốc so sánh: document gốc của `--base`, bỏ hết visual + layout. */
async function plainCase(): Promise<Case> {
	if (!base) throw new Error('ca plain cần --base <job.json>');
	const job = JSON.parse(readFileSync(base, 'utf8')) as { document: ClipDocument; media: Case['media']; transcripts: Case['transcripts'] };
	const start = structuredClone(job.document);
	const scene = sceneOf(start);
	scene.children = scene.children!.filter((child) => !(child.marks as Record<string, unknown> | undefined)?.visual);
	const { document } = await applyOps(start, [{ op: 'set_layout', mode: 'full' }] as unknown as Op[], memory());
	return { name: 'plain', document: validate(document), media: job.media, transcripts: job.transcripts, times: [5] };
}

async function edgeCase(dir: string): Promise<Case> {
	const seconds = 8;
	const broken = join(dir, 'broken.json');
	writeFileSync(broken, '{"v":"5.7.0","fr":30,"layers":[{"ty":');
	const ops = [
		{ op: 'add_3d', start: 0, end: seconds, region: { x: 0, y: 0, width: 0.5, height: 0.25 }, objects: [{ type: 'surface', expr: '1/x + sqrt(0 - y*y)', resolution: 32 }] },
		{ op: 'add_3d', start: 0, end: seconds, region: { x: 0.5, y: 0, width: 0.5, height: 0.25 }, camera: { distance: 0.001, fov: 179 }, objects: [{ type: 'cube', size: 2 }] },
		{ op: 'add_3d', start: 0, end: seconds, region: { x: 0, y: 0.3, width: 0.5, height: 0.25 }, objects: [{ type: 'sphere', scale: 0 }, { type: 'cube', scale: [0, 1, 1] }] },
		{ op: 'add_3d', start: 0, end: seconds, region: { x: 0.5, y: 0.3, width: 0.5, height: 0.25 }, camera: { phi: 0, distance: 1e6 }, objects: [{ type: 'torus' }] },
		{ op: 'add_lottie', start: 0, end: seconds, animation: 'walk', at: [0.25, 0.75], size: 0.3 },
		{ op: 'add_lottie', start: 0, end: seconds, animation: 'stress/broken.json', at: [0.75, 0.75], size: 0.3 },
	] as unknown as Op[];
	let { document } = await applyOps(blank(seconds), ops, memory());
	document = structuredClone(document);
	// Builtin không tồn tại: phải ra ô "thiếu media", không làm sập export.
	lastOf(document, 'lottie');
	const walk = sceneOf(document).children!.filter((child) => child.marks).at(-2)!.children!.find((child) => child.kind === 'lottie')!;
	walk.src = 'builtin:no-such-animation';
	return { name: 'edge', document: validate(document), media: [{ src: 'stress/broken.json', file: broken }], transcripts: [], times: [0.5, 4] };
}

type Result = { name: string; seconds: number; frames: number; wall: number; msPerFrame: number; rssMB: number; treeMB: number; black: number; ok: boolean; error?: string };

/** Tổng PSS (MB) của `root` và mọi hậu duệ, đọc thẳng /proc. */
function treeRss(root: number): number {
	const parent = new Map<number, number>();
	const rss = new Map<number, number>();
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			parent.set(Number(entry), Number(fields[1]));
			// PSS, không phải RSS: thư viện dùng chung (Skia, libav) chia đều cho các
			// tiến trình thay vì cộng mỗi tiến trình một lần — gần với cgroup đếm.
			const pss = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8'));
			rss.set(Number(entry), Number(pss?.[1] ?? 0) / 1024);
		} catch {
			// Tiến trình vừa thoát.
		}
	}
	let total = 0;
	for (const [pid, value] of rss) {
		for (let p: number | undefined = pid; p; p = parent.get(p)) {
			if (p === root) {
				total += value;
				break;
			}
		}
	}
	return total;
}

async function run(one: Case): Promise<Result> {
	const dir = join(outDir, one.name);
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${one.name}.mp4`);
	const job = { document: one.document, media: one.media, transcripts: one.transcripts, fonts: FONTS, lottie: LOTTIE, out, resolution };
	const jobFile = join(dir, 'job.json');
	writeFileSync(jobFile, JSON.stringify(job));
	const child = spawn('/usr/bin/time', ['-v', 'node', CLI, 'run', jobFile], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	let treeMB = 0;
	// Chốt an toàn: vượt KILL_MB thì giết cả cây — ca stress không được làm sập máy.
	let killed = false;
	const sampler = setInterval(() => {
		treeMB = Math.max(treeMB, treeRss(child.pid!));
		if (treeMB > KILL_MB && !killed) {
			killed = true;
			spawnSync('pkill', ['-KILL', '-P', String(child.pid)]);
			child.kill('SIGKILL');
		}
	}, 100);
	const status = await new Promise<number | null>((done) => child.on('close', done));
	clearInterval(sampler);
	const wallText = /Elapsed \(wall clock\) time.*: (?:(\d+):)?(\d+):([\d.]+)/.exec(stderr);
	const wall = wallText ? Number(wallText[1] ?? 0) * 3600 + Number(wallText[2]) * 60 + Number(wallText[3]) : NaN;
	const rssMB = Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(stderr)?.[1] ?? NaN) / 1024;
	const workarea = (sceneOf(one.document).workarea as [number, number] | undefined) ?? [0, 0];
	const seconds = workarea[1] - workarea[0];
	const base = { name: one.name, seconds, wall, rssMB: Math.round(rssMB), treeMB: Math.round(treeMB) };
	if (killed) return { ...base, frames: 0, msPerFrame: NaN, black: NaN, ok: false, error: `PSS vượt ${KILL_MB} MB, đã giết` };
	if (status !== 0) return { ...base, frames: 0, msPerFrame: NaN, black: NaN, ok: false, error: stderr.split('\n').filter((line) => /Error|error/.test(line)).slice(0, 3).join(' | ') };
	const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim());
	// Khung đen: nền các ca không có master là #0F172A (không đen), nên blackdetect bắt khung vẽ hỏng.
	const detect = spawnSync('ffmpeg', ['-v', 'info', '-i', out, '-vf', 'blackdetect=d=0.03:pix_th=0.02', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
	const black = [...(detect.stderr ?? '').matchAll(/black_duration:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
	for (const time of one.times) {
		spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', out, '-frames:v', '1', '-vf', 'scale=-2:960', join(dir, `${one.name}-${time}.png`)]);
	}
	return { ...base, frames, msPerFrame: Math.round((wall * 1000) / Math.max(frames, 1)), black: Math.round(black * 30), ok: true };
}

const builders: Record<string, () => Promise<Case>> = {
	lottie: lottieCase,
	'3d': threeCase,
	mixed: mixedCase,
	plain: plainCase,
	emoji: emojiCase,
	edge: () => edgeCase(outDir),
};
const names = wanted.length ? wanted : ['lottie', '3d', 'edge', ...(base ? ['mixed'] : [])];
const results: Result[] = [];
for (const name of names) {
	const build = builders[name];
	if (!build) throw new Error(`không có ca ${name}`);
	const one = await build();
	process.stderr.write(`▶ ${name}…\n`);
	const result = await run(one);
	results.push(result);
	process.stderr.write(`${JSON.stringify(result)}\n`);
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.table(results.map((r) => ({ ca: r.name, giây: r.seconds, khung: r.frames, 'wall s': r.wall, 'ms/khung': r.msPerFrame, 'RSS lớn nhất MB': r.rssMB, 'PSS cả cây MB': r.treeMB, 'khung đen': r.black, ok: r.ok, lỗi: r.error ?? '' })));
