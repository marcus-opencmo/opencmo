/**
 * Slide ops (P5 B1): a slideshow is a document of timed
 * slides on one timeline, not a second editor (`docs/architecture/studio.md` §7).
 *
 * Document shape, with no `clip-doc` schema change:
 * - A slide is a group directly under the scene with `start` and `end`, marked `marks.visual = { op: 'add_slide',
 *   input }` (`slideSpans` in `clip-doc` finds them). Slides touch: the first starts at 0, each next where the last ends.
 * - Its children are `Background` (a rect, or an image for `{src}` with a dark `Scrim` over it so white text reads on a
 *   bright screenshot), `Heading` and `Body` (text layers, never text inside an image), timed from the group's start. A child with no `end` would stop at the renderer's default length,
 *   so each carries `start: 0` and `end` = the slide's duration.
 * - The group is the truth. Each slide also has one marker in the scene's `marks.markers`, for navigation; every slide
 *   op rebuilds them, so a deleted marker comes back and none can drift.
 *
 * Colour and image changes after `add_slide` go through `set_props` and `replace_src` on `Background`.
 */

import { z } from 'zod';

import { MAX_SLIDES, SLIDE_OP, type ClipDocument, type Marker } from '@opencmo/clip-doc';

import { readBrand, themeFromBrand } from '../brand';
import { clone, drawId, type Entity } from '../doc';
import { LOGO_MARK } from './brand';
import { OpFailure } from './context';
import { activeScene } from './timeline';

export { MAX_SLIDES };
export const SLIDE_SECONDS = { min: 1, max: 30, default: 4 } as const;
/** What fits its text box on every frame shape; the Slideshow squad's reviewer and Writer hold slides to it. */
export const SLIDE_TEXT_MAX = { heading: 60, body: 130 } as const;
export const SLIDE_LAYERS = { background: 'Background', scrim: 'Scrim', heading: 'Heading', body: 'Body' } as const;

const slideId = z.string().min(1).max(40);
const heading = z.string().trim().min(1).max(200);
const body = z.string().trim().max(600);
const seconds = z.number().finite().min(SLIDE_SECONDS.min).max(SLIDE_SECONDS.max);

export const slideBackground = z.union([
	z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors are hex, like #FFD400.') }).strict(),
	z.object({ src: z.string().min(1).max(500) }).strict(),
]);

export const addSlideInput = z.object({
	op: z.literal('add_slide'),
	after: slideId.optional().describe('The slide this one follows. Omit to add it at the end.'),
	heading,
	body: body.optional(),
	duration: seconds.optional().describe(`Seconds on screen, ${SLIDE_SECONDS.default} by default.`),
	background: slideBackground.optional().describe('A hex colour or a library image. Omit for the Brand Kit background.'),
});

export const moveSlideInput = z.object({
	op: z.literal('move_slide'),
	slide_id: slideId,
	to: z.number().int().min(0).max(MAX_SLIDES - 1).describe('Its new position; 0 is the first slide.'),
});

export const deleteSlideInput = z.object({ op: z.literal('delete_slide'), slide_id: slideId });

export const setSlideDurationInput = z.object({ op: z.literal('set_slide_duration'), slide_id: slideId, seconds });

export const setSlideTextInput = z
	.object({
		op: z.literal('set_slide_text'),
		slide_id: slideId,
		heading: heading.optional(),
		body: body.optional().describe('An empty string removes the body.'),
	})
	.refine((input) => input.heading !== undefined || input.body !== undefined, 'Give the heading, the body or both.');

export type AddSlide = z.infer<typeof addSlideInput>;
export type MoveSlide = z.infer<typeof moveSlideInput>;
export type DeleteSlide = z.infer<typeof deleteSlideInput>;
export type SetSlideDuration = z.infer<typeof setSlideDurationInput>;
export type SetSlideText = z.infer<typeof setSlideTextInput>;

const r4 = (value: number) => Math.round(value * 1e4) / 1e4;

type Slide = Entity & { start: number; end: number; children: Entity[] };

const isSlide = (node: Entity): node is Slide => node.kind === 'group' && (node.marks as { visual?: { op?: string } } | undefined)?.visual?.op === SLIDE_OP;
const slidesOf = (scene: Entity): Slide[] => ((scene.children as Entity[] | undefined) ?? []).filter(isSlide);
const sceneIn = (document: ClipDocument): Entity => {
	const scene = activeScene(document) as unknown as Entity | undefined;
	if (!scene || !scene.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
	return scene;
};
const slideIn = (scene: Entity, id: string): Slide => {
	const slide = slidesOf(scene).find((item) => item.id === id);
	if (!slide) throw new OpFailure(`There is no slide "${id}".`);
	return slide;
};
const markerId = (slide: Slide) => `slide-${slide.id}`;

/** Slides touch from 0 in array order; their markers, the work area and the Brand Kit logo follow them. */
function reflow(scene: Entity, order: Slide[] = slidesOf(scene)): void {
	const children = (scene.children as Entity[]) ?? [];
	const queue = [...order];
	scene.children = children.flatMap((child) => (isSlide(child) ? (queue.length ? [queue.shift()!] : []) : [child]));
	let at = 0;
	for (const slide of order) {
		const seconds = r4(slide.end - slide.start);
		slide.start = r4(at);
		slide.end = r4(at + seconds);
		for (const layer of slide.children) {
			layer.start = 0;
			layer.end = seconds;
		}
		at = slide.end;
	}
	scene.workarea = [0, r4(at)];
	for (const child of scene.children as Entity[]) {
		if ((child.marks as Record<string, unknown> | undefined)?.[LOGO_MARK]) child.end = r4(at);
	}
	const marks = { ...((scene.marks as Record<string, unknown> | undefined) ?? {}) };
	const others = ((marks.markers as Marker[] | undefined) ?? []).filter((marker) => !marker.id.startsWith('slide-'));
	const own: Marker[] = order.map((slide, index) => ({ id: markerId(slide), name: `Slide ${index + 1}`, time: slide.start, duration: r4(slide.end - slide.start), color: 'blue', status: 'open' }));
	marks.markers = [...others, ...own].sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
	scene.marks = marks;
}

function textLayer(scene: Entity, name: string, text: string, box: { y: number; height: number; size: number; weight: number }, theme: { text: string; font?: string }, seconds: number): Entity {
	const width = scene.width as number;
	const height = scene.height as number;
	// A square or wide frame is short: the same words need smaller type to stay inside the box.
	const tall = height > width * 1.2 ? 1 : 0.7;
	return {
		kind: 'text',
		name,
		x: Math.round(width * 0.08),
		y: Math.round(height * box.y),
		width: Math.round(width * 0.84),
		height: Math.round(height * box.height),
		textAlign: 'center',
		textBaseline: 'middle',
		color: theme.text,
		fontFamily: theme.font ?? 'Inter',
		fontWeight: box.weight,
		fontSize: Math.round(Math.min(width, height) * box.size * tall),
		start: 0,
		end: seconds,
		text,
	};
}

const HEADING_BOX = { y: 0.26, height: 0.24, size: 0.085, weight: 700 };
const BODY_BOX = { y: 0.5, height: 0.16, size: 0.05, weight: 400 };

const bodyLayer = (scene: Entity, text: string, seconds: number, theme: { text: string; font?: string }) => textLayer(scene, SLIDE_LAYERS.body, text, BODY_BOX, theme, seconds);

export const addSlide = {
	name: 'add_slide',
	input: addSlideInput,
	describe: (input: AddSlide) => `Add the slide "${input.heading.length > 40 ? `${input.heading.slice(0, 40)}…` : input.heading}"`,
	async apply(document: ClipDocument, input: AddSlide) {
		const next = clone(document);
		const scene = sceneIn(next);
		const children = (scene.children as Entity[] | undefined) ?? [];
		// Reflowing would leave the speaker behind: slides belong to a timeline made of slides.
		if (children.some((child) => !isSlide(child) && ['video', 'sequence', 'captions'].includes(child.kind as string))) {
			throw new OpFailure('Slides go in a slideshow. This timeline has video on it; start a New slideshow.');
		}
		const slides = slidesOf(scene);
		if (slides.length >= MAX_SLIDES) throw new OpFailure(`A slideshow has at most ${MAX_SLIDES} slides.`);
		const at = input.after === undefined ? slides.length : slides.indexOf(slideIn(scene, input.after)) + 1;
		const seconds = input.duration ?? SLIDE_SECONDS.default;
		const theme = themeFromBrand(readBrand(next));
		const frame = { width: scene.width, height: scene.height };
		const background = input.background && 'src' in input.background
			? { kind: 'image', name: SLIDE_LAYERS.background, ...frame, objectFit: 'cover', src: input.background.src, start: 0, end: seconds }
			: { kind: 'rect', name: SLIDE_LAYERS.background, ...frame, fill: input.background?.color ?? theme.panel, start: 0, end: seconds };
		// An id now, not at the batch's stamp: its marker needs it, and the next op in the batch may name it.
		const taken = new Set(slides.map((slide) => slide.id));
		let id = drawId();
		while (taken.has(id)) id = drawId();
		const slide: Slide = {
			kind: 'group',
			id,
			name: 'Slide',
			start: 0,
			end: seconds,
			marks: { visual: { op: SLIDE_OP, input: {} } },
			children: [
				background,
				...(input.background && 'src' in input.background ? [{ kind: 'rect', name: SLIDE_LAYERS.scrim, ...frame, fill: '#000000', opacity: 0.45, start: 0, end: seconds }] : []),
				textLayer(scene, SLIDE_LAYERS.heading, input.heading, HEADING_BOX, theme, seconds),
				...(input.body ? [bodyLayer(scene, input.body, seconds, theme)] : []),
			],
		};
		scene.children = [...children, slide];
		const order = [...slides];
		order.splice(at, 0, slide);
		reflow(scene, order);
		return next;
	},
};

export const moveSlide = {
	name: 'move_slide',
	input: moveSlideInput,
	describe: (input: MoveSlide) => `Move a slide to position ${input.to + 1}`,
	async apply(document: ClipDocument, input: MoveSlide) {
		const next = clone(document);
		const scene = sceneIn(next);
		const slide = slideIn(scene, input.slide_id);
		const order = slidesOf(scene).filter((item) => item !== slide);
		order.splice(Math.min(input.to, order.length), 0, slide);
		reflow(scene, order);
		return next;
	},
};

export const deleteSlide = {
	name: 'delete_slide',
	input: deleteSlideInput,
	describe: () => 'Delete a slide',
	async apply(document: ClipDocument, input: DeleteSlide) {
		const next = clone(document);
		const scene = sceneIn(next);
		const slide = slideIn(scene, input.slide_id);
		const order = slidesOf(scene).filter((item) => item !== slide);
		if (!order.length) throw new OpFailure('A slideshow keeps at least one slide.');
		scene.children = (scene.children as Entity[]).filter((child) => child !== slide);
		reflow(scene, order);
		return next;
	},
};

export const setSlideDuration = {
	name: 'set_slide_duration',
	input: setSlideDurationInput,
	describe: (input: SetSlideDuration) => `Show a slide for ${input.seconds}s`,
	async apply(document: ClipDocument, input: SetSlideDuration) {
		const next = clone(document);
		const scene = sceneIn(next);
		const slide = slideIn(scene, input.slide_id);
		slide.end = slide.start + input.seconds;
		reflow(scene);
		return next;
	},
};

export const setSlideText = {
	name: 'set_slide_text',
	input: setSlideTextInput,
	describe: () => 'Change a slide\'s text',
	async apply(document: ClipDocument, input: SetSlideText) {
		const next = clone(document);
		const scene = sceneIn(next);
		const slide = slideIn(scene, input.slide_id);
		const layer = (name: string) => slide.children.find((child) => child.name === name);
		if (input.heading !== undefined) {
			const heading = layer(SLIDE_LAYERS.heading);
			if (!heading) throw new OpFailure('This slide has lost its heading. Delete it and add it again.');
			heading.text = input.heading;
		}
		if (input.body !== undefined) {
			const body = layer(SLIDE_LAYERS.body);
			if (!input.body) slide.children = slide.children.filter((child) => child !== body);
			else if (body) body.text = input.body;
			else slide.children.push(bodyLayer(scene, input.body, r4(slide.end - slide.start), themeFromBrand(readBrand(next))));
		}
		return next;
	},
};
