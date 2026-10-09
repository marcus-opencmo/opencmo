/**
 * `add_icon`: một icon (Lucide, ISC) chuyển động trên video — spec visuals-2 L2.
 * Mọi chuyển động là keyframe thuần trên node `path` (renderer không đổi):
 * xoay quanh tâm hộp, dời x/y, phóng. `fly` chạy theo đường cong và có thể xoay
 * theo hướng bay — mũi tên bắn ra từ cung.
 */

import { z } from 'zod';

import { iconPath } from '@opencmo/clip-icons';

import { fitSize, r2, SHADOW, textNode, THEME, type Node, type Point } from './common';

export const MOTIONS = ['none', 'draw', 'pop', 'spin', 'orbit', 'bounce', 'float', 'pulse', 'shake', 'fly'] as const;

const unit = z.number().min(-0.5).max(1.5);

export const iconInput = z.object({
	/** Tên icon Lucide (tìm bằng find_icons), vd. "bow-arrow", "rotate-cw". */
	name: z.string().trim().min(1).max(60),
	/** Tâm icon, chuẩn hoá 0–1 theo khung. */
	at: z.tuple([unit, unit]).optional(),
	/** Cạnh icon, phần của cạnh NGẮN của khung (0.18 ≈ 194 px trên 1080). */
	size: z.number().min(0.02).max(1).optional(),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
	/** Độ dày nét so với mặc định của Lucide (1 = 2/24 cạnh). */
	weight: z.number().min(0.25).max(4).optional(),
	motion: z.enum(MOTIONS).optional(),
	/** Chu kỳ chuyển động (giây): một vòng quay, một lần nảy… */
	period: z.number().min(0.2).max(20).optional(),
	/** fly: điểm đến (chuẩn hoá), độ cong −1…1, giây bay. */
	to: z.tuple([unit, unit]).optional(),
	bend: z.number().min(-1).max(1).optional(),
	/** fly: xoay icon theo hướng bay; `heading` = hướng icon đang chỉ (độ, 0 = sang phải, −45 = lên-phải). */
	orient: z.boolean().optional(),
	heading: z.number().min(-360).max(360).optional(),
	/** Vẽ nét khi hiện (mặc định có với motion none/draw). */
	draw_on: z.boolean().optional(),
	label: z.string().trim().min(1).max(40).optional(),
});

export type IconInput = z.infer<typeof iconInput>;

const MAX_KEYS = 400;
type Key = { time: number; value: number; easing?: string };
const track = (property: string, keyframes: Key[]): Node => ({ property, keyframes: keyframes.map((k) => ({ ...k, time: r2(k.time), value: r2(k.value) })) });

/** Mốc lặp theo chu kỳ trong `duration`, mỗi chu kỳ `steps` điểm. */
function cycle(duration: number, period: number, steps: number, value: (phase: number) => number, easing?: string): Key[] {
	// Hết ngân sách mốc trước khi hết visual thì chuyển động đứng im giữa chừng:
	// bớt số điểm mỗi chu kỳ (tối thiểu 2), rồi mới giãn chu kỳ.
	const cycles = duration / period;
	if (cycles * steps > MAX_KEYS) {
		steps = Math.max(2, Math.floor(MAX_KEYS / cycles));
		if (cycles * steps > MAX_KEYS) period = (duration * steps) / MAX_KEYS;
	}
	const count = Math.ceil((duration / period) * steps);
	const out: Key[] = [];
	for (let k = 0; k <= count; k++) {
		const time = (k * period) / steps;
		if (time > duration) break;
		out.push({ time, value: value(((k % steps) + steps) % steps / steps), ...(easing ? { easing } : {}) });
	}
	return out;
}

export async function buildIcon(input: IconInput, frame: { width: number; height: number }, duration: number): Promise<Node[]> {
	const d = await iconPath(input.name);
	if (!d) throw new IconError(`There is no icon called "${input.name}". Use find_icons to look one up.`);
	const short = Math.min(frame.width, frame.height);
	const size = r2((input.size ?? 0.18) * short);
	const center: Point = [(input.at?.[0] ?? 0.5) * frame.width, (input.at?.[1] ?? 0.25) * frame.height];
	const x = r2(center[0] - size / 2);
	const y = r2(center[1] - size / 2);
	const motion = input.motion ?? 'draw';
	const period = input.period ?? { spin: 1.6, orbit: 2.4, bounce: 0.8, float: 2.4, pulse: 0.9, shake: 1.2, fly: 1.2 }[motion as string] ?? 1;
	const tracks: Node[] = [];
	const animations: Node[] = [];
	const drawOn = input.draw_on ?? (motion === 'none' || motion === 'draw');

	if (drawOn) tracks.push(track('trimEnd', [{ time: 0, value: 0, easing: 'easeInOut' }, { time: Math.min(0.9, duration * 0.5), value: 1 }]));
	switch (motion) {
		case 'pop':
			animations.push({ type: 'fade', duration: 0.3 }, { type: 'grow', duration: 0.35 });
			break;
		case 'spin':
			// Một đoạn thẳng từ 0 tới đủ số vòng: tốc độ đều, không khựng giữa các vòng.
			tracks.push(track('rotation', [{ time: 0, value: 0, easing: 'linear' }, { time: duration, value: (360 * duration) / period }]));
			break;
		case 'orbit': {
			const radius = size * 0.6;
			tracks.push(track('x', cycle(duration, period, 16, (p) => x + radius * Math.cos(p * 2 * Math.PI), 'linear')));
			tracks.push(track('y', cycle(duration, period, 16, (p) => y + radius * Math.sin(p * 2 * Math.PI), 'linear')));
			break;
		}
		case 'bounce': {
			const height = size * 0.35;
			tracks.push(track('y', cycle(duration, period, 2, (p) => (p < 0.5 ? y : y - height), 'easeInOut')));
			break;
		}
		case 'float':
			tracks.push(track('y', cycle(duration, period, 8, (p) => y + size * 0.07 * Math.sin(p * 2 * Math.PI), 'easeInOut')));
			break;
		case 'pulse':
			tracks.push(track('scale', cycle(duration, period, 2, (p) => (p < 0.5 ? 1 : 1.15), 'easeInOut')));
			break;
		case 'shake':
			tracks.push(track('rotation', cycle(duration, period, 8, (p) => (p < 0.5 ? 10 * Math.sin(p * 4 * Math.PI) : 0), 'easeInOut')));
			break;
		case 'fly': {
			if (!input.to) throw new IconError('A flying icon needs "to": where it flies to.');
			const target: Point = [input.to[0] * frame.width, input.to[1] * frame.height];
			const bend = input.bend ?? 0.3;
			const control: Point = [
				(center[0] + target[0]) / 2 + (target[1] - center[1]) * bend * 0.5,
				(center[1] + target[1]) / 2 - (target[0] - center[0]) * bend * 0.5,
			];
			const flight = Math.min(period, duration);
			const at = (t: number): Point => {
				const u = 1 - t;
				return [u * u * center[0] + 2 * u * t * control[0] + t * t * target[0], u * u * center[1] + 2 * u * t * control[1] + t * t * target[1]];
			};
			const steps = 16;
			const xs: Key[] = [];
			const ys: Key[] = [];
			const angles: Key[] = [];
			for (let k = 0; k <= steps; k++) {
				const t = k / steps;
				const [px, py] = at(t);
				xs.push({ time: t * flight, value: px - size / 2 });
				ys.push({ time: t * flight, value: py - size / 2 });
				if (input.orient) {
					const [ax, ay] = at(Math.max(0, t - 0.01));
					const [bx, by] = at(Math.min(1, t + 0.01));
					let angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI - (input.heading ?? 0);
					// Gỡ bước nhảy ±180°: track nội suy thẳng, 179 → −179 thành một vòng xoay.
					const last = angles.at(-1)?.value;
					if (last !== undefined) angle += Math.round((last - angle) / 360) * 360;
					angles.push({ time: t * flight, value: angle });
				}
			}
			tracks.push(track('x', xs), track('y', ys));
			if (angles.length) tracks.push(track('rotation', angles));
			break;
		}
	}

	const color = input.color ?? THEME.accent;
	const out: Node[] = [
		{
			kind: 'path',
			name: input.name,
			x,
			y,
			width: size,
			height: size,
			viewBox: [0, 0, 24, 24],
			d,
			strokes: [{ color, width: r2((size / 24) * 2 * (input.weight ?? 1)), cap: 'round', join: 'round' }],
			shadows: [{ ...SHADOW }],
			...(tracks.length ? { tracks } : {}),
			...(animations.length ? { animations } : {}),
		},
	];
	if (input.label) {
		const box = { x: center[0] - size * 1.2, y: center[1] + size * 0.6, width: size * 2.4, height: size * 0.45 };
		out.push({ ...textNode(input.label, box, { size: fitSize([input.label], box.width, box.height, 64 * (short / 1080)), color: THEME.text }), animations: [{ type: 'fade', duration: 0.3, delay: 0.3 }] });
	}
	return out;
}

export class IconError extends Error {}
