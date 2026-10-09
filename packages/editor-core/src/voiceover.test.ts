import { describe, expect, it } from 'vitest';

import { validate, type ClipDocument } from '@opencmo/clip-doc';

import { readCaptionState } from './captions';
import { aiModel, priceOf, specSchema } from './generate';
import { AGENT_OP_INPUTS, applyOps, planVoiceover, sourceSpans, voiceTranscript, type OpContext } from './ops';
import { normalize, type Transcript } from './transcript';

const TRANSCRIPT: Transcript = [
	{ text: 'so this is um the thing', words: [
		{ text: 'so', start: 2.1, end: 2.3 }, { text: 'this', start: 2.35, end: 2.6 }, { text: 'is', start: 2.65, end: 2.8 },
		{ text: 'um', start: 3.0, end: 3.4 }, { text: 'the', start: 3.5, end: 3.7 }, { text: 'thing', start: 3.75, end: 4.2 },
	] },
	{ text: 'you need', words: [{ text: 'you', start: 10, end: 10.3 }, { text: 'need', start: 10.35, end: 10.8 }] },
];

const SOURCE = {
	version: 1,
	stage: { children: [{
		kind: 'scene', width: 1080, height: 1920, fill: '#000000', active: true, workarea: [0, 30],
		children: [
			{ kind: 'video', src: 'assets/master.mp4', x: 0, y: 0, width: 1080, height: 1920, start: 0, sourceIn: 2, sourceOut: 32 },
			{ kind: 'captions', src: 'assets/transcript.json', preset: 'classic', colors: ['#FFD400'], verticalAlign: 'bottom', offsetY: -230, start: 0, sourceIn: 2, sourceOut: 32 },
		],
	}] },
} as unknown as ClipDocument;

function memoryContext(): OpContext & { files: Map<string, Transcript> } {
	const files = new Map<string, Transcript>([['assets/transcript.json', TRANSCRIPT]]);
	return {
		files,
		master: { width: 1080, height: 1920 },
		readTranscript: async (path) => structuredClone(files.get(path) ?? []),
		saveTranscript: async (transcript) => {
			const path = `assets/transcripts/${String(files.size).padStart(64, '0')}.json`;
			files.set(path, structuredClone(transcript));
			return path;
		},
	};
}

type Entity = Record<string, unknown>;
const all = (document: ClipDocument): Entity[] => {
	const out: Entity[] = [];
	const visit = (node: Entity) => {
		out.push(node);
		for (const child of (node.children as Entity[] | undefined) ?? []) visit(child);
	};
	for (const node of document.stage.children as unknown as Entity[]) visit(node);
	return out;
};
const videos = (document: ClipDocument) => all(document).filter((node) => node.kind === 'video');
const captions = (document: ClipDocument) => all(document).filter((node) => node.kind === 'captions');
const voice = (document: ClipDocument) => all(document).find((node) => node.kind === 'audio')!;
const keyOf = (document: ClipDocument) => ((voice(document).marks as Entity).voiceover as { key: string }).key;

describe('add_voiceover', () => {
	it('replace: khai báo generate.voice + phụ đề mới cùng kiểu; tắt tiếng video, ẩn phụ đề gốc', async () => {
		const { document } = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'Here is the new take on this idea.', voice: 'Test A', mode: 'replace' }], memoryContext());
		expect(() => validate(document)).not.toThrow();
		expect(voice(document)).toMatchObject({ src: { generate: 'voice', prompt: 'Here is the new take on this idea.', voice: 'Test A' }, start: 0, end: 2.667 });
		const [original, spoken] = captions(document);
		expect(original).toMatchObject({ hidden: true, src: 'assets/transcript.json' });
		expect(spoken).toMatchObject({ preset: 'classic', colors: ['#FFD400'], verticalAlign: 'bottom', offsetY: -230, start: 0 });
		expect(spoken!.src).toBeUndefined();
		expect(videos(document).every((video) => video.muted === true)).toBe(true);
	});

	it('xoá voiceover replace trả lại tiếng + phụ đề gốc, xoá luôn phụ đề của giọng', async () => {
		const ctx = memoryContext();
		const added = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'New take.', voice: 'Test A', mode: 'replace' }], ctx);
		const id = voice(added.document).id as string;
		const { document } = await applyOps(added.document, [{ op: 'delete_element', element_id: id }], ctx);
		expect(captions(document)).toHaveLength(1);
		expect(captions(document)[0]!.hidden).toBeUndefined();
		expect(videos(document)[0]!.muted).toBeUndefined();
		expect((document.stage.children[0] as unknown as Entity).marks).toBeUndefined();
	});

	it('overlay: hạ tiếng video gốc theo giây NGUỒN trong lúc giọng đọc; captions: false → phụ đề của giọng nằm ẩn', async () => {
		const { document } = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'one two three four five', voice: 'Test B', mode: 'overlay', start: 5, captions: false }], memoryContext());
		expect(captions(document)).toHaveLength(2);
		expect(captions(document)[1]).toMatchObject({ name: 'Voiceover captions', hidden: true });
		expect(captions(document)[0]!.hidden).toBeUndefined();
		expect(videos(document)[0]!.muted).toBeUndefined();
		const track = (videos(document)[0]!.tracks as { property: string; keyframes: { time: number; value: number }[] }[]).find((t) => t.property === 'volume')!;
		// 5 từ ÷ 3 từ/giây: clip 5 → 6.667 giây = nguồn 7 → 8.667.
		expect(track.keyframes).toMatchObject([
			{ time: 6.75, value: 0 }, { time: 7, value: -18 }, { time: 8.667, value: -18 }, { time: 8.917, value: 0 },
		]);
	});

	it('overlay có phụ đề: đặt ở nửa khung kia, không chồng phụ đề gốc (export TED 02/10)', async () => {
		const { document } = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'one two three', voice: 'Test B', mode: 'overlay', start: 5, captions: true }], memoryContext());
		const all = (document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.filter((node) => node.kind === 'captions');
		expect(all).toHaveLength(2);
		const voice = all.find((node) => node.marks)!;
		// Gốc: đáy, nâng 230 px (tâm ~78% khung) → giọng mới lên đỉnh.
		expect(voice).toMatchObject({ verticalAlign: 'top', offsetY: 0, preset: 'classic' });
		const top = structuredClone(SOURCE) as unknown as { stage: { children: { children: Record<string, unknown>[] }[] } };
		Object.assign(top.stage.children[0]!.children[1]!, { verticalAlign: 'top', offsetY: 40 });
		const flipped = await applyOps(top as unknown as ClipDocument, [{ op: 'add_voiceover', text: 'one two three', voice: 'Test B', mode: 'overlay', start: 5, captions: true }], memoryContext());
		const again = (flipped.document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.find((node) => node.kind === 'captions' && node.marks)!;
		expect(again).toMatchObject({ verticalAlign: 'bottom', offsetY: 0 });
	});

	it('phụ đề giọng mới cùng kiểu chữ với phụ đề clip: font, độ đậm, màu chữ', async () => {
		const styled = structuredClone(SOURCE) as unknown as { stage: { children: { children: Record<string, unknown>[] }[] } };
		Object.assign(styled.stage.children[0]!.children[1]!, { fontFamily: 'Bebas Neue', fontWeight: 400, color: '#FFD400' });
		const { document } = await applyOps(styled as unknown as ClipDocument, [{ op: 'add_voiceover', text: 'one two three', voice: 'Test B', mode: 'overlay', start: 5, captions: true }], memoryContext());
		const voice = (document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.find((node) => node.kind === 'captions' && node.marks)!;
		expect(voice).toMatchObject({ fontFamily: 'Bebas Neue', fontWeight: 400, color: '#FFD400', preset: 'classic' });
	});

	it('overlay theo quote: bắt đầu khi người nói nói câu đó', async () => {
		const plan = await planVoiceover(SOURCE, { op: 'add_voiceover', text: 'aside', voice: 'Test A', mode: 'overlay', quote: 'you need' }, memoryContext());
		expect(plan.start).toBe(8);
	});

	it('cắt bằng chữ sau overlay: mốc hạ tiếng tính lại trên các đoạn mới, không nhân đôi track', async () => {
		const ctx = memoryContext();
		const added = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'one two three four five six seven eight nine ten', voice: 'Test A', mode: 'overlay', start: 0.5 }], ctx);
		const ids = normalize(TRANSCRIPT)[0]!.words.map((word) => word.id!);
		const { document } = await applyOps(added.document, [{ op: 'remove_words', word_ids: [ids[3]!] }], ctx);
		expect(readCaptionState(document)!.removed.length).toBe(1);
		const segments = videos(document);
		expect(segments.length).toBe(2);
		for (const segment of segments) {
			const volume = (segment.tracks as { property: string }[]).filter((t) => t.property === 'volume');
			expect(volume).toHaveLength(1);
		}
		// Clip 0.5 → 4.5 phủ qua chỗ cắt: hai khoảng nguồn, gộp vì sát nhau.
		expect(sourceSpans(document, { start: 0.5, end: 4.5 }).length).toBe(2);
		// Phụ đề video (không phải của giọng) vẫn là thứ bị cắt.
		expect(captions(document)[0]!.src).toMatch(/^assets\/transcripts\//);
	});

	it('sync_voiceover: độ dài thật + mốc chữ → end của audio và transcript cho phụ đề của giọng', async () => {
		const ctx = memoryContext();
		const added = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'Hello there. New world', voice: 'Test A', mode: 'replace', start: 1 }], ctx);
		const key = keyOf(added.document);
		const words = [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'there.', start: 0.45, end: 0.9 }, { text: 'New', start: 1.2, end: 1.4 }, { text: 'world', start: 1.45, end: 1.9 }];
		const { document } = await applyOps(added.document, [{ op: 'sync_voiceover', key, duration: 2.1, words }], ctx);
		expect(voice(document).end).toBe(3.1);
		const spoken = captions(document)[1]!;
		expect(spoken.start).toBe(1);
		const saved = ctx.files.get(spoken.src as string)!;
		expect(saved.map((line) => line.text)).toEqual(['Hello there.', 'New world']);
	});

	it('kiểu phụ đề đổi cho cả phụ đề gốc lẫn phụ đề của giọng', async () => {
		const ctx = memoryContext();
		const added = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'x y', voice: 'Test A', mode: 'replace' }], ctx);
		const { document } = await applyOps(added.document, [{ op: 'set_caption_style', preset: 'spotlight' }], ctx);
		expect(captions(document).map((node) => node.preset)).toEqual(['spotlight', 'spotlight']);
	});

	it('document không có voiceover đi qua nguyên vẹn (không thêm mark)', async () => {
		const { document } = await applyOps(SOURCE, [{ op: 'set_workarea', start: 0, end: 20 }], memoryContext());
		expect((document.stage.children[0] as unknown as Entity).marks).toBeUndefined();
	});

	it('agent không gọi thẳng; giá theo ký tự của model ElevenLabs', async () => {
		expect(AGENT_OP_INPUTS.add_voiceover).toBeUndefined();
		expect(AGENT_OP_INPUTS.sync_voiceover).toBeUndefined();
		const model = aiModel('elevenlabs-voice')!;
		const plan = await planVoiceover(SOURCE, { op: 'add_voiceover', text: 'a'.repeat(1500), voice: 'Aria', mode: 'replace' }, memoryContext());
		expect(priceOf(model, specSchema(model).parse(plan.spec))).toBe(10);
	});

	it('voiceTranscript ngắt dòng theo câu và tối đa 12 từ', () => {
		const words = Array.from({ length: 14 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
		expect(voiceTranscript(words).map((line) => line.words.length)).toEqual([12, 2]);
	});

	it('voiceTranscript nối khe giữa các chữ: phụ đề không nhấp nháy giữa câu', () => {
		// Mốc thật của ElevenLabs (01/10): "was" hết 19.98, "arranged" bắt đầu 20.038 —
		// khung 20.0 rơi vào khe 58ms và phụ đề tắt giữa câu. Transcript của video
		// thì chữ nối liền chữ (end = start của chữ sau).
		const words = [
			{ text: 'even', start: 9.067, end: 9.253 },
			{ text: 'born.', start: 9.311, end: 9.764 },
			{ text: 'His', start: 10.147, end: 10.31 },
			{ text: 'mother.', start: 10.379, end: 11.006 },
			{ text: 'Everything', start: 11.2, end: 11.5 },
			{ text: 'was', start: 11.6, end: 19.98 },
			{ text: 'arranged.', start: 20.038, end: 20.398 },
		];
		const lines = voiceTranscript(words);
		for (const line of lines) {
			line.words.slice(1).forEach((word, i) => expect(line.words[i]!.end).toBe(word.start));
		}
		// Giữa hai câu: khe ngắn (≤ 0.3s) nối luôn, khoảng nghỉ thật (0.38s) giữ nguyên.
		expect(lines[1]!.words.at(-1)!.end).toBe(11.2);
		expect(lines[0]!.words.at(-1)!.end).toBe(9.764);
		// Mốc bắt đầu không đổi: chữ hiện đúng lúc được đọc.
		expect(lines.flatMap((line) => line.words.map((word) => word.start))).toEqual(words.map((word) => word.start));
	});
});
