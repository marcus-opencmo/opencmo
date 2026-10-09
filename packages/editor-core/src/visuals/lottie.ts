/**
 * `add_lottie`: một animation Lottie (nhân vật, hiệu ứng) trên video — spec
 * visuals-2 L3. Bộ có sẵn do OpenCMO tự vẽ (`apps/web/scripts/build-lottie-pack.mts`,
 * CC0) nằm ở `packages/clip-media/lottie`; file người dùng nhập vào thư viện dùng `path`.
 *
 * Danh mục bộ có sẵn ở ĐÂY (thuần, không đọc file) để op và agent biết tên mà
 * không cần hệ thống file; script sinh bộ đối chiếu với danh mục này.
 */

import { z } from 'zod';

import { fitSize, r2, textNode, THEME, type Node, type Point } from './common';
import { EMOJI_PACK } from './emoji';

export type LottieEntry = { name: string; title: string; tags: string[] };

export const LOTTIE_PACK: LottieEntry[] = [
	{ name: 'walk', title: 'Person walking', tags: ['person', 'walk', 'people', 'move', 'journey', 'progress'] },
	{ name: 'run', title: 'Person running', tags: ['person', 'run', 'fast', 'speed', 'hurry', 'sport', 'people'] },
	{ name: 'wave', title: 'Person waving', tags: ['person', 'wave', 'hello', 'hi', 'greeting', 'bye', 'people'] },
	{ name: 'point', title: 'Person pointing', tags: ['person', 'point', 'look', 'this', 'show', 'direction', 'people'] },
	{ name: 'jump', title: 'Person jumping', tags: ['person', 'jump', 'excited', 'win', 'happy', 'people', 'celebrate'] },
	{ name: 'cheer', title: 'Person cheering', tags: ['person', 'cheer', 'celebrate', 'win', 'success', 'yes', 'people'] },
	{ name: 'pulse-ring', title: 'Pulse rings', tags: ['pulse', 'signal', 'ping', 'live', 'notification', 'focus'] },
	{ name: 'check-draw', title: 'Check mark drawing', tags: ['check', 'done', 'yes', 'correct', 'success', 'complete', 'tick'] },
	{ name: 'confetti', title: 'Confetti burst', tags: ['confetti', 'party', 'celebrate', 'win', 'launch', 'congrats'] },
	{ name: 'typing-dots', title: 'Typing dots', tags: ['dots', 'typing', 'waiting', 'loading', 'thinking', 'chat'] },
	{ name: 'arrow-spin', title: 'Spinning arrow', tags: ['arrow', 'spin', 'rotate', 'loop', 'refresh', 'repeat', 'cycle'] },
	{ name: 'bow-shot', title: 'Bow shoots arrow at target', tags: ['bow', 'arrow', 'shoot', 'target', 'aim', 'goal', 'hit'] },
	{ name: 'sparkle', title: 'Sparkles', tags: ['sparkle', 'shine', 'magic', 'new', 'clean', 'star', 'glitter'] },
	{ name: 'heart-beat', title: 'Beating heart', tags: ['heart', 'love', 'like', 'beat', 'health', 'passion'] },
	{ name: 'lightbulb-on', title: 'Light bulb turning on', tags: ['idea', 'lightbulb', 'insight', 'tip', 'eureka', 'think', 'bright'] },
	{ name: 'rocket-launch', title: 'Rocket launch', tags: ['rocket', 'launch', 'growth', 'start', 'boost', 'scale', 'takeoff'] },
	{ name: 'star-burst', title: 'Star burst', tags: ['star', 'burst', 'win', 'best', 'rating', 'celebrate', 'pop'] },
	{ name: 'spinner', title: 'Loading spinner', tags: ['loading', 'spinner', 'wait', 'progress', 'processing'] },
	{ name: 'clock-tick', title: 'Ticking clock', tags: ['clock', 'time', 'deadline', 'hurry', 'late', 'wait', 'minutes'] },
	{ name: 'swipe-up', title: 'Swipe up', tags: ['swipe', 'up', 'link', 'more', 'cta', 'scroll'] },
	{ name: 'arrow-bounce', title: 'Bouncing arrow down', tags: ['arrow', 'down', 'below', 'look', 'here', 'point', 'cta'] },
	{ name: 'target-hit', title: 'Dart hits target', tags: ['target', 'goal', 'hit', 'bullseye', 'aim', 'success', 'precise'] },
];

/** Mọi animation có sẵn: bộ tự vẽ + emoji Noto (`emoji/<tên>`). */
export const BUILTIN_LOTTIES = (): LottieEntry[] => [...LOTTIE_PACK, ...EMOJI_PACK];

/** Cỡ khung gốc của mọi animation trong bộ (vuông). */
export const LOTTIE_PACK_SIZE = 400;

/** Tìm trong bộ có sẵn theo tên/tag — cùng kiểu chấm điểm với `findIcons`. */
export function findLotties(query: string, limit = 10): LottieEntry[] {
	const all = BUILTIN_LOTTIES();
	const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (!words.length) return all.slice(0, limit);
	const scored = all.map((entry) => {
		const short = entry.name.replace(/^emoji\//, '');
		let score = 0;
		for (const word of words) {
			if (short === word) score += 5;
			else if (short.includes(word)) score += 3;
			if (entry.tags.includes(word)) score += 2;
			else if (entry.tags.some((tag) => tag.startsWith(word))) score += 1;
		}
		return { entry, score };
	});
	return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.entry).slice(0, limit);
}

const unit = z.number().min(-0.5).max(1.5);

export const lottieInput = z.object({
	/** Tên trong bộ có sẵn (walk, run, wave…) hoặc `path` của file Lottie trong thư viện. */
	animation: z.string().trim().min(1).max(200),
	/** Tâm, chuẩn hoá 0–1 theo khung. */
	at: z.tuple([unit, unit]).optional(),
	/** Cạnh dài, phần của cạnh NGẮN của khung. */
	size: z.number().min(0.05).max(1.5).optional(),
	speed: z.number().min(0.1).max(8).optional(),
	/** Lặp khi hết animation (mặc định có). */
	loop: z.boolean().optional(),
	/** Lật ngang — nhân vật đi/chạy sang trái. */
	flip: z.boolean().optional(),
	label: z.string().trim().min(1).max(40).optional(),
});

export type LottieInput = z.infer<typeof lottieInput>;

/** `src` của node: `builtin:<tên>` cho bộ có sẵn, còn lại là đường dẫn thư viện. */
export function lottieSrc(animation: string): string | null {
	const name = animation.startsWith('builtin:') ? animation.slice(8) : animation;
	if (BUILTIN_LOTTIES().some((entry) => entry.name === name)) return `builtin:${name}`;
	if (/\.json$/i.test(animation)) return animation;
	return null;
}

export function buildLottie(input: LottieInput, frame: { width: number; height: number }): Node[] {
	const src = lottieSrc(input.animation);
	if (!src) {
		throw new LottieError(
			`There is no animation called "${input.animation}". Built-in: ${LOTTIE_PACK.map((entry) => entry.name).join(', ')}, plus animated emoji "emoji/<name>" (use find_lotties); or use the path of a Lottie file in the library.`,
		);
	}
	const short = Math.min(frame.width, frame.height);
	// Emoji là phản ứng bên cạnh người nói: mặc định nhỏ hơn và lệch sang phải
	// trên — đặt giữa (0.5, 0.28) như nhân vật thì đè thẳng lên mặt ở khung dọc.
	const emoji = src.startsWith('builtin:emoji/');
	const size = r2((input.size ?? (emoji ? 0.22 : 0.35)) * short);
	const center: Point = [(input.at?.[0] ?? (emoji ? 0.78 : 0.5)) * frame.width, (input.at?.[1] ?? (emoji ? 0.2 : 0.28)) * frame.height];
	const out: Node[] = [
		{
			kind: 'lottie',
			name: src.startsWith('builtin:') ? src.slice(8) : (src.split('/').pop() ?? 'animation'),
			x: r2(center[0] - size / 2),
			y: r2(center[1] - size / 2),
			width: size,
			height: size,
			src,
			...(input.speed !== undefined && input.speed !== 1 ? { speed: input.speed } : {}),
			...(input.loop === false ? { loop: false } : {}),
			...(input.flip ? { scaleX: -1 } : {}),
		},
	];
	if (input.label) {
		const box = { x: center[0] - size * 0.8, y: center[1] + size * 0.5, width: size * 1.6, height: size * 0.3 };
		out.push({ ...textNode(input.label, box, { size: fitSize([input.label], box.width, box.height, 64 * (short / 1080)), color: THEME.text }), animations: [{ type: 'fade', duration: 0.3, delay: 0.2 }] });
	}
	return out;
}

export class LottieError extends Error {}
