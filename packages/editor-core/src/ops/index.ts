/**
 * Registry op: đường ghi DUY NHẤT vào document của một clip cho nút bấm của
 * editor, route `POST /api/v1/editor/ops` và agent (spec AI Studio §4).
 *
 * Không có op "ghi document thô". Mọi thứ một op làm đều có schema, có câu mô
 * tả cho thẻ hành động, và giữ các bất biến mà document dựa vào (mark cắt bằng
 * chữ, mark khung, id phần tử).
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode, SceneNode } from '@opencmo/clip-doc';

import { activeView, clone, mergeView, nodes, same, stamp, timelinesOf, viewOf } from '../doc';
import {
	editWords,
	mergeLines,
	nudgeWordOp,
	removeRanges,
	removeSilence,
	removeWords,
	restoreAll,
	restoreWordsOp,
	splitLine,
} from './captions';
import { OpError, OpFailure, type OpContext } from './context';
import { addGenerated, addText, deleteElement, enhanceGenerated, regenerate, setCaptionStyle, setFrame, setLayout, setProjectSettings, updateElement } from './project';
import { moveElements, moveKeyframe, moveLayer, setWorkarea, splitElements, trimElement } from './timeline';
import { addPart, copySettings, movePart, setKeyframe, setProps } from './inspector';
import { cleanAudio, makeRoom, rippleDelete, setAudioRoll, setCaptionBreaks, setFade, slipElement } from './edit';
import { deleteMarker, setMarker } from './markers';
import { insertNode, replaceSrc } from './library';
import { activateScene, duplicateElements, groupElements, insertScene, pasteNodes, ungroupElements } from './structure';
import { add3dStudio } from './studio3d';
import { createTimeline, deleteTimeline, renameTimeline, setActiveTimeline, STAGE_OPS } from './timelines';
import { applyBrand } from './brand';
import { applyColor } from './color';
import { applyLayout } from './layouts';
import { addVoiceover, captionVoiceover, syncVoiceover, syncVoiceovers } from './voiceover';
import { insertCaptions, insertToRow, moveToRow } from './rows';
import { laneOf } from '../tracks';
import { add3d, addChart, addDiagram, addGraph, addIcon, addLottie, addShape, stagger, updateVisual } from './visuals';

export { OpError, OpFailure, type OpContext } from './context';
export { COPY_GROUPS } from './inspector';
export { MARKER_COLORS, MARKER_STATUSES, readMarkers, type Marker } from './markers';
export { loadCaptions, type CaptionModel } from './captions';
export { spreadCaptions } from './rows';
export { CAPTION_PRESETS, FONTS } from './project';
export { BRAND_SRC_PREFIX, LOGO_MARK, logoBox } from './brand';
export {
	DEFAULT_DUCK_DB,
	estimateSeconds,
	planVoiceover,
	sourceSpans,
	VOICEOVER_MARK,
	voiceoverInput,
	voiceoverToolInput,
	voiceTranscript,
	WORDS_PER_SECOND,
	type VoiceoverInput,
	type VoiceoverMark,
} from './voiceover';
export { frameRatio, planStudio3d, sceneOfInput, sceneSummary, studio3dInput, studio3dToolInput, STUDIO_MODEL, type Studio3dInput } from './studio3d';

const REGISTRY = [
	removeWords,
	removeRanges,
	removeSilence,
	restoreWordsOp,
	restoreAll,
	editWords,
	splitLine,
	mergeLines,
	nudgeWordOp,
	setFrame,
	setLayout,
	setCaptionStyle,
	setCaptionBreaks,
	cleanAudio,
	applyBrand,
	addText,
	addGenerated,
	regenerate,
	enhanceGenerated,
	updateElement,
	deleteElement,
	moveElements,
	trimElement,
	splitElements,
	moveLayer,
	moveKeyframe,
	setWorkarea,
	setFade,
	slipElement,
	rippleDelete,
	setAudioRoll,
	setMarker,
	deleteMarker,
	setProps,
	setKeyframe,
	addPart,
	movePart,
	copySettings,
	insertNode,
	replaceSrc,
	duplicateElements,
	pasteNodes,
	groupElements,
	ungroupElements,
	insertScene,
	activateScene,
	addShape,
	addIcon,
	addLottie,
	addDiagram,
	addChart,
	addGraph,
	add3d,
	add3dStudio,
	addVoiceover,
	syncVoiceover,
	updateVisual,
	stagger,
	// Cuối registry: thứ tự tool agent là một phần prompt cache.
	createTimeline,
	setActiveTimeline,
	renameTimeline,
	deleteTimeline,
	setProjectSettings,
	applyColor,
	applyLayout,
	makeRoom,
	insertToRow,
	moveToRow,
	insertCaptions,
	captionVoiceover,
] as const;

type Definition = {
	name: string;
	input: z.ZodType;
	describe: (input: never) => string;
	apply: (document: ClipDocument, input: never, ctx: OpContext) => Promise<ClipDocument>;
};

const byName = new Map<string, Definition>(REGISTRY.map((op) => [op.name, op as unknown as Definition]));

export const OP_NAMES = REGISTRY.map((op) => op.name);

/**
 * Schema đầu vào của từng op, theo tên. Assistant sinh tool definition từ
 * đây (bỏ trường `op`) — cùng schema mà `applyOps` kiểm, nên tool và op không
 * thể lệch nhau.
 */
export const OP_INPUTS: Record<string, z.ZodType> = Object.fromEntries(REGISTRY.map((op) => [op.name, op.input]));

/**
 * Op Assistant được gọi THẲNG (tool của phạm vi clip, `apply_to_clips` của
 * phạm vi project). Op `agent: false` chỉ đi qua tool riêng của nó — vd
 * `add_generated` qua `generate_media`, nơi người dùng duyệt giá trước.
 */
export const AGENT_OP_INPUTS: Record<string, z.ZodType> = Object.fromEntries(
	REGISTRY.filter((op) => !('agent' in op && op.agent === false)).map((op) => [op.name, op.input]),
);

/** Một op bất kỳ, đã qua schema. `op` là tên — cũng là tên tool của agent ở P2. */
export const opSchema = z.union(REGISTRY.map((op) => op.input) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);

export type Op = { op: (typeof REGISTRY)[number]['name'] } & Record<string, unknown>;

/** Câu mô tả tiếng Anh của một op đã hợp lệ, cho thẻ hành động và nhãn checkpoint. */
export function describeOp(op: Op): string {
	const definition = byName.get(op.op);
	return definition ? definition.describe(op as never) : op.op;
}

export type OpResult = { op: string; summary: string; changed: boolean };

/**
 * Kiểm một op theo schema của nó. Lỗi thành `OpError` với câu đọc được — lỗi
 * zod nguyên văn là JSON, không phải thứ để in lên màn hình.
 */
function validate(op: unknown, index: number): Op {
	const name = typeof op === 'object' && op !== null ? (op as { op?: unknown }).op : undefined;
	const definition = typeof name === 'string' ? byName.get(name) : undefined;
	if (!definition) throw new OpError(index, String(name ?? ''), `Unknown operation "${String(name ?? '')}".`);
	const parsed = definition.input.safeParse(op);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
		throw new OpError(index, definition.name, `${where}${issue?.message ?? 'Invalid input.'}`);
	}
	return parsed.data as Op;
}

/** Phụ đề, hay một hàng toàn phụ đề (`tracks.ts`). */
const isCaptions = (node: ClipNode) => laneOf(node) === 'captions';

/** Con của scene: phụ đề dồn xuống cuối, giữ thứ tự tương đối của cả hai nhóm. */
const captionsLast = (children: ClipNode[]) => [
	...children.filter((child) => !isCaptions(child)),
	...children.filter(isCaptions),
];

/**
 * Phụ đề luôn là lớp TRÊN CÙNG của scene (cuối mảng = vẽ sau cùng).
 *
 * B-roll của `insert_asset`/`insert_node`, visual và panel đều thêm lớp lên
 * trên cùng; một lớp phủ kín khung đặt trên phụ đề là phụ đề biến mất khỏi
 * preview lẫn bản export mà không ai báo lỗi. Sửa từng op thì op mới sau này
 * lại quên — nên đây là bất biến, chạy sau mọi lượt op như `syncVoiceovers`.
 */
export function captionsOnTop(input: ClipDocument): ClipDocument {
	const misplaced = (scene: SceneNode) => {
		const children = scene.children ?? [];
		return captionsLast(children).some((child, index) => child !== children[index]);
	};
	const scenes = (document: ClipDocument) => nodes(document).filter((node): node is SceneNode => node.kind === 'scene');
	if (!scenes(input).some(misplaced)) return input;
	const document = clone(input);
	for (const scene of scenes(document)) {
		if (misplaced(scene)) scene.children = captionsLast(scene.children ?? []);
	}
	return document;
}

/**
 * Áp một chuỗi op lên document, tuần tự. Op đầu tiên hỏng dừng cả chuỗi bằng
 * `OpError` và KHÔNG trả document nào — nửa chuỗi op là một trạng thái không ai
 * yêu cầu. Mọi op được kiểm schema trước khi op đầu tiên chạy. Document đầu vào
 * không bị sửa.
 *
 * Kết thúc bằng một lượt stamp: phần tử mới (chữ vừa thêm, đoạn video vừa cắt)
 * có `id` ngay, để lượt op kế tiếp — hay agent — gọi được tên chúng.
 */
export async function applyOps(
	document: ClipDocument,
	ops: unknown[],
	ctx: OpContext,
): Promise<{ document: ClipDocument; results: OpResult[] }> {
	const valid = ops.map(validate);
	let current = document;
	const results: OpResult[] = [];
	for (const [index, op] of valid.entries()) {
		const definition = byName.get(op.op)!;
		let next: ClipDocument;
		try {
			if (STAGE_OPS.has(op.op)) next = await definition.apply(current, op as never, ctx);
			else {
				// Op thường chỉ thấy timeline đang mở (E2-a): mọi op viết cho "scene đầu"
				// sửa đúng tab người dùng đang xem, các timeline khác giữ nguyên.
				const view = activeView(current);
				const scene = timelinesOf(view)[0]!;
				next = mergeView(current, scene, view, await definition.apply(view, op as never, ctx));
			}
		} catch (error) {
			if (error instanceof OpFailure) throw new OpError(index, op.op, error.message);
			console.error(`[editor-core] ${op.op} failed`, error);
			throw new OpError(index, op.op, 'This change could not be applied to the project.');
		}
		results.push({ op: op.op, summary: definition.describe(op as never), changed: !same(next, current) });
		current = next;
	}
	// Trạng thái suy ra từ voiceover (tắt tiếng/hạ tiếng video gốc, phụ đề mồ
	// côi) tính lại sau mọi lượt — document không có voiceover đi qua nguyên vẹn.
	if (current !== document) {
		for (const scene of timelinesOf(current)) {
			const view = viewOf(current, scene);
			current = mergeView(current, scene, view, syncVoiceovers(view));
		}
	}
	if (current !== document) current = captionsOnTop(current);
	if (!same(current, document)) {
		current = current === document ? clone(current) : current;
		stamp(current);
	}
	return { document: current, results };
}
export { activeScene, timesOf } from './timeline';

