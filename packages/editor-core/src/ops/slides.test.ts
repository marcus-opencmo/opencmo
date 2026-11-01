import { describe, expect, it } from 'vitest';

import { slideSpans, timingIssues, validate, type ClipDocument } from '@opencmo/clip-doc';

import { DEFAULT_BRAND } from '../brand';
import { OP_NAMES, applyOps, type OpContext } from './index';

const BLANK = { version: 1, stage: { children: [{ kind: 'scene', name: 'Main', width: 1080, height: 1920, active: true, children: [] }] } } as unknown as ClipDocument;
const CTX = {} as OpContext;
type Layer = { name: string; kind: string; start: number; end: number; text?: string; fill?: string; fontFamily?: string };
type Group = { id: string; start: number; end: number; children: Layer[] };
const sceneOf = (document: ClipDocument) => document.stage.children[0] as unknown as { children: Group[]; workarea: number[]; marks?: { markers?: { id: string; name: string; time: number; duration: number }[] } };

async function three() {
	const { document } = await applyOps(BLANK, [
		{ op: 'add_slide', heading: 'One', duration: 2 },
		{ op: 'add_slide', heading: 'Two', body: 'Second', duration: 3 },
		{ op: 'add_slide', heading: 'Three' },
	], CTX);
	return document;
}
const headings = (document: ClipDocument) => sceneOf(document).children.map((slide) => slide.children.find((layer) => layer.name === 'Heading')!.text);
const run = async (document: ClipDocument, op: Record<string, unknown>) => (await applyOps(document, [op], CTX)).document;

describe('slide ops', () => {
	it('are in the registry', () => {
		expect(OP_NAMES).toEqual(expect.arrayContaining(['add_slide', 'move_slide', 'delete_slide', 'set_slide_duration', 'set_slide_text']));
	});

	it('add_slide builds touching slides that validate, with markers and a work area', async () => {
		const document = await three();
		expect(() => validate(document)).not.toThrow();
		expect(timingIssues(document)).toEqual([]);
		expect(slideSpans(document).map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 5], [5, 9]]);
		const scene = sceneOf(document);
		expect(scene.workarea).toEqual([0, 9]);
		expect(scene.marks?.markers?.map((marker) => [marker.name, marker.time, marker.duration])).toEqual([['Slide 1', 0, 2], ['Slide 2', 2, 3], ['Slide 3', 5, 4]]);
		expect(scene.children[1]!.children.map((layer) => [layer.name, layer.start, layer.end])).toEqual([['Background', 0, 3], ['Heading', 0, 3], ['Body', 0, 3]]);
	});

	it('add_slide after a slide inserts it there; an image background stays cover', async () => {
		const document = await three();
		const after = sceneOf(document).children[0]!.id;
		const next = await run(document, { op: 'add_slide', after, heading: 'Between', background: { src: 'shot.png' } });
		expect(headings(next)).toEqual(['One', 'Between', 'Two', 'Three']);
		expect(sceneOf(next).children[1]!.children[0]).toMatchObject({ kind: 'image', src: 'shot.png', objectFit: 'cover' });
		// White text must read on a bright screenshot.
		expect(sceneOf(next).children[1]!.children[1]).toMatchObject({ name: 'Scrim', kind: 'rect', opacity: 0.45 });
		expect(() => validate(next)).not.toThrow();
	});

	it('move_slide reorders and keeps every duration', async () => {
		const document = await three();
		const next = await run(document, { op: 'move_slide', slide_id: sceneOf(document).children[2]!.id, to: 0 });
		expect(headings(next)).toEqual(['Three', 'One', 'Two']);
		expect(slideSpans(next).map(({ start, end }) => [start, end])).toEqual([[0, 4], [4, 6], [6, 9]]);
	});

	it('delete_slide closes the gap and refuses the last slide', async () => {
		let document = await three();
		document = await run(document, { op: 'delete_slide', slide_id: sceneOf(document).children[0]!.id });
		expect(slideSpans(document).map(({ start, end }) => [start, end])).toEqual([[0, 3], [3, 7]]);
		expect(sceneOf(document).marks?.markers).toHaveLength(2);
		document = await run(document, { op: 'delete_slide', slide_id: sceneOf(document).children[0]!.id });
		await expect(run(document, { op: 'delete_slide', slide_id: sceneOf(document).children[0]!.id })).rejects.toThrow(/at least one slide/);
	});

	it('set_slide_duration moves the later slides and stretches the layers', async () => {
		const document = await three();
		const next = await run(document, { op: 'set_slide_duration', slide_id: sceneOf(document).children[0]!.id, seconds: 6 });
		expect(slideSpans(next).map(({ start, end }) => [start, end])).toEqual([[0, 6], [6, 9], [9, 13]]);
		expect(sceneOf(next).children[0]!.children.every((layer) => layer.end === 6)).toBe(true);
	});

	it('set_slide_text edits, adds and removes the body', async () => {
		const document = await three();
		const [first, second] = sceneOf(document).children;
		let next = await run(document, { op: 'set_slide_text', slide_id: first!.id, heading: 'New', body: 'Added' });
		expect(sceneOf(next).children[0]!.children.map((layer) => layer.text).filter(Boolean)).toEqual(['New', 'Added']);
		next = await run(next, { op: 'set_slide_text', slide_id: second!.id, body: '' });
		expect(sceneOf(next).children[1]!.children.map((layer) => layer.name)).toEqual(['Background', 'Heading']);
		await expect(run(next, { op: 'set_slide_text', slide_id: first!.id })).rejects.toThrow();
	});

	it('refuses a timeline with video, an unknown slide and a slide past the limit', async () => {
		const video = structuredClone(BLANK);
		(video.stage.children[0] as unknown as { children: unknown[] }).children = [{ kind: 'video', src: 'assets/master.mp4', start: 0, sourceIn: 0, sourceOut: 5 }];
		await expect(run(video, { op: 'add_slide', heading: 'No' })).rejects.toThrow(/New slideshow/);
		await expect(run(await three(), { op: 'move_slide', slide_id: 'nope', to: 0 })).rejects.toThrow(/no slide/);
		const { document: full } = await applyOps(BLANK, Array.from({ length: 35 }, (_, index) => ({ op: 'add_slide', heading: `S${index}`, duration: 1 })), CTX);
		await expect(run(full, { op: 'add_slide', heading: 'Too many' })).rejects.toThrow(/at most 35/);
	});

	it('update_visual refuses a slide; apply_brand recolours it', async () => {
		const document = await three();
		const id = sceneOf(document).children[0]!.id;
		await expect(run(document, { op: 'update_visual', id, changes: {} })).rejects.toThrow(/not a visual/);
		const kit = { ...DEFAULT_BRAND, colors: { ...DEFAULT_BRAND.colors, text: '#ABCDEF', background: '#123456' } };
		const branded = await run(document, { op: 'apply_brand', kit, frame: false });
		const layers = sceneOf(branded).children[0]!.children;
		expect(layers.find((layer) => layer.name === 'Background')!.fill).toBe('#123456');
		expect(layers.find((layer) => layer.name === 'Heading')).toMatchObject({ color: '#ABCDEF' });
	});
});
