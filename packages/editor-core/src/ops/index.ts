/**
 * Registry op: đường ghi DUY NHẤT vào document của một clip cho nút bấm của
 * editor, route `POST /api/v1/editor/ops` và agent (spec AI Studio §4).
 *
 * Không có op "ghi document thô". Mọi thứ một op làm đều có schema, có câu mô
 * tả cho thẻ hành động, và giữ các bất biến mà document dựa vào (mark cắt bằng
 * chữ, mark khung, id phần tử).
 */

import { z } from 'zod';

import { timingIssues, type ClipDocument, type ClipNode, type SceneNode } from '@opencmo/clip-doc';

import { activeView, clone, mergeView, nodes, same, stamp, timelinesOf, viewOf } from '../doc';
import {
	attachTranscript,
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
import { OpError, OpFailure, unwrapOutcome, type OpContext } from './context';
import { addGenerated, addText, deleteElement, enhanceGenerated, pickVariant, regenerate, setCaptionStyle, setFrame, setLayout, setProjectSettings, updateElement } from './project';
import { moveElements, moveKeyframe, moveLayer, setWorkarea, splitElements, trimElement } from './timeline';
import { addPart, copySettings, movePart, setKeyframe, setProps } from './inspector';
import { cleanAudio, makeRoom, rippleDelete, setAudioRoll, setCaptionBreaks, setFade, slipElement } from './edit';
import { deleteMarker, setMarker } from './markers';
import { insertNode, replaceSrc } from './library';
import { activateScene, duplicateElements, groupElements, insertScene, pasteNodes, ungroupElements } from './structure';
import { addExplainer, syncExplainer } from './explainer';
import { createTimeline, deleteTimeline, renameTimeline, setActiveTimeline, STAGE_OPS } from './timelines';
import { applyBrand } from './brand';
import { applyColor } from './color';
import { applyLayout } from './layouts';
import { addVoiceover, captionVoiceover, syncVoiceover, syncVoiceovers } from './voiceover';
import { insertCaptions, insertToRow, moveToRow } from './rows';
import { laneOf } from '../tracks';
import { addIntro } from '../motion/intro';
import { replaceBackground } from './background';
import { editVideo } from './edit-video';
import { createVideo, redoKeyframe } from './create-video';
import { addChart, addDiagram, addGraph, addHookTitle, addIcon, addList, addShape, addTitle, stagger, updateVisual } from './visuals';
import { emphasizeWords } from './emphasis';
import { punchIn } from './punch-in';
import { addSlide, deleteSlide, moveSlide, setSlideDuration, setSlideText } from './slides';
export { addSlideInput, deleteSlideInput, MAX_SLIDES, moveSlideInput, setSlideDurationInput, setSlideTextInput, SLIDE_LAYERS, SLIDE_SECONDS, SLIDE_TEXT_MAX, slideBackground, type AddSlide, type DeleteSlide, type MoveSlide, type SetSlideDuration, type SetSlideText } from './slides';
export { makeShort, makeShortInput, MAX_SHORT_SECONDS, SHORT_FRAME, shotBeats, spokenWords, type MakeShort, type SpokenWord, type TimelineSpan } from './shorts';
import { addCameraMove, removeCameraMoves, syncCameraMoves } from './camera';
import { styleOp, type StyleDeps } from '../style/apply';
// Track C: proof B-roll.
import { addProof } from '../proof';

export { OpError, OpFailure, OpOutcome, type OpContext } from './context';
export { COPY_GROUPS } from './inspector';
export { checkShots, createVideoInput, keyframesOf, MAX_CHAIN, MAX_SHOTS, VIDEO_ASPECTS, VIDEO_FRAMES, type CreateVideo, type PlacedKeyframe } from './create-video';
export { keyframeSource, type KeyframeSource } from './project';
export { CUTOUT_PROMPT, frameAspect, MAX_SWAP_SECONDS, planBackgroundSwap, replaceBackgroundInput, type ReplaceBackground } from './background';
export { editSeconds, editVideoInput, planVideoEdit, type EditVideo } from './edit-video';
export { ACCENT_GAP, CAMERA_MARK, flashOpacity, moveDelta, readCameraMoves } from './camera';
export { MARKER_COLORS, MARKER_STATUSES, readMarkers, type Marker } from './markers';
export { loadCaptions, speechElement, type CaptionModel } from './captions';
export { spreadCaptions } from './rows';
export { CAPTION_PRESETS, FONTS, guardProps } from './project';
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
export {
	addExplainer,
	CLIP_MAX_BEATS,
	CLIP_MAX_SECONDS,
	CLIP_MIN_SECONDS,
	ClipBeatSchema,
	clipSeconds,
	ClipSceneSchema,
	estimateDuration,
	EXPLAINER_FORMATS,
	EXPLAINER_PERSONALITIES,
	EXPLAINER_THEMES,
	EXPLAINER_MAX_SECONDS,
	EXPLAINER_MIN_SECONDS,
	EXPLAINER_MODEL,
	EXPLAINER_SCENE_BYTES,
	ExplainerBeatSchema,
	explainerInput,
	explainerLayerName,
	ExplainerSceneSchema,
	explainerSeconds,
	MOTION_ASSET_NAME,
	MOTION_CLIP_MODEL,
	MOTION_MAX_ASSETS,
	MotionAssetRefSchema,
	narrationOf,
	syncExplainerInput,
	type ClipBeat,
	type ClipScene,
	type ExplainerBeat,
	type MotionAssetRef,
	type ExplainerPersonality,
	type ExplainerTheme,
	type ExplainerFormat,
	type ExplainerInput,
	type ExplainerScene,
} from './explainer';

// Style skills (Track A): runs the other ops of this registry, so it reaches them by name. The
// annotations break the type cycle with REGISTRY.
const STYLE_DEPS: StyleDeps = {
	run: (document: ClipDocument, op: { op: string }, ctx: OpContext): Promise<ClipDocument> => runOne(document, op, ctx),
	has: (name: string): boolean => byName.has(name),
};
const applyStyle = styleOp(STYLE_DEPS);

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
	addDiagram,
	addChart,
	addGraph,
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
	addIntro,
	pickVariant,
	replaceBackground,
	createVideo,
	editVideo,
	addExplainer,
	attachTranscript,
	syncExplainer,
	addTitle,
	applyStyle,
	// Style skills, Track B.
	emphasizeWords,
	addHookTitle,
	punchIn,
	addList,
	// Style skills, Track C.
	addProof,
	redoKeyframe,
	// Plan O4: camera moves on the talking head.
	addCameraMove,
	removeCameraMoves,
	// P5: slides of a slideshow.
	addSlide,
	moveSlide,
	deleteSlide,
	setSlideDuration,
	setSlideText,
] as const;

type Definition = {
	name: string;
	input: z.ZodType;
	describe: (input: never) => string;
	apply: (document: ClipDocument, input: never, ctx: OpContext) => Promise<ClipDocument>;
};

const byName: Map<string, Definition> = new Map(REGISTRY.map((op) => [op.name, op as unknown as Definition]));

export const OP_NAMES = REGISTRY.map((op) => op.name);

/**
 * One op inside another (`apply_style`): schema-checked like a batch, and its refusal stays an
 * `OpFailure` so the outer op can report it instead of failing as a whole.
 */
async function runOne(document: ClipDocument, op: { op: string }, ctx: OpContext): Promise<ClipDocument> {
	const definition = byName.get(op.op);
	if (!definition) throw new OpFailure(`Unknown operation "${op.op}".`);
	const parsed = definition.input.safeParse(op);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new OpFailure(`${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'Invalid input.'}`);
	}
	return unwrapOutcome(await definition.apply(document, parsed.data as never, ctx)).document;
}

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

/** `detail`: what the op reported about its run (`apply_style`'s receipt), when it reports one. */
export type OpResult = { op: string; summary: string; changed: boolean; detail?: unknown };

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
 * A batch must not leave an element with broken timing (start after end, negative time…) that it
 * did not already have. Issues the document already had never block, so old projects keep saving.
 * The whole batch is judged, not each op: one op may set `start` and the next `end`.
 */
function rejectNewTimingIssues(before: ClipDocument, after: ClipDocument, steps: { op: string; document: ClipDocument }[]): void {
	const old = new Set(timingIssues(before).map((issue) => `${issue.key}:${issue.kind}`));
	const fresh = timingIssues(after).filter((issue) => !old.has(`${issue.key}:${issue.kind}`));
	if (!fresh.length) return;
	const first = fresh[0]!;
	const index = Math.max(
		0,
		steps.findIndex((step) => timingIssues(step.document).some((issue) => issue.key === first.key && issue.kind === first.kind)),
	);
	throw new OpError(index, steps[index]?.op ?? 'apply', `${first.message} Change the times so this element still plays.`);
}

/**
 * Applies a list of ops to the document, in order. The first failing op stops the whole list
 * with `OpError` and NO document is returned: half a list is a state nobody asked for. Every op is
 * schema-checked before the first one runs. The input document is not modified.
 *
 * Ends with a stamp pass: new elements (text just added, a video piece just cut) get an `id` at
 * once, so the next batch of ops, or the agent, can name them.
 */
export async function applyOps(
	document: ClipDocument,
	ops: unknown[],
	ctx: OpContext,
): Promise<{ document: ClipDocument; results: OpResult[] }> {
	const valid = ops.map(validate);
	let current = document;
	const results: OpResult[] = [];
	const steps: { op: string; document: ClipDocument }[] = [];
	for (const [index, op] of valid.entries()) {
		const definition = byName.get(op.op)!;
		let next: ClipDocument;
		let detail: unknown;
		try {
			if (STAGE_OPS.has(op.op)) ({ document: next, detail } = unwrapOutcome(await definition.apply(current, op as never, ctx)));
			else {
				// Op thường chỉ thấy timeline đang mở (E2-a): mọi op viết cho "scene đầu"
				// sửa đúng tab người dùng đang xem, các timeline khác giữ nguyên.
				const view = activeView(current);
				const scene = timelinesOf(view)[0]!;
				const applied = unwrapOutcome(await definition.apply(view, op as never, ctx));
				detail = applied.detail;
				next = mergeView(current, scene, view, applied.document);
			}
		} catch (error) {
			if (error instanceof OpFailure) throw new OpError(index, op.op, error.message);
			console.error(`[editor-core] ${op.op} failed`, error);
			throw new OpError(index, op.op, 'This change could not be applied to the project.');
		}
		results.push({ op: op.op, summary: definition.describe(op as never), changed: !same(next, current), ...(detail !== undefined ? { detail } : {}) });
		current = next;
		steps.push({ op: op.op, document: current });
	}
	// Derived state is rebuilt after every batch: voiceover muting and ducking, orphan voice captions, and the
	// keyframes camera moves bake onto the speaker. A document with neither passes through untouched.
	if (current !== document) {
		for (const scene of timelinesOf(current)) {
			const view = viewOf(current, scene);
			current = mergeView(current, scene, view, syncCameraMoves(syncVoiceovers(view)));
		}
	}
	if (current !== document) current = captionsOnTop(current);
	if (current !== document && !same(current, document)) rejectNewTimingIssues(document, current, steps);
	if (!same(current, document)) {
		current = current === document ? clone(current) : current;
		stamp(current);
	}
	return { document: current, results };
}
export { activeScene, timesOf } from './timeline';

