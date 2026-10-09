/**
 * Voiceover (spec 2026-10-02-voiceover): giọng đọc mới trên clip.
 *
 * - `add_voiceover` ghi KHAI BÁO `generate.voice` vào một node `audio` có mark
 *   `voiceover`, kèm (tuỳ chọn) một node `captions` cùng khoá, chưa có `src`.
 *   Editor phân giải khai báo qua `/api/v1/generations` như mọi lượt Generate.
 * - `sync_voiceover` chạy khi giọng về: độ dài thật + mốc từng chữ → `end` của
 *   audio và transcript cho phụ đề của giọng.
 * - `syncVoiceovers` là lượt hậu kỳ của `applyOps`: trạng thái SUY RA từ các
 *   voiceover đang có, tính lại sau MỌI op — nên xoá, dời, cắt ngắn voiceover
 *   hay cắt video bằng chữ đều tự đúng mà không op nào phải nhớ dọn:
 *     * `replace`: tắt tiếng video gốc + ẩn phụ đề gốc; hết voiceover `replace`
 *       thì trả lại đúng trạng thái trước đó (nhớ ở mark `voiceover-replaced`).
 *     * `overlay`: hạ tiếng video gốc trong lúc giọng đọc (track `volume` trên
 *       mọi đoạn video master, mốc theo giây NGUỒN — luật keyframe của video).
 *       Track do ta ghi được nhận ra qua mark `voiceover-duck` trên scene.
 *     * phụ đề của voiceover đã xoá thì xoá theo.
 *
 * Không hứa gì về bản quyền: thay giọng không làm việc dùng video của người
 * khác thành hợp pháp (spec §7).
 */

import { z } from 'zod';

import type { AssetDeclaration, ClipDocument, ClipNode, VoiceoverMark } from '@opencmo/clip-doc';

import { masterCaptions, readCaptionStyle } from '../captions';
import { clone, isMasterSound, nodes, sceneOf, walk, type Entity } from '../doc';
import { round, type Transcript, type Word } from '../transcript';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';
import { resolveTiming } from './visuals';

export const VOICEOVER_MARK = 'voiceover';
const REPLACED_MARK = 'voiceover-replaced';
const DUCK_MARK = 'voiceover-duck';
/**
 * Tốc độ đọc để ước độ dài trước khi giọng về. Đo thật 30/09–01/10: ElevenLabs
 * (Brian) 164 từ → 52.2s ≈ 3.1 từ/giây; Gemini 3.3–3.5. Số cũ 2.5 làm kịch bản
 * "vừa clip" ra giọng ngắn hơn clip ~20%, đuôi clip im lặng.
 */
export const WORDS_PER_SECOND = 3;
const RAMP = 0.25;
/** Khe giữa hai dòng phụ đề ngắn hơn ngần này thì nối (≈ 9 frame). */
const LINE_GAP = 0.3;
export const DEFAULT_DUCK_DB = -18;
/** Trường vị trí/cỡ chép từ phụ đề của video sang phụ đề của giọng. */
const PLACEMENT = ['verticalAlign', 'offsetX', 'offsetY', 'fontScale', 'seed'] as const;

/** Chỗ cho phụ đề giọng mới, tránh phụ đề gốc: tâm gốc ở nửa dưới → lên đỉnh, ngược lại → xuống đáy. */
function apartFrom(video: Entity, height: number): { verticalAlign: 'top' | 'bottom'; offsetY: number } {
	const align = (video.verticalAlign as string | undefined) ?? 'bottom';
	const base = align === 'top' ? 0.1 : align === 'center' ? 0.5 : 0.9;
	const centre = base + (Number(video.offsetY) || 0) / height;
	return centre > 0.45 ? { verticalAlign: 'top', offsetY: 0 } : { verticalAlign: 'bottom', offsetY: 0 };
}

/** `synced`: giọng đã về và `sync_voiceover` đã chạy — editor không gắn lần hai. */
export type { VoiceoverMark };

const fields = {
	text: z.string().trim().min(1, 'Write the voiceover script first.').max(5000, 'Keep the script under 5000 characters.'),
	voice: z.string().min(1).max(100),
	mode: z.enum(['replace', 'overlay']),
	/** Giây của CLIP. `replace` mặc định từ 0; `overlay` cần start hoặc quote. */
	start: z.number().finite().min(0).optional(),
	/** Câu người nói mà giọng mới chen vào (overlay). */
	quote: z.string().trim().min(2).max(300).optional(),
	/** dB hạ tiếng video gốc khi `overlay` (−40 tới −3). */
	duck_db: z.number().min(-40).max(-3).optional(),
	/** Phụ đề cho giọng mới; mặc định có khi `replace`, không khi `overlay`. */
	captions: z.boolean().optional(),
	seed: z.number().int().min(0).max(2_147_483_647).optional(),
};

/** Input của tool agent (không có `op`). */
export const voiceoverToolInput = z.object(fields);
export const voiceoverInput = z.object({ op: z.literal('add_voiceover'), ...fields });
export type VoiceoverInput = z.infer<typeof voiceoverInput>;

export const estimateSeconds = (text: string): number => round(Math.max(1, text.trim().split(/\s+/).length / WORDS_PER_SECOND));

const markOf = (node: { marks?: Record<string, unknown> }): VoiceoverMark | null => {
	const mark = node.marks?.[VOICEOVER_MARK] as Partial<VoiceoverMark> | undefined;
	return mark && typeof mark.key === 'string' ? (mark as VoiceoverMark) : null;
};

function newKey(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Khai báo + mốc — dùng chung cho op và tool của agent (tool báo giá trước khi op chạy). */
export async function planVoiceover(document: ClipDocument, input: VoiceoverInput, ctx?: Pick<OpContext, 'readTranscript'>) {
	const scene = sceneOf(document);
	if (!scene?.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
	let start = input.start ?? 0;
	if (input.mode === 'overlay' && input.start === undefined) {
		if (!input.quote) throw new OpFailure('Give start (clip seconds) or quote: the words after which the voiceover plays.');
		start = (await resolveTiming(document, ctx, { quote: input.quote })).start;
	}
	const src: AssetDeclaration = { generate: 'voice', prompt: input.text, voice: input.voice, ...(input.seed === undefined ? {} : { seed: input.seed }) };
	return { src, start: round(start), end: round(start + estimateSeconds(input.text)), spec: { prompt: input.text, voice: input.voice, ...(input.seed === undefined ? {} : { seed: input.seed }) } };
}

const nameOf = (text: string): string => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return `Voiceover: ${flat.length > 32 ? `${flat.slice(0, 32)}…` : flat}`;
};

/**
 * Lớp phụ đề của một voiceover: cùng kiểu VÀ cùng chỗ với phụ đề của video (hay
 * kit): preset, màu, vị trí, cỡ. Chưa có `src` tới khi giọng về.
 */
function voiceCaptions(document: ClipDocument, key: string, start: number, mode: VoiceoverMark['mode'], hidden: boolean): ClipNode {
	const root = sceneOf(document)!;
	const style = readCaptionStyle(document);
	const video = nodes(document).find((node) => node.kind === 'captions' && !markOf(node as never)) as Entity | undefined;
	let placement: Record<string, unknown> = Object.fromEntries(PLACEMENT.filter((name) => video?.[name] !== undefined).map((name) => [name, video![name]]));
	// overlay: phụ đề gốc vẫn chạy bên dưới giọng mới — cùng chỗ thì hai dòng
	// in chồng lên nhau (export clip TED 02/10). Đặt sang nửa khung còn lại.
	if (mode === 'overlay' && video && !video.hidden) placement = { ...placement, ...apartFrom(video, root.height ?? 1920) };
	return {
		kind: 'captions',
		name: 'Voiceover captions',
		...(style?.preset ? { preset: style.preset } : {}),
		...(style?.colors?.length ? { colors: style.colors } : {}),
		...(style?.color ? { color: style.color } : {}),
		...(style?.fontFamily ? { fontFamily: style.fontFamily } : {}),
		...(style?.fontWeight ? { fontWeight: style.fontWeight } : {}),
		...placement,
		...(hidden ? { hidden: true } : {}),
		start,
		marks: { [VOICEOVER_MARK]: { key } },
	} as ClipNode;
}

export const addVoiceover = {
	name: 'add_voiceover',
	agent: false,
	input: voiceoverInput,
	describe: (input: VoiceoverInput) => `${input.mode === 'replace' ? 'Replace the voice' : 'Add a voiceover'}: "${input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text}"`,
	async apply(document: ClipDocument, input: VoiceoverInput, ctx?: OpContext) {
		const plan = await planVoiceover(document, input, ctx);
		const next = clone(document);
		const root = sceneOf(next)!;
		const key = newKey();
		const mark: VoiceoverMark = { key, mode: input.mode, duck: input.duck_db ?? DEFAULT_DUCK_DB };
		const children = [...(root.children ?? [])];
		children.push({ kind: 'audio', name: nameOf(input.text), src: plan.src, start: plan.start, end: plan.end, marks: { [VOICEOVER_MARK]: mark } } as ClipNode);
		// Phụ đề của giọng LUÔN có; người dùng không muốn thì nó nằm ẩn — bật mắt
		// trên timeline (hay "Show captions" ở inspector) là có ngay, không phải sinh lại.
		children.push(voiceCaptions(next, key, plan.start, input.mode, !(input.captions ?? true)));
		root.children = children;
		return checked(next, 'That voiceover cannot be added');
	},
};

// ---------------------------------------------------------------------------
// Giọng đã về

const wordSchema = z.object({ text: z.string().max(200), start: z.number().finite().min(0), end: z.number().finite().min(0) });

export const syncVoiceoverInput = z.object({
	op: z.literal('sync_voiceover'),
	key: z.string().min(1).max(40),
	duration: z.number().finite().positive().max(3600),
	words: z.array(wordSchema).max(20000).optional(),
});
type SyncInput = z.infer<typeof syncVoiceoverInput>;

/** Mốc chữ → transcript: một dòng mỗi câu (dấu chấm/hỏi/than) hoặc mỗi 12 từ. */
export function voiceTranscript(words: Word[]): Transcript {
	const out: Transcript = [];
	let line: Word[] = [];
	const flush = () => {
		if (line.length) out.push({ text: line.map((word) => word.text).join(' '), words: line });
		line = [];
	};
	const spoken = words.filter((word) => word.text.trim());
	spoken.forEach((word, index) => {
		const next = spoken[index + 1];
		let end = Math.max(word.start, word.end);
		// Mốc của TTS có khe vài chục ms giữa hai chữ; transcript của video thì chữ
		// nối liền chữ. Khe rơi trúng một frame là phụ đề tắt rồi hiện lại giữa câu
		// (đo thật 01/10: khung 20.0s trống). Trong một dòng thì nối hết; sang dòng
		// mới chỉ nối khe ngắn — khoảng nghỉ thật giữa hai câu vẫn để trống.
		const breaks = /[.!?…]["')\]]*$/.test(word.text) || line.length + 1 >= 12;
		if (next && next.start > end && (!breaks || next.start - end <= LINE_GAP)) end = next.start;
		line.push({ text: word.text, start: round(word.start), end: round(end) });
		if (breaks) flush();
	});
	flush();
	return out;
}

export const syncVoiceover = {
	name: 'sync_voiceover',
	agent: false,
	input: syncVoiceoverInput,
	describe: () => 'Attach the generated voiceover',
	async apply(document: ClipDocument, input: SyncInput, ctx: OpContext) {
		const next = clone(document);
		let audio: Entity | null = null;
		const captions: Entity[] = [];
		walk(next, ({ entity, tag }) => {
			const mark = markOf(entity as never);
			if (!mark || mark.key !== input.key) return;
			if (tag === 'audio') audio = entity;
			if (tag === 'captions') captions.push(entity);
		});
		if (!audio) throw new OpFailure('This voiceover is no longer in the clip.');
		const node = audio as Entity;
		const start = typeof node.start === 'number' ? node.start : 0;
		node.end = round(start + input.duration);
		setMark(node, VOICEOVER_MARK, { ...markOf(node as never)!, synced: true });
		const transcript = input.words?.length ? voiceTranscript(input.words) : [];
		if (captions.length && transcript.length) {
			const src = await ctx.saveTranscript(transcript);
			for (const entity of captions) {
				entity.src = src;
				entity.start = start;
			}
		}
		return checked(next, 'That voiceover cannot be attached');
	},
};

export const captionVoiceoverInput = z.object({
	op: z.literal('caption_voiceover'),
	key: z.string().min(1).max(40),
	/** Mốc từng chữ của giọng (generation); cần khi voiceover chưa có lớp phụ đề nào. */
	words: z.array(wordSchema).max(20000).optional(),
});
type CaptionVoiceoverInput = z.infer<typeof captionVoiceoverInput>;

/**
 * Phụ đề cho một voiceover đã có: lớp đang ẩn thì hiện ra; voiceover tạo khi chưa
 * có lớp đi kèm (trước 09/10/2026) thì dựng lớp mới từ mốc chữ của giọng — miễn
 * phí, không chép lại lời. `agent: false`: mốc chữ nằm ở generation, editor lấy.
 */
export const captionVoiceover = {
	name: 'caption_voiceover',
	agent: false,
	input: captionVoiceoverInput,
	describe: () => 'Add captions from the voiceover',
	async apply(document: ClipDocument, input: CaptionVoiceoverInput, ctx: OpContext) {
		const next = clone(document);
		let audio: Entity | null = null;
		const captions: Entity[] = [];
		walk(next, ({ entity, tag }) => {
			const mark = markOf(entity as never);
			if (!mark || mark.key !== input.key) return;
			if (tag === 'audio') audio = entity;
			if (tag === 'captions') captions.push(entity);
		});
		if (!audio) throw new OpFailure('This voiceover is no longer in the clip.');
		const node = audio as Entity;
		const start = typeof node.start === 'number' ? node.start : 0;
		if (captions.length) {
			const hidden = captions.filter((entity) => entity.hidden);
			if (!hidden.length && captions.every((entity) => entity.src)) return document;
			for (const entity of hidden) delete entity.hidden;
			if (input.words?.length) {
				const src = await ctx.saveTranscript(voiceTranscript(input.words));
				for (const entity of captions) if (!entity.src) Object.assign(entity, { src, start });
			}
			return checked(next, 'Those captions cannot be added');
		}
		if (!input.words?.length) throw new OpFailure('The voiceover is still being generated. Try again when it plays.');
		const layer = voiceCaptions(next, input.key, start, (markOf(node as never)?.mode ?? 'overlay'), false) as unknown as Entity;
		layer.src = await ctx.saveTranscript(voiceTranscript(input.words));
		// Thẳng dưới scene (`captionsOnTop` đưa lên trên cùng), dù voiceover nằm trong một hàng âm thanh.
		const scene = sceneOf(next) as unknown as Entity;
		((scene.children as Entity[] | undefined) ??= []).push(layer);
		return checked(next, 'Those captions cannot be added');
	},
};

// ---------------------------------------------------------------------------
// Trạng thái suy ra (lượt hậu kỳ của applyOps)

type Span = { start: number; end: number };
type Keyframe = { time: number; value: number };
type Replaced = { videos: { muted: boolean }[]; captions: { hidden: boolean }[] };

const marksOf = (entity: Entity) => (entity.marks as Record<string, unknown> | undefined) ?? undefined;

function setMark(entity: Entity, name: string, value: unknown): void {
	const marks = { ...(marksOf(entity) ?? {}) };
	if (value === undefined) delete marks[name];
	else marks[name] = value;
	if (Object.keys(marks).length) entity.marks = marks;
	else delete entity.marks;
}

/** Mỗi video master + mốc CLIP tuyệt đối của nó (cộng `start` của cha). */
function masters(document: ClipDocument): { node: Entity; clipStart: number; sourceIn: number; sourceOut: number | null }[] {
	const out: { node: Entity; clipStart: number; sourceIn: number; sourceOut: number | null }[] = [];
	const visit = (node: ClipNode, offset: number) => {
		const entity = node as unknown as Entity;
		const at = offset + (typeof entity.start === 'number' ? entity.start : 0);
		if (isMasterSound(node)) {
			out.push({
				node: entity,
				clipStart: at,
				sourceIn: typeof entity.sourceIn === 'number' ? entity.sourceIn : 0,
				sourceOut: typeof entity.sourceOut === 'number' ? entity.sourceOut : null,
			});
			return;
		}
		for (const child of (node as { children?: ClipNode[] }).children ?? []) visit(child, node.kind === 'scene' ? 0 : at);
	};
	const scene = sceneOf(document);
	if (scene) visit(scene, 0);
	return out;
}

/** Khoảng CLIP → các khoảng NGUỒN trên các đoạn video master. */
export function sourceSpans(document: ClipDocument, span: Span): Span[] {
	const out: Span[] = [];
	for (const video of masters(document)) {
		const length = video.sourceOut === null ? Infinity : video.sourceOut - video.sourceIn;
		const from = Math.max(span.start, video.clipStart);
		const to = Math.min(span.end, video.clipStart + length);
		if (to <= from) continue;
		out.push({ start: round(video.sourceIn + from - video.clipStart), end: round(video.sourceIn + to - video.clipStart) });
	}
	return out;
}

function duckKeyframes(spans: Span[], base: number, duck: number): Keyframe[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: (Span & { duck: number })[] = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end + RAMP * 2) last.end = Math.max(last.end, span.end);
		else merged.push({ ...span, duck });
	}
	const frames: Keyframe[] = [];
	for (const span of merged) {
		frames.push(
			{ time: round(Math.max(0, span.start - RAMP)), value: base },
			{ time: round(span.start), value: round(base + duck) },
			{ time: round(span.end), value: round(base + duck) },
			{ time: round(span.end + RAMP), value: base },
		);
	}
	return frames;
}

const sameFrames = (a: unknown, b: Keyframe[]): boolean =>
	Array.isArray(a) &&
	a.length === b.length &&
	a.every((frame: { time?: unknown; value?: unknown }, index) => frame?.time === b[index]!.time && frame?.value === b[index]!.value);

/**
 * Tính lại mọi trạng thái suy ra từ voiceover. Document không có voiceover (và
 * chưa từng có) trả về NGUYÊN VẸN — không đụng tới golden của các op khác.
 */
export function syncVoiceovers(input: ClipDocument): ClipDocument {
	const scene0 = sceneOf(input) as unknown as Entity | undefined;
	if (!scene0) return input;
	const audios: { entity: Entity; mark: VoiceoverMark }[] = [];
	const voiceCaptions: { entity: Entity; list: Entity[] | null; key: string }[] = [];
	walk(input, ({ entity, tag }) => {
		const mark = markOf(entity as never);
		if (!mark) return;
		if (tag === 'audio') audios.push({ entity, mark });
	});
	const had = marksOf(scene0)?.[REPLACED_MARK] !== undefined || marksOf(scene0)?.[DUCK_MARK] !== undefined;
	let hasCaptions = false;
	walk(input, ({ entity, tag }) => {
		if (tag === 'captions' && markOf(entity as never)) hasCaptions = true;
	});
	if (!audios.length && !had && !hasCaptions) return input;

	const document = clone(input);
	const scene = sceneOf(document) as unknown as Entity;
	const live: { entity: Entity; mark: VoiceoverMark }[] = [];
	walk(document, ({ entity, tag, list }) => {
		const mark = markOf(entity as never);
		if (!mark) return;
		if (tag === 'audio') live.push({ entity, mark });
		if (tag === 'captions') voiceCaptions.push({ entity, list: list ?? null, key: mark.key });
	});
	const keys = new Set(live.map((item) => item.mark.key));

	// Phụ đề của voiceover đã xoá: xoá theo.
	for (const item of voiceCaptions) {
		if (keys.has(item.key) || !item.list) continue;
		item.list.splice(item.list.indexOf(item.entity), 1);
	}

	const videos = masters(document);
	// Chỉ phụ đề của video gốc: phụ đề người dùng tạo cho b-roll hay một file
	// âm thanh không phải lời của giọng bị thay — ẩn chúng là phụ đề "biến mất"
	// khỏi clip mà không ai bảo (UAT 09/10).
	const master = videos.length ? masterCaptions(document) : null;
	const videoCaptions: Entity[] = master ? [master as unknown as Entity] : [];

	// replace: tắt tiếng + ẩn phụ đề gốc; trả lại khi không còn voiceover replace.
	const replacing = live.some((item) => item.mark.mode === 'replace' && !item.entity.hidden && !item.entity.muted);
	const remembered = marksOf(scene)?.[REPLACED_MARK] as Replaced | undefined;
	if (replacing) {
		if (!remembered) {
			setMark(scene, REPLACED_MARK, {
				videos: videos.map((video) => ({ muted: video.node.muted === true })),
				captions: videoCaptions.map((captions) => ({ hidden: captions.hidden === true })),
			} satisfies Replaced);
		}
		for (const video of videos) video.node.muted = true;
		for (const captions of videoCaptions) captions.hidden = true;
	} else if (remembered) {
		// Cắt bằng chữ có thể đổi số đoạn: đoạn không có trong trí nhớ lấy theo đoạn đầu.
		for (const [index, video] of videos.entries()) {
			const prior = remembered.videos[index] ?? remembered.videos[0];
			if (prior?.muted) video.node.muted = true;
			else delete video.node.muted;
		}
		for (const [index, captions] of videoCaptions.entries()) {
			const prior = remembered.captions[index] ?? remembered.captions[0];
			if (prior?.hidden) captions.hidden = true;
			else delete captions.hidden;
		}
		setMark(scene, REPLACED_MARK, undefined);
	}

	// overlay: hạ tiếng video gốc trong lúc giọng đọc.
	const previous = (marksOf(scene)?.[DUCK_MARK] as { keyframes?: Keyframe[] } | undefined)?.keyframes;
	const overlays = live.filter((item) => item.mark.mode === 'overlay' && !item.entity.hidden && !item.entity.muted);
	const template = videos[0]?.node;
	const base = typeof template?.volume === 'number' ? template.volume : 0;
	const duck = overlays.length ? Math.min(...overlays.map((item) => item.mark.duck)) : 0;
	const spans = overlays.flatMap((item) => {
		const start = typeof item.entity.start === 'number' ? item.entity.start : 0;
		const end = typeof item.entity.end === 'number' ? item.entity.end : start;
		return sourceSpans(document, { start, end });
	});
	const frames = spans.length ? duckKeyframes(spans, base, duck) : [];
	for (const video of videos) {
		const tracks = ((video.node.tracks as Entity[] | undefined) ?? []).filter(
			(track) => !(track.property === 'volume' && previous && sameFrames(track.keyframes, previous)),
		);
		if (frames.length) tracks.push({ property: 'volume', keyframes: frames.map((frame) => ({ ...frame })) });
		if (tracks.length) video.node.tracks = tracks;
		else delete video.node.tracks;
	}
	setMark(scene, DUCK_MARK, frames.length ? { keyframes: frames } : undefined);
	return document;
}
