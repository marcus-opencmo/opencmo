/**
 * Sinh bộ Lottie khởi đầu của OpenCMO (spec visuals-2 L3) vào `packages/clip-media/lottie/`.
 *
 *   npx tsx apps/web/scripts/build-lottie-pack.mts
 *
 * Tự vẽ bằng code nên bản quyền là của mình (CC0), không phụ thuộc thư viện
 * ngoài — LottieFiles bị chặn ở sandbox, và giấy phép từng file ở đó phải kiểm
 * tay. Người que có khớp: thân, đầu, cánh tay trên/dưới, đùi/cẳng chân là các
 * layer CHA-CON (Lottie `parent`), mỗi khớp một keyframe xoay — đủ cho đi, chạy,
 * vẫy, chỉ, nhảy, reo. Worker/Modal đọc cùng thư mục (cạnh `packages/clip-media/fonts`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOTTIE_PACK } from '@opencmo/editor-core';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'clip-media', 'lottie');
const SIZE = 400;
const FPS = 30;

type Key = [number, number];
const ease = { i: { x: [0.45], y: [1] }, o: { x: [0.55], y: [0] } };
/** Thuộc tính một chiều có keyframe: [[khung, giá trị], …]. */
const anim1 = (keys: Key[]) =>
	keys.length === 1 ? { a: 0, k: keys[0]![1] } : { a: 1, k: keys.map(([t, v], index) => ({ t, s: [v], ...(index < keys.length - 1 ? ease : {}) })) };
/** Vị trí có keyframe: [[khung, x, y], …]. */
const animPos = (keys: [number, number, number][]) =>
	keys.length === 1 ? { a: 0, k: [keys[0]![1], keys[0]![2], 0] } : { a: 1, k: keys.map(([t, x, y], index) => ({ t, s: [x, y, 0], ...(index < keys.length - 1 ? { i: { x: 0.45, y: 1 }, o: { x: 0.55, y: 0 } } : {}) })) };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);
const stroke = (color: string, width: number) => ({ ty: 'st', c: { a: 0, k: rgb(color) }, o: { a: 0, k: 100 }, w: { a: 0, k: width }, lc: 2, lj: 2, nm: 'stroke' });
const fill = (color: string) => ({ ty: 'fl', c: { a: 0, k: rgb(color) }, o: { a: 0, k: 100 }, r: 1, nm: 'fill' });
const transform = () => ({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } });
const line = (x1: number, y1: number, x2: number, y2: number) => ({ ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: [[x1, y1], [x2, y2]], c: false } } });

/** Đường tuỳ ý: đỉnh + tiếp tuyến vào/ra (toạ độ tương đối đỉnh), khép hay mở. */
const path = (v: [number, number][], closed: boolean, inT?: [number, number][], outT?: [number, number][]) => ({
	ty: 'sh',
	ks: { a: 0, k: { v, i: inT ?? v.map(() => [0, 0]), o: outT ?? v.map(() => [0, 0]), c: closed } },
});
/** Sao `points` cánh, bán kính ngoài/trong. */
const starPath = (points: number, outer: number, inner: number) =>
	path(
		Array.from({ length: points * 2 }, (_, k) => {
			const angle = (k / (points * 2)) * Math.PI * 2 - Math.PI / 2;
			const radius = k % 2 ? inner : outer;
			return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number];
		}),
		true,
	);
/** Trái tim, tâm ở gốc, rộng ~2·r: đáy nhọn, hai thuỳ tròn, lõm ở giữa đỉnh. */
const heartPath = (r: number) =>
	path(
		[[0, r], [-r, -r * 0.2], [-r * 0.5, -r * 0.9], [0, -r * 0.5], [r * 0.5, -r * 0.9], [r, -r * 0.2]],
		true,
		[[0, 0], [0, r * 0.35], [-r * 0.3, 0], [0, 0], [-r * 0.3, 0], [0, -r * 0.35]],
		[[0, 0], [0, -r * 0.35], [r * 0.3, 0], [0, 0], [r * 0.3, 0], [0, r * 0.35]],
	);
/**
 * Nhóm con: fill/stroke của Lottie tô MỌI path đứng trước nó trong cùng nhóm,
 * nên mỗi mảng màu phải nằm trong nhóm riêng. Nhóm đứng trước nằm TRÊN.
 */
const gr = (...items: unknown[]) => ({ ty: 'gr', it: [...items, transform()] });

/** Trim path (vẽ nét dần) từ khung a tới b. */
const drawOn = (a: number, b: number) => ({ ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: a, s: [0], ...ease }, { t: b, s: [100] }] }, o: { a: 0, k: 0 }, m: 1 });
/** Scale có keyframe: [[khung, %], …]. */
const animScale = (keys: Key[]) => ({ a: 1, k: keys.map(([t, v], index) => ({ t, s: [v, v, 100], ...(index < keys.length - 1 ? ease : {}) })) });
/** Layer tĩnh ở tâm với scale động. */
function scaled(name: string, shapes: unknown[], scale: Key[], extra: { r?: Key[]; p?: [number, number, number][]; o?: Key[] } = {}) {
	const l = layer(name, shapes, { p: extra.p ?? [[0, SIZE / 2, SIZE / 2]], r: extra.r, o: extra.o }) as Layer & { ks: Record<string, unknown> };
	l.ks.s = scale.length === 1 ? { a: 0, k: [scale[0]![1], scale[0]![1], 100] } : animScale(scale);
	return l;
}

let op = 30;
let nextIndex = 1;
type Layer = Record<string, unknown>;
function layer(name: string, shapes: unknown[], ks: { r?: Key[]; p?: [number, number, number][]; s?: number; o?: Key[] }, parent?: number): Layer & { ind: number } {
	const ind = nextIndex++;
	return {
		ddd: 0,
		ind,
		ty: 4,
		nm: name,
		...(parent ? { parent } : {}),
		sr: 1,
		ks: {
			o: anim1(ks.o ?? [[0, 100]]),
			r: anim1(ks.r ?? [[0, 0]]),
			p: animPos(ks.p ?? [[0, 0, 0]]),
			a: { a: 0, k: [0, 0, 0] },
			s: { a: 0, k: [ks.s ?? 100, ks.s ?? 100, 100] },
		},
		ao: 0,
		shapes: [{ ty: 'gr', it: [...shapes, transform()], nm: name }],
		ip: 0,
		op,
		st: 0,
		bm: 0,
	};
}

type Pose = { body: [number, number, number][]; lean?: Key[]; armL: Key[]; foreL: Key[]; armR: Key[]; foreR: Key[]; legL: Key[]; shinL: Key[]; legR: Key[]; shinR: Key[] };

/** Người que: hông ở gốc của layer thân, trục y hướng xuống, góc 0 = buông thẳng. */
function figure(pose: Pose, color = '#FFFFFF', accent = '#FACC15'): Layer[] {
	nextIndex = 1;
	const W = 16;
	// Layer vẽ SAU nằm DƯỚI trong Lottie (layer đầu mảng là trên cùng): tay/chân
	// phía xa đặt cuối để bị thân che.
	const body = layer('body', [line(0, 0, 0, -95), stroke(color, W)], { p: pose.body, r: pose.lean });
	const head = layer('head', [{ ty: 'el', p: { a: 0, k: [0, -128] }, s: { a: 0, k: [52, 52] } }, fill(accent), stroke(color, W - 4)], {}, body.ind);
	const armR = layer('arm R', [line(0, 0, 0, 48), stroke(color, W)], { p: [[0, 0, -88]], r: pose.armR }, body.ind);
	const foreR = layer('forearm R', [line(0, 0, 0, 44), stroke(color, W)], { p: [[0, 0, 48]], r: pose.foreR }, armR.ind);
	const legR = layer('thigh R', [line(0, 0, 0, 58), stroke(color, W)], { r: pose.legR }, body.ind);
	const shinR = layer('shin R', [line(0, 0, 0, 56), stroke(color, W)], { p: [[0, 0, 58]], r: pose.shinR }, legR.ind);
	const armL = layer('arm L', [line(0, 0, 0, 48), stroke(color, W)], { p: [[0, 0, -88]], r: pose.armL }, body.ind);
	const foreL = layer('forearm L', [line(0, 0, 0, 44), stroke(color, W)], { p: [[0, 0, 48]], r: pose.foreL }, armL.ind);
	const legL = layer('thigh L', [line(0, 0, 0, 58), stroke(color, W)], { r: pose.legL }, body.ind);
	const shinL = layer('shin L', [line(0, 0, 0, 56), stroke(color, W)], { p: [[0, 0, 58]], r: pose.shinL }, legL.ind);
	return [foreR, armR, shinR, legR, head, body, foreL, armL, shinL, legL];
}

/** Chu kỳ lặp: giá trị ở các mốc đều nhau, mốc cuối = mốc đầu (lặp liền). */
const loop = (frames: number, values: number[]): Key[] => [...values, values[0]!].map((value, index) => [Math.round((index * frames) / values.length), value]);
const bob = (frames: number, y: number, dy: number, steps = 2): [number, number, number][] =>
	Array.from({ length: steps * 2 + 1 }, (_, k) => [Math.round((k * frames) / (steps * 2)), SIZE / 2, y + (k % 2 ? -dy : 0)]);

function lottie(name: string, frames: number, layers: Layer[]) {
	return { v: '5.7.0', fr: FPS, ip: 0, op: frames, w: SIZE, h: SIZE, nm: name, ddd: 0, assets: [], layers };
}

const HIP = 250;
/** Tên, tiêu đề, tag nằm ở `LOTTIE_PACK` (editor-core) — script chỉ vẽ. */
const pack: Record<string, { build: () => object }> = {
	walk: {
		build: () => {
			op = 30;
			return lottie('walk', 30, figure({
				body: bob(30, HIP, 6),
				armL: loop(30, [25, -25]), foreL: loop(30, [-20, -35]),
				armR: loop(30, [-25, 25]), foreR: loop(30, [-35, -20]),
				legL: loop(30, [-25, 25]), shinL: loop(30, [5, 35]),
				legR: loop(30, [25, -25]), shinR: loop(30, [35, 5]),
			}));
		},
	},
	run: {
		build: () => {
			op = 20;
			return lottie('run', 20, figure({
				body: bob(20, HIP - 10, 14), lean: [[0, 14]],
				armL: loop(20, [55, -45]), foreL: loop(20, [-90, -70]),
				armR: loop(20, [-45, 55]), foreR: loop(20, [-70, -90]),
				legL: loop(20, [-45, 40]), shinL: loop(20, [20, 90]),
				legR: loop(20, [40, -45]), shinR: loop(20, [90, 20]),
			}));
		},
	},
	wave: {
		build: () => {
			op = 30;
			return lottie('wave', 30, figure({
				body: [[0, SIZE / 2, HIP]],
				armL: [[0, 8]], foreL: [[0, -5]],
				armR: [[0, -125]], foreR: loop(30, [-45, 15]),
				legL: [[0, 8]], shinL: [[0, 0]],
				legR: [[0, -8]], shinR: [[0, 0]],
			}));
		},
	},
	point: {
		build: () => {
			op = 40;
			return lottie('point', 40, figure({
				body: bob(40, HIP, 4, 1),
				armL: [[0, 10]], foreL: [[0, -10]],
				armR: loop(40, [-90, -80]), foreR: [[0, 0]],
				legL: [[0, 10]], shinL: [[0, 0]],
				legR: [[0, -10]], shinR: [[0, 0]],
			}));
		},
	},
	jump: {
		build: () => {
			op = 36;
			return lottie('jump', 36, figure({
				body: [[0, SIZE / 2, HIP + 20], [10, SIZE / 2, HIP - 60], [20, SIZE / 2, HIP - 60], [30, SIZE / 2, HIP + 20], [36, SIZE / 2, HIP + 20]],
				armL: [[0, 30], [10, 160], [20, 160], [30, 30], [36, 30]], foreL: [[0, -30], [10, 0], [30, -30], [36, -30]],
				armR: [[0, -30], [10, -160], [20, -160], [30, -30], [36, -30]], foreR: [[0, 30], [10, 0], [30, 30], [36, 30]],
				legL: [[0, -40], [10, -5], [20, -5], [30, -40], [36, -40]], shinL: [[0, 70], [10, 10], [20, 10], [30, 70], [36, 70]],
				legR: [[0, 40], [10, 5], [20, 5], [30, 40], [36, 40]], shinR: [[0, -70], [10, -10], [20, -10], [30, -70], [36, -70]],
			}));
		},
	},
	cheer: {
		build: () => {
			op = 24;
			return lottie('cheer', 24, figure({
				body: bob(24, HIP, 8),
				armL: loop(24, [125, 145]), foreL: loop(24, [15, -5]),
				armR: loop(24, [-125, -145]), foreR: loop(24, [-15, 5]),
				legL: [[0, 12]], shinL: [[0, 0]],
				legR: [[0, -12]], shinR: [[0, 0]],
			}));
		},
	},
	'pulse-ring': {
		build: () => {
			op = 45;
			nextIndex = 1;
			const ring = (delay: number) =>
				layer(`ring ${delay}`, [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [120, 120] } }, stroke('#38BDF8', 10)], {
					p: [[0, SIZE / 2, SIZE / 2]],
					s: 100,
					o: [[delay, 100], [delay + 30, 0]],
					r: [[0, 0]],
				});
			const layers = [0, 15].map((delay) => {
				const l = ring(delay) as Layer & { ks: Record<string, unknown> };
				l.ks.s = { a: 1, k: [{ t: delay, s: [60, 60, 100], ...ease }, { t: delay + 30, s: [260, 260, 100] }] };
				return l;
			});
			const dot = layer('dot', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [70, 70] } }, fill('#38BDF8')], { p: [[0, SIZE / 2, SIZE / 2]] });
			return lottie('pulse-ring', 45, [dot, ...layers]);
		},
	},
	'check-draw': {
		build: () => {
			op = 40;
			nextIndex = 1;
			const circle = layer('circle', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [300, 300] } }, stroke('#4ADE80', 18), { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0], ...ease }, { t: 18, s: [100] }] }, o: { a: 0, k: 0 }, m: 1 }], { p: [[0, SIZE / 2, SIZE / 2]] });
			const tick = layer('tick', [{ ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]], v: [[-70, 0], [-20, 50], [80, -60]], c: false } } }, stroke('#4ADE80', 22), { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 14, s: [0], ...ease }, { t: 30, s: [100] }] }, o: { a: 0, k: 0 }, m: 1 }], { p: [[0, SIZE / 2, SIZE / 2]] });
			return lottie('check-draw', 40, [tick, circle]);
		},
	},
	confetti: {
		build: () => {
			op = 45;
			nextIndex = 1;
			const colors = ['#FACC15', '#F472B6', '#38BDF8', '#4ADE80', '#A78BFA', '#FB923C'];
			const layers = Array.from({ length: 18 }, (_, k) => {
				const angle = (k / 18) * Math.PI * 2 + (k % 3) * 0.2;
				const distance = 120 + (k % 4) * 30;
				const [x, y] = [SIZE / 2 + Math.cos(angle) * distance, SIZE / 2 + Math.sin(angle) * distance + 40];
				return layer(`bit ${k}`, [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [18, 10] }, r: { a: 0, k: 3 } }, fill(colors[k % colors.length]!)], {
					p: [[0, SIZE / 2, SIZE / 2], [22, x, y], [44, x, y + 60]],
					r: [[0, 0], [44, (k % 2 ? 1 : -1) * 540]],
					o: [[0, 100], [30, 100], [44, 0]],
				});
			});
			return lottie('confetti', 45, layers);
		},
	},
	'typing-dots': {
		build: () => {
			op = 36;
			nextIndex = 1;
			const layers = [0, 1, 2].map((k) =>
				layer(`dot ${k}`, [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [56, 56] } }, fill('#FFFFFF')], {
					p: [[k * 6, SIZE / 2 + (k - 1) * 90, SIZE / 2], [k * 6 + 9, SIZE / 2 + (k - 1) * 90, SIZE / 2 - 40], [k * 6 + 18, SIZE / 2 + (k - 1) * 90, SIZE / 2], [36, SIZE / 2 + (k - 1) * 90, SIZE / 2]],
				}),
			);
			return lottie('typing-dots', 36, layers);
		},
	},
	'arrow-spin': {
		build: () => {
			op = 40;
			nextIndex = 1;
			// Mũi tên vòng (refresh/loop): cung 300° + đầu mũi tên, quay đều một vòng.
			const arc = Array.from({ length: 49 }, (_, k) => {
				const angle = (-60 + (k / 48) * 300) * (Math.PI / 180);
				return [Math.cos(angle) * 110, Math.sin(angle) * 110] as [number, number];
			});
			const end = arc.at(-1)!;
			const head = path([[end[0] - 40, end[1] - 30], end, [end[0] + 10, end[1] - 50]], false);
			return lottie('arrow-spin', 40, [layer('arrow', [path(arc, false), head, stroke('#38BDF8', 22)], { p: [[0, SIZE / 2, SIZE / 2]], r: [[0, 0], [40, 360]] })]);
		},
	},
	'bow-shot': {
		build: () => {
			op = 45;
			nextIndex = 1;
			// Cung bên trái, mũi tên bay sang bia bên phải, bia rung khi trúng.
			const bow = layer('bow', [gr(path([[0, -110], [0, 110]], false, [[0, 0], [-90, -60]], [[-90, 60], [0, 0]]), stroke('#FB923C', 14)), gr(path([[0, -110], [0, 110]], false), stroke('#E2E8F0', 4))], { p: [[0, 90, SIZE / 2]] });
			const arrow = layer('arrow', [gr(line(-60, 0, 30, 0), stroke('#E2E8F0', 8)), gr(path([[18, -14], [34, 0], [18, 14]], true), fill('#E2E8F0'))], { p: [[0, 100, SIZE / 2], [6, 100, SIZE / 2], [22, 300, SIZE / 2], [45, 300, SIZE / 2]] });
			const ring = (size: number, color: string) => gr({ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [size, size] } }, fill(color));
			const target = scaled('target', [ring(40, '#F87171'), ring(90, '#FFFFFF'), ring(140, '#F87171')], [[0, 100], [22, 100], [26, 112], [32, 100], [45, 100]], { p: [[0, 330, SIZE / 2]] });
			return lottie('bow-shot', 45, [arrow, bow, target]);
		},
	},
	sparkle: {
		build: () => {
			op = 40;
			nextIndex = 1;
			const spots: [number, number, number, number][] = [[200, 190, 1, 0], [110, 120, 0.55, 10], [295, 110, 0.45, 20], [300, 290, 0.6, 6], [115, 290, 0.4, 26]];
			const layers = spots.map(([x, y, size, delay]) =>
				scaled(`spark ${delay}`, [starPath(4, 90 * size, 22 * size), fill('#FDE68A')], [[delay, 0], [delay + 7, 110], [delay + 14, 0], [40, 0]].filter(([t], i, all) => i === 0 || t > all[i - 1]![0]) as Key[], { p: [[0, x, y]], r: [[0, 0], [40, 90]] }),
			);
			return lottie('sparkle', 40, layers);
		},
	},
	'heart-beat': {
		build: () => {
			op = 30;
			nextIndex = 1;
			return lottie('heart-beat', 30, [scaled('heart', [heartPath(120), fill('#F43F5E')], [[0, 100], [5, 118], [10, 100], [15, 112], [22, 100], [30, 100]])]);
		},
	},
	'lightbulb-on': {
		build: () => {
			op = 45;
			nextIndex = 1;
			// Bóng đèn bật sáng: bóng từ xám sang vàng, tia toả ra. Không vẽ quầng mờ:
			// vàng trong suốt trên nền tối ra màu ô liu đục.
			const lit = { ty: 'fl', c: { a: 1, k: [{ t: 8, s: rgb('#64748B'), ...ease }, { t: 16, s: rgb('#FACC15') }] }, o: { a: 0, k: 100 }, r: 1, nm: 'fill' };
			const bulb = layer('bulb', [{ ty: 'el', p: { a: 0, k: [0, -30] }, s: { a: 0, k: [150, 150] } }, stroke('#FFFFFF', 10), lit], { p: [[0, SIZE / 2, SIZE / 2]] });
			const base = layer('base', [{ ty: 'rc', p: { a: 0, k: [0, 70] }, s: { a: 0, k: [70, 44] }, r: { a: 0, k: 8 } }, fill('#94A3B8')], { p: [[0, SIZE / 2, SIZE / 2]] });
			const rays = Array.from({ length: 8 }, (_, k) => {
				const angle = (k / 8) * Math.PI * 2;
				const [c, s2] = [Math.cos(angle), Math.sin(angle)];
				return layer(`ray ${k}`, [line(c * 115, s2 * 115, c * 165, s2 * 165), stroke('#FDE68A', 12), drawOn(14, 26)], { p: [[0, SIZE / 2, SIZE / 2 - 30]] });
			});
			return lottie('lightbulb-on', 45, [...rays, base, bulb]);
		},
	},
	'rocket-launch': {
		build: () => {
			op = 45;
			nextIndex = 1;
			const body = path([[0, -95], [38, -20], [38, 60], [-38, 60], [-38, -20]], true, [[-30, 0], [0, -30], [0, 0], [0, 0], [0, 0]], [[30, 0], [0, 0], [0, 0], [0, 0], [0, -30]]);
			const rocketShapes = [
				gr({ ty: 'el', p: { a: 0, k: [0, -15] }, s: { a: 0, k: [34, 34] } }, fill('#38BDF8')),
				gr(body, fill('#E2E8F0')),
				gr(path([[-38, 20], [-70, 75], [-38, 60]], true), path([[38, 20], [70, 75], [38, 60]], true), fill('#F43F5E')),
			];
			const rocket = layer('rocket', rocketShapes, { p: [[0, SIZE / 2, 270], [12, SIZE / 2 + 2, 268], [16, SIZE / 2 - 2, 270], [45, SIZE / 2, -120]] });
			const flame = layer('flame', [path([[-24, 0], [0, 70], [24, 0]], true, [[0, 0], [-14, -10], [0, 0]], [[0, 0], [14, -10], [0, 0]]), fill('#FB923C')], { p: [[0, SIZE / 2, 330], [12, SIZE / 2, 330], [16, SIZE / 2, 330], [45, SIZE / 2, -60]], o: [[0, 0], [8, 100]] }, undefined);
			const puff = (dx: number) => scaled(`puff ${dx}`, [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [60, 60] } }, fill('#CBD5E1')], [[14, 0], [30, 140], [45, 180]], { p: [[14, SIZE / 2 + dx, 350], [45, SIZE / 2 + dx * 2.2, 360]], o: [[14, 0], [18, 90], [45, 0]] });
			return lottie('rocket-launch', 45, [rocket, flame, puff(-60), puff(0), puff(60)]);
		},
	},
	'star-burst': {
		build: () => {
			op = 36;
			nextIndex = 1;
			const star = scaled('star', [starPath(5, 110, 48), fill('#FACC15')], [[0, 0], [10, 125], [16, 100], [36, 100]], { r: [[0, -40], [16, 0]] });
			const bits = Array.from({ length: 10 }, (_, k) => {
				const angle = (k / 10) * Math.PI * 2;
				const [x, y] = [SIZE / 2 + Math.cos(angle) * 175, SIZE / 2 + Math.sin(angle) * 175];
				return layer(`bit ${k}`, [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [18, 18] } }, fill(k % 2 ? '#F472B6' : '#38BDF8')], { p: [[4, SIZE / 2, SIZE / 2], [18, x, y]], o: [[4, 0], [6, 100], [18, 100], [28, 0]] });
			});
			return lottie('star-burst', 36, [star, ...bits]);
		},
	},
	spinner: {
		build: () => {
			op = 30;
			nextIndex = 1;
			const track = layer('track', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [220, 220] } }, stroke('#334155', 22)], { p: [[0, SIZE / 2, SIZE / 2]] });
			const arc = layer('arc', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [220, 220] } }, stroke('#38BDF8', 22), { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 0, k: 28 }, o: { a: 0, k: 0 }, m: 1 }], { p: [[0, SIZE / 2, SIZE / 2]], r: [[0, 0], [30, 360]] });
			// Quay đều: bỏ easing của keyframe xoay.
			(arc.ks as { r: { k: Record<string, unknown>[] } }).r.k.forEach((key) => ((key.i = { x: [1], y: [1] }), (key.o = { x: [0], y: [0] })));
			return lottie('spinner', 30, [arc, track]);
		},
	},
	'clock-tick': {
		build: () => {
			op = 60;
			nextIndex = 1;
			const face = layer('face', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [260, 260] } }, stroke('#E2E8F0', 14), fill('#1E293B')], { p: [[0, SIZE / 2, SIZE / 2]] });
			const ticks = layer('ticks', Array.from({ length: 12 }, (_, k) => {
				const angle = (k / 12) * Math.PI * 2;
				return line(Math.cos(angle) * 100, Math.sin(angle) * 100, Math.cos(angle) * 115, Math.sin(angle) * 115);
			}).concat([stroke('#94A3B8', 6)] as never[]), { p: [[0, SIZE / 2, SIZE / 2]] });
			// Kim giây nhảy từng nấc (12 nấc/2 giây), kim phút trượt chậm.
			const steps: Key[] = Array.from({ length: 13 }, (_, k) => [k * 5, k * 30]);
			const second = layer('second hand', [line(0, 15, 0, -100), stroke('#F87171', 6)], { p: [[0, SIZE / 2, SIZE / 2]], r: steps });
			const minute = layer('minute hand', [line(0, 0, 0, -80), stroke('#E2E8F0', 12)], { p: [[0, SIZE / 2, SIZE / 2]], r: [[0, 0], [60, 30]] });
			const hub = layer('hub', [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [22, 22] } }, fill('#F87171')], { p: [[0, SIZE / 2, SIZE / 2]] });
			return lottie('clock-tick', 60, [hub, second, minute, ticks, face]);
		},
	},
	'swipe-up': {
		build: () => {
			op = 40;
			nextIndex = 1;
			const chevron = (delay: number) =>
				layer(`chevron ${delay}`, [path([[-60, 30], [0, -30], [60, 30]], false), stroke('#FFFFFF', 18)], {
					p: [[delay, SIZE / 2, 280], [delay + 22, SIZE / 2, 150], [40, SIZE / 2, 150]].filter(([t], i, all) => i === 0 || t > all[i - 1]![0]) as [number, number, number][],
					o: [[delay, 0], [delay + 6, 100], [delay + 22, 0], [40, 0]].filter(([t], i, all) => i === 0 || t > all[i - 1]![0]) as Key[],
				});
			return lottie('swipe-up', 40, [chevron(0), chevron(12)]);
		},
	},
	'arrow-bounce': {
		build: () => {
			op = 30;
			nextIndex = 1;
			return lottie('arrow-bounce', 30, [layer('arrow', [line(0, -80, 0, 60), path([[-50, 15], [0, 70], [50, 15]], false), stroke('#FACC15', 22)], { p: [[0, SIZE / 2, SIZE / 2 - 20], [15, SIZE / 2, SIZE / 2 + 30], [30, SIZE / 2, SIZE / 2 - 20]] })]);
		},
	},
	'target-hit': {
		build: () => {
			op = 40;
			nextIndex = 1;
			const ring = (size: number, color: string) => gr({ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [size, size] } }, fill(color));
			const dart = layer('dart', [gr(line(0, 0, 70, -70), stroke('#E2E8F0', 10)), gr(path([[0, 0], [22, -8], [8, -22]], true), fill('#E2E8F0'))], { p: [[0, SIZE + 80, -80], [14, SIZE / 2, SIZE / 2], [40, SIZE / 2, SIZE / 2]] });
			const board = scaled('board', [ring(50, '#F87171'), ring(130, '#FFFFFF'), ring(210, '#F87171'), ring(290, '#FFFFFF')], [[0, 100], [14, 100], [18, 108], [24, 100], [40, 100]]);
			return lottie('target-hit', 40, [dart, board]);
		},
	},
};

const names = LOTTIE_PACK.map((entry) => entry.name);
if (names.join() !== Object.keys(pack).join()) throw new Error(`LOTTIE_PACK (${names.join()}) và script (${Object.keys(pack).join()}) lệch nhau`);
mkdirSync(OUT, { recursive: true });
for (const [name, entry] of Object.entries(pack)) writeFileSync(join(OUT, `${name}.json`), JSON.stringify(entry.build()));
writeFileSync(
	join(OUT, 'LICENSE.md'),
	[
		'# Built-in animations',
		'',
		'## OpenCMO starter animations (this folder)',
		'',
		'Drawn in code by OpenCMO (`apps/web/scripts/build-lottie-pack.mts`).',
		'Released under CC0-1.0 — no rights reserved.',
		'',
		'## Animated emoji (`emoji/`)',
		'',
		'Noto Emoji Animation by Google (https://googlefonts.github.io/noto-emoji-animation/),',
		'licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
		'Downloaded unmodified by `apps/web/scripts/fetch-noto-emoji.mts`.',
		'',
	].join('\n'),
);
console.log(`${names.length} animation → ${OUT}`);
