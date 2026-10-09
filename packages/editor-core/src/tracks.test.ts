import { describe, expect, it } from 'vitest';

import { validate, type ClipDocument } from '@opencmo/clip-doc';

import { applyOps, type OpContext } from './ops';
import { laneOf } from './tracks';
import type { Transcript } from './transcript';

type Entity = Record<string, unknown>;

const TRANSCRIPT: Transcript = [{ text: 'hello there', words: [{ text: 'hello', start: 0, end: 0.5 }, { text: 'there', start: 0.5, end: 1 }] }];

const SOURCE = {
	version: 1,
	stage: { children: [{
		kind: 'scene', width: 1080, height: 1920, fill: '#000000', active: true, workarea: [0, 30],
		children: [
			{ kind: 'video', src: 'assets/master.mp4', x: 0, y: 0, width: 1080, height: 1920, start: 0, sourceIn: 0, sourceOut: 30 },
			{ kind: 'text', text: 'Hook', x: 0, y: 0, width: 500, height: 100 },
			{ kind: 'captions', src: 'assets/transcript.json', preset: 'classic', verticalAlign: 'bottom', start: 0, sourceIn: 0, sourceOut: 30 },
		],
	}] },
} as unknown as ClipDocument;

const DURATIONS: Record<string, number> = { 'library/a.mp4': 3, 'library/b.mp4': 3, 'library/c.mp4': 3, 'library/song.mp3': 10 };

function context(): OpContext {
	const files = new Map<string, Transcript>([['assets/transcript.json', TRANSCRIPT]]);
	return {
		master: { width: 1080, height: 1920 },
		readTranscript: async (path) => structuredClone(files.get(path) ?? []),
		saveTranscript: async (transcript) => {
			const path = `assets/transcripts/${String(files.size).padStart(64, '0')}.json`;
			files.set(path, structuredClone(transcript));
			return path;
		},
		media: {
			duration: (src) => (typeof src === 'string' ? (DURATIONS[src] ?? (src === 'assets/master.mp4' ? 30 : null)) : null),
			transcript: (src) => (files.get(src) as never) ?? null,
		},
	};
}

const broll = (src: string, start?: number) => ({
	kind: 'rect', name: src, x: 0, y: 0, width: 1080, height: 1920, keepAspectRatio: true,
	...(start ? { start } : {}),
	paints: [{ type: 'video', src }],
});

const top = (document: ClipDocument) => (document.stage.children[0] as unknown as { children: Entity[] }).children;
const sequences = (document: ClipDocument) => top(document).filter((node) => node.kind === 'sequence');

describe('insert_to_row', () => {
	it('b-roll không chồng giờ vào CHUNG một hàng, nằm dưới chữ và phụ đề', async () => {
		const ctx = context();
		let { document } = await applyOps(SOURCE, [{ op: 'insert_to_row', node: broll('library/a.mp4', 1) }], ctx);
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: broll('library/b.mp4', 5) }], ctx));
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: broll('library/c.mp4', 10) }], ctx));
		expect(() => validate(document)).not.toThrow();
		const rows = sequences(document);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'B-roll 1' });
		expect((rows[0]!.children as Entity[]).map((child) => child.name)).toEqual(['library/a.mp4', 'library/b.mp4', 'library/c.mp4']);
		expect(top(document).map((node) => node.kind)).toEqual(['video', 'sequence', 'text', 'captions']);
	});

	it('chồng một frame ở đầu (playhead kẹp ở frame cuối) thì dời cho khít, vẫn chung hàng', async () => {
		const ctx = context();
		let { document } = await applyOps(SOURCE, [{ op: 'insert_to_row', node: { ...broll('library/a.mp4', 1), end: 4 } }], ctx);
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: { ...broll('library/b.mp4', 3.9667), end: 6.9667 } }], ctx));
		const rows = sequences(document);
		expect(rows).toHaveLength(1);
		expect((rows[0]!.children as Entity[])[1]).toMatchObject({ start: 4, end: 7 });
	});

	it('chồng giờ thì mở hàng mới', async () => {
		const ctx = context();
		let { document } = await applyOps(SOURCE, [{ op: 'insert_to_row', node: broll('library/a.mp4', 1) }], ctx);
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: broll('library/b.mp4', 2) }], ctx));
		expect(sequences(document).map((row) => row.name)).toEqual(['B-roll 1', 'B-roll 2']);
	});

	it('âm thanh vào hàng Audio riêng, không lẫn với b-roll', async () => {
		const ctx = context();
		let { document } = await applyOps(SOURCE, [{ op: 'insert_to_row', node: broll('library/a.mp4') }], ctx);
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: { kind: 'audio', name: 'song', src: 'library/song.mp3', x: 0, y: 0, width: 500, height: 150 } }], ctx));
		expect(sequences(document).map((row) => [row.name, laneOf(row)])).toEqual([['B-roll 1', 'visual'], ['Audio 1', 'audio']]);
	});
});

describe('move_to_row', () => {
	it('gom b-roll của project cũ (mỗi cái một lớp) vào một hàng; clip đơn thành hàng', async () => {
		const ctx = context();
		const old = structuredClone(SOURCE);
		top(old).splice(1, 0, { ...broll('library/a.mp4', 1), id: 'a' }, { ...broll('library/b.mp4', 6), id: 'b' }, { ...broll('library/c.mp4', 12), id: 'c' });
		const { document } = await applyOps(old, [{ op: 'move_to_row', element_ids: ['b', 'c'], target_id: 'a' }], ctx);
		expect(() => validate(document)).not.toThrow();
		const rows = sequences(document);
		expect(rows).toHaveLength(1);
		expect((rows[0]!.children as Entity[]).map((child) => child.id)).toEqual(['a', 'b', 'c']);
		expect(top(document).map((node) => node.kind)).toEqual(['video', 'sequence', 'text', 'captions']);
	});

	it('kéo ra hàng riêng: hàng nguồn rỗng thì biến mất; khác làn bị từ chối', async () => {
		const ctx = context();
		let { document } = await applyOps(SOURCE, [{ op: 'insert_to_row', node: broll('library/a.mp4', 1) }], ctx);
		const row = sequences(document)[0]!;
		const clip = (row.children as Entity[])[0]!;
		const scene = document.stage.children[0] as unknown as Entity;
		({ document } = await applyOps(document, [{ op: 'move_to_row', element_ids: [clip.id as string], target_id: scene.id as string }], ctx));
		expect(sequences(document)).toHaveLength(0);
		expect(top(document).map((node) => node.kind)).toEqual(['video', 'rect', 'text', 'captions']);

		const text = top(document).find((node) => node.kind === 'text')!;
		await expect(applyOps(document, [{ op: 'move_to_row', element_ids: [text.id as string], target_id: clip.id as string }], ctx)).rejects.toThrow(
			'Text can only share a row with text.',
		);
	});

	it('clip dời tới thắng chỗ chồng giờ (anh em nhường)', async () => {
		const ctx = context();
		const old = structuredClone(SOURCE);
		top(old).splice(1, 0, { ...broll('library/a.mp4', 1), id: 'a' }, { ...broll('library/b.mp4', 2), id: 'b' });
		const { document } = await applyOps(old, [{ op: 'move_to_row', element_ids: ['b'], target_id: 'a' }], ctx);
		const kids = sequences(document)[0]!.children as Entity[];
		expect(kids.find((child) => child.id === 'a')).toMatchObject({ start: 1, end: 2 });
	});

	it('hàng phụ đề vẫn nằm trên cùng', async () => {
		const ctx = context();
		const old = structuredClone(SOURCE);
		top(old).push({ kind: 'captions', id: 'k2', src: 'assets/transcript.json', start: 20 });
		const first = top(old).find((node) => node.kind === 'captions')!;
		first.id = 'k1';
		first.sourceOut = 10;
		let { document } = await applyOps(old, [{ op: 'move_to_row', element_ids: ['k2'], target_id: 'k1' }], ctx);
		({ document } = await applyOps(document, [{ op: 'insert_to_row', node: broll('library/a.mp4', 1) }], ctx));
		expect(top(document).at(-1)).toMatchObject({ kind: 'sequence' });
		expect(laneOf(top(document).at(-1)!)).toBe('captions');
	});
});

describe('insert_captions', () => {
	it('phụ đề mới chạy cùng lúc với phụ đề gốc thì lên nửa trên', async () => {
		const ctx = context();
		const scene = structuredClone(SOURCE.stage.children[0]) as unknown as Entity;
		const doc = { version: 1, stage: { children: [{ ...scene, id: 'scene' }] } } as unknown as ClipDocument;
		const { document } = await applyOps(doc, [{ op: 'insert_captions', parent_id: 'scene', node: { kind: 'captions', src: 'assets/transcript.json', start: 2 } }], ctx);
		const layers = top(document).filter((node) => node.kind === 'captions');
		expect(layers).toHaveLength(2);
		expect(layers[1]).toMatchObject({ verticalAlign: 'top', offsetY: 0 });
	});

	it('không chồng giờ thì giữ chỗ mặc định', async () => {
		const ctx = context();
		const doc = structuredClone(SOURCE);
		const scene = doc.stage.children[0] as unknown as Entity;
		scene.id = 'scene';
		const own = top(doc).find((node) => node.kind === 'captions')!;
		own.sourceOut = 1;
		const { document } = await applyOps(doc, [{ op: 'insert_captions', parent_id: 'scene', node: { kind: 'captions', src: 'assets/transcript.json', start: 20 } }], ctx);
		expect(top(document).filter((node) => node.kind === 'captions')[1]!.verticalAlign).toBeUndefined();
	});
});

describe('caption_voiceover', () => {
	const words = [{ text: 'Fresh', start: 0, end: 0.4 }, { text: 'take.', start: 0.45, end: 0.9 }];

	it('voiceover cũ không có lớp phụ đề: dựng từ mốc chữ; replace KHÔNG ẩn phụ đề b-roll', async () => {
		const ctx = context();
		const doc = structuredClone(SOURCE);
		top(doc).push(
			{ kind: 'captions', name: 'Captions · talk.mp4', src: 'assets/transcript.json', start: 3 },
			{ kind: 'audio', name: 'Voiceover: x', src: 'library/vo.mp3', start: 2, end: 3, marks: { voiceover: { key: 'k1', mode: 'replace', duck: -18, synced: true } } },
		);
		const { document } = await applyOps(doc, [{ op: 'caption_voiceover', key: 'k1', words }], ctx);
		expect(() => validate(document)).not.toThrow();
		const layers = top(document).filter((node) => node.kind === 'captions');
		expect(layers.map((layer) => [layer.name, layer.hidden ?? false])).toEqual([
			[undefined, true],
			['Captions · talk.mp4', false],
			['Voiceover captions', false],
		]);
		expect(layers[2]).toMatchObject({ start: 2, marks: { voiceover: { key: 'k1' } } });
		expect(String(layers[2]!.src)).toMatch(/^assets\/transcripts\//);
	});

	it('lớp phụ đề đang ẩn thì hiện ra; chưa có mốc chữ và chưa có lớp thì báo lỗi', async () => {
		const ctx = context();
		const added = await applyOps(SOURCE, [{ op: 'add_voiceover', text: 'Fresh take.', voice: 'A', mode: 'overlay', start: 4, captions: false }], ctx);
		const audio = top(added.document).find((node) => node.kind === 'audio')!;
		const key = ((audio.marks as Entity).voiceover as { key: string }).key;
		const { document } = await applyOps(added.document, [{ op: 'caption_voiceover', key }], ctx);
		expect(top(document).find((node) => node.name === 'Voiceover captions')!.hidden).toBeUndefined();

		const bare = structuredClone(SOURCE);
		top(bare).push({ kind: 'audio', src: 'library/vo.mp3', marks: { voiceover: { key: 'k9', mode: 'overlay', duck: -18 } } });
		await expect(applyOps(bare, [{ op: 'caption_voiceover', key: 'k9' }], ctx)).rejects.toThrow('still being generated');
	});
});
