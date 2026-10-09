/**
 * Op sinh visual giải thích (spec visuals §5 V1b–V2). Mỗi op dựng một `group`
 * phủ khung gồm rect/path/text, có mark `visual` giữ op + input — `update_visual`
 * đọc mark đó để sinh lại khi người dùng sửa nhãn hay số, giữ vị trí và thời gian.
 *
 * Toạ độ vào là chuẩn hoá 0–1 theo khung; thời gian là giây của clip.
 */

import { z } from 'zod';

import { ANIMATION_TYPES, type ClipDocument } from '@opencmo/clip-doc';

import { byId, clone, sceneOf, type Entity } from '../doc';
import { readBrand, rebrand, themeFromBrand } from '../brand';
import { buildChart, chartInput, type ChartInput } from '../visuals/chart';
import { panelRegionAt } from '../layout';
import { clipScript, clipWords, findQuote, quoteTiming } from '../script';
import { defaultRegion, r2, toPixels, visualGroup, type Box, type Node } from '../visuals/common';
import { buildDiagram, diagramInput, type DiagramInput } from '../visuals/diagram';
import { buildGraph, ExprError, graphInput, type GraphInput } from '../visuals/graph';
import { buildIcon, IconError, iconInput, type IconInput } from '../visuals/icon';
import { buildLottie, LottieError, lottieInput, type LottieInput } from '../visuals/lottie';
import { buildShape, SHAPE_NAMES, shapeInput, type ShapeInput } from '../visuals/shape';
import { buildThree, threeInput, type ThreeInput } from '../visuals/three';
import { OpFailure, type OpContext } from './context';
import { loadCaptions } from './captions';
import { checked } from './project';

const timing = {
	start: z.number().finite().min(0).optional(),
	end: z.number().finite().min(0).optional(),
	/** Câu người nói mà visual minh hoạ, chép từ kịch bản; thiếu start/end thì đặt theo câu này. */
	quote: z.string().trim().min(2).max(300).optional(),
};

type Timing = { start: number; end: number };

function frameOf(document: ClipDocument) {
	const scene = sceneOf(document);
	if (!scene || !scene.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
	const workarea = scene.workarea as [number, number] | undefined;
	return { width: scene.width, height: scene.height, duration: workarea ? workarea[1] : null };
}

/** Kẹp thời gian vào clip; báo lỗi rõ khi visual nằm ngoài. */
function clamp(input: Timing, duration: number | null): Timing {
	const end = duration === null ? input.end : Math.min(input.end, duration);
	if (!(end > input.start)) throw new OpFailure('The visual must end after it starts, inside the clip.');
	return { start: input.start, end };
}

/**
 * Mốc CLIP của câu `quote` trong transcript của clip (`script.ts`). Không thấy
 * câu thì báo lỗi — visual phải gắn với điều người nói thật sự nói.
 */
export async function quoteRange(
	document: ClipDocument,
	ctx: Pick<OpContext, 'readTranscript'> | undefined,
	quote: string,
	limits: { min?: number; max?: number } = {},
): Promise<Timing> {
	const model = ctx ? await loadCaptions(document, ctx).catch(() => null) : null;
	if (!model) throw new OpFailure('This clip has no transcript to find that line in. Pass start and end instead.');
	const words = clipWords(model.transcript, model.window, model.removed);
	const hit = findQuote(words, quote);
	if (!hit) throw new OpFailure(`"${quote.slice(0, 80)}" is not in this clip's transcript. Copy the exact words from <clip_context>.`);
	return quoteTiming(hit, clipScript(words), frameOfDuration(document), limits);
}

const frameOfDuration = (document: ClipDocument): number | null => {
	const workarea = sceneOf(document)?.workarea as [number, number] | undefined;
	return workarea ? workarea[1] : null;
};

/** start/end của op: cái đã cho thắng; thiếu thì lấy từ `quote`. */
export async function resolveTiming(
	document: ClipDocument,
	ctx: Pick<OpContext, 'readTranscript'> | undefined,
	input: { start?: number; end?: number; quote?: string },
	limits?: { min?: number; max?: number },
): Promise<Timing> {
	if (input.start !== undefined && input.end !== undefined) return { start: input.start, end: input.end };
	if (!input.quote) throw new OpFailure('Give start and end (clip seconds), or quote: the words the speaker says when it should appear.');
	const found = await quoteRange(document, ctx, input.quote, limits);
	const start = input.start ?? found.start;
	return { start, end: input.end ?? Math.max(found.end, start + 1) };
}

/** Lỗi của builder (công thức sai…) thành lỗi op đọc được. */
async function built(make: () => Node[] | Promise<Node[]>): Promise<Node[]> {
	try {
		return await make();
	} catch (error) {
		if (error instanceof ExprError || error instanceof IconError || error instanceof LottieError) throw new OpFailure(error.message);
		throw error;
	}
}

type Builder = {
	name: string;
	schema: z.ZodType;
	build(input: never, frame: { width: number; height: number }, area: Box, duration: number): Node[] | Promise<Node[]>;
	title(input: never): string;
};

const BUILDERS: Record<string, Builder> = {
	add_shape: {
		name: 'add_shape',
		schema: shapeInput,
		build: (input: ShapeInput, frame) => buildShape(input, frame),
		title: (input: ShapeInput) => SHAPE_NAMES[input.shape],
	},
	add_diagram: {
		name: 'add_diagram',
		schema: diagramInput,
		build: (input: DiagramInput, frame, area, duration) => buildDiagram(input, frame, area, duration),
		title: () => 'Diagram',
	},
	add_chart: {
		name: 'add_chart',
		schema: chartInput,
		build: (input: ChartInput, frame, area, duration) => buildChart(input, frame, area, duration),
		title: (input: ChartInput) => `${input.type[0]!.toUpperCase()}${input.type.slice(1)} chart`,
	},
	add_3d: {
		name: 'add_3d',
		schema: threeInput,
		build: (input: ThreeInput, frame, area) => buildThree(input, frame, area),
		title: () => '3D scene',
	},
	add_lottie: {
		name: 'add_lottie',
		schema: lottieInput,
		build: (input: LottieInput, frame) => buildLottie(input, frame),
		title: (input: LottieInput) => `Animation: ${input.animation.replace(/^builtin:/, '').split('/').pop()}`,
	},
	add_icon: {
		name: 'add_icon',
		schema: iconInput,
		build: (input: IconInput, frame, _area, duration) => buildIcon(input, frame, duration),
		title: (input: IconInput) => `Icon: ${input.name}`,
	},
	add_graph: {
		name: 'add_graph',
		schema: graphInput,
		build: (input: GraphInput, frame, area, duration) => buildGraph(input, frame, area, duration),
		title: (input: GraphInput) => `Graph of ${input.expr}`,
	},
};

/** Dựng group của một visual từ op + input đã kiểm. */
async function visualNode(op: string, input: Record<string, unknown>, when: Timing, frame: { width: number; height: number }, document: ClipDocument): Promise<Node> {
	const builder = BUILDERS[op]!;
	// Trong khoảng chia đôi, visual không nói chỗ nào thì vào panel, không đè người nói.
	const panel = panelRegionAt(document, when.start);
	const region = (input.region as Box | undefined) ?? panel ?? defaultRegion(frame);
	if (panel && (op === 'add_icon' || op === 'add_lottie') && !input.at) {
		input = { ...input, at: [r2(panel.x + panel.width / 2), r2(panel.y + panel.height / 2)] };
	}
	// Brand Kit đã áp vào clip: màu/font mặc định của builder đổi sang của kit.
	const children = rebrand(await built(() => builder.build(input as never, frame, toPixels(region, frame), when.end - when.start)), themeFromBrand(readBrand(document)));
	return visualGroup(builder.title(input as never), children, when, frame, { op, input });
}

function addTo(document: ClipDocument, node: Node): ClipDocument {
	const next = clone(document);
	const scene = sceneOf(next)!;
	scene.children = [...(scene.children ?? []), node as never];
	return checked(next, 'That visual cannot be added');
}

/**
 * Input của op = object PHẲNG (op, start, end + trường của visual): tool của
 * agent sinh JSON schema từ đây và cần `properties` ở cấp trên cùng — một
 * `z.intersection` ra `allOf` không có. Luật chéo trường (`refine`) của module
 * chạy lại trong `superRefine`.
 */
function visualOp<T extends z.ZodObject>(name: keyof typeof BUILDERS, schema: T, describe: (input: z.infer<T>) => string) {
	return {
		name,
		input: z.object({ op: z.literal(name), ...timing, ...schema.shape }).superRefine((value, ctx) => {
			const { op: _op, start: _start, end: _end, quote: _quote, ...spec } = value as Record<string, unknown>;
			const parsed = schema.safeParse(spec);
			if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
		}),
		describe,
		async apply(document: ClipDocument, input: z.infer<T> & { start?: number; end?: number; quote?: string; op: string }, ctx?: OpContext) {
			const frame = frameOf(document);
			const when = clamp(await resolveTiming(document, ctx, input), frame.duration);
			// `quote` đi vào mark cùng input: update_visual dựng lại vẫn biết visual minh hoạ câu nào.
			const { op: _op, start: _start, end: _end, ...spec } = input as Record<string, unknown>;
			return addTo(document, await visualNode(name, spec, when, frame, document));
		},
	};
}

export const addShape = visualOp('add_shape', shapeInput, (input) => `Draw ${SHAPE_NAMES[input.shape].toLowerCase()}`);
export const addDiagram = visualOp('add_diagram', diagramInput, (input) => `Add a diagram: ${input.nodes.map((node) => node.label).slice(0, 4).join(' → ')}`);
export const addChart = visualOp('add_chart', chartInput, (input) => `Add a ${input.type} chart${input.title ? `: ${input.title}` : ''}`);
export const addGraph = visualOp('add_graph', graphInput, (input) => `Plot y = ${input.expr}`);
export const addIcon = visualOp('add_icon', iconInput, (input) => `Add the ${input.name} icon${input.motion && input.motion !== 'none' ? ` (${input.motion})` : ''}`);
export const addLottie = visualOp('add_lottie', lottieInput, (input) => `Add the ${input.animation.split('/').pop()} animation`);
// 3D phẳng vẽ CPU: agent không dùng nữa (spec code-scenes: 3D của agent là code
// three.js qua add_3d_scene). Op giữ nguyên cho document cũ và update_visual.
export const add3d = { ...visualOp('add_3d', threeInput, (input) => `Add a 3D scene (${input.objects.map((object) => object.type).join(', ')})`), agent: false as const };

// ------------------------------------------------------------------ sửa lại

/** Prop của group visual mà người dùng chỉnh bằng tay — sinh lại không được xoá. */
const KEPT_ON_UPDATE = ['name', 'x', 'y', 'offsetX', 'offsetY', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity', 'blendMode', 'hidden', 'tracks'] as const;

type UpdateVisual = { id: string; changes: Record<string, unknown>; start?: number; end?: number };

export const updateVisual = {
	name: 'update_visual',
	input: z.object({
		op: z.literal('update_visual'),
		id: z.string().min(1).max(64),
		/** Phần input đổi (nhãn, số, layout, màu…) — gộp nông vào input cũ. */
		changes: z.record(z.string(), z.unknown()),
		start: z.number().finite().min(0).optional(),
		end: z.number().finite().min(0).optional(),
	}),
	describe: () => 'Update a visual',
	async apply(document: ClipDocument, input: UpdateVisual) {
		const found = byId(document, input.id);
		const mark = (found?.entity.marks as { visual?: { op?: string; input?: Record<string, unknown> } } | undefined)?.visual;
		if (!found || found.tag !== 'group' || !mark?.op || !BUILDERS[mark.op]) {
			throw new OpFailure(`"${input.id}" is not a visual made with add_shape, add_icon, add_lottie, add_diagram, add_chart, add_graph or add_3d.`);
		}
		const builder = BUILDERS[mark.op]!;
		const merged = { ...(mark.input ?? {}), ...input.changes };
		const parsed = builder.schema.safeParse(merged);
		if (!parsed.success) throw new OpFailure(parsed.error.issues[0]?.message ?? 'Those changes are not valid for this visual.');
		const frame = frameOf(document);
		const when = clamp({ start: input.start ?? (found.entity.start as number), end: input.end ?? (found.entity.end as number) }, frame.duration);
		const next = clone(document);
		const target = byId(next, input.id)!;
		const quote = typeof merged.quote === 'string' ? { quote: merged.quote } : {};
		const fresh = await visualNode(mark.op, { ...(parsed.data as Record<string, unknown>), ...quote }, when, frame, document);
		// Giữ danh tính, chỗ trong cây, và mọi thứ người dùng đã đặt trên group
		// (kéo, đổi cỡ, xoay, keyframe riêng): chỉ thay nội dung bên trong.
		const kept = Object.fromEntries(
			KEPT_ON_UPDATE.filter((key) => target.entity[key] !== undefined).map((key) => [key, target.entity[key]]),
		);
		const list = target.list!;
		list.splice(list.indexOf(target.entity), 1, { ...fresh, ...kept, id: input.id } as Entity);
		return checked(next, 'That visual cannot be updated');
	},
};

// ------------------------------------------------------------------ so le

type Stagger = { element_ids: string[]; type: (typeof ANIMATION_TYPES)[number]; duration?: number; step?: number; delay?: number; phase?: 'in' | 'out' };

/**
 * Áp một preset cho nhiều phần tử với độ trễ so le — LaggedStart của manim:
 * gạch đầu dòng, ô, biểu tượng hiện lần lượt thay vì cùng lúc.
 */
export const stagger = {
	name: 'stagger',
	input: z.object({
		op: z.literal('stagger'),
		element_ids: z.array(z.string().min(1).max(64)).min(2).max(40),
		type: z.enum(ANIMATION_TYPES),
		duration: z.number().min(0.05).max(10).optional(),
		/** Giây giữa hai phần tử liền nhau. */
		step: z.number().min(0).max(10).optional(),
		/** Trễ của phần tử đầu tiên. */
		delay: z.number().min(0).max(60).optional(),
		phase: z.enum(['in', 'out']).optional(),
	}),
	describe: (input: Stagger) => `Animate ${input.element_ids.length} elements one after another`,
	async apply(document: ClipDocument, input: Stagger) {
		const next = clone(document);
		const phase = input.phase ?? 'in';
		input.element_ids.forEach((id, index) => {
			const found = byId(next, id);
			if (!found || !found.list || found.tag === 'scene') throw new OpFailure(`There is no element "${id}" in this project.`);
			const entity = found.entity;
			// Thay animation cùng pha cũ: chạy lại op không chồng hai lớp.
			const kept = ((entity.animations as Entity[] | undefined) ?? []).filter((animation) => (animation.phase ?? 'in') !== phase);
			const delay = Math.round(((input.delay ?? 0) + index * (input.step ?? 0.15)) * 100) / 100;
			entity.animations = [...kept, { type: input.type, ...(phase === 'out' ? { phase } : {}), duration: input.duration ?? 0.4, ...(delay > 0 ? { delay } : {}) }];
		});
		return checked(next, 'Those elements cannot be animated that way');
	},
};
