/**
 * `add_3d_studio` (spec studio-3d M3): chèn một cảnh 3D Studio — video render
 * trên GPU từ dữ liệu cảnh (`@opencmo/clip-three`). Op chỉ ghi KHAI BÁO
 * `generate.video` (model `studio-3d`, spec mang `scene`) vào một rect đặt trong
 * vùng visual; editor phân giải khai báo qua `/api/v1/generations` như mọi
 * lượt Generate, preview hiện "Rendering 3D…" tới khi video về.
 *
 * `agent: false`: tốn credit, nên Assistant đi qua tool riêng có thẻ duyệt giá.
 */

import { z } from 'zod';

import { formatValue, SceneContentSchema, SceneFields, type SceneContent } from '@opencmo/clip-three';
import type { AssetDeclaration, ClipDocument } from '@opencmo/clip-doc';

import { readBrand } from '../brand';
import { clone, sceneOf } from '../doc';
import { panelRegionAt } from '../layout';
import { defaultRegion, r2, toPixels, type Box } from '../visuals/common';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';
import { resolveTiming } from './visuals';

export const STUDIO_MODEL = 'studio-3d';
const RATIOS = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 } as const;
type Ratio = keyof typeof RATIOS;
const MIN_SECONDS = 3;
const MAX_SECONDS = 10;

const region = z
	.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.05).max(1), height: z.number().min(0.05).max(1) })
	.strict();

const fields = {
	start: z.number().finite().min(0).optional(),
	end: z.number().finite().min(0).optional(),
	/** Câu người nói mà cảnh minh hoạ; thiếu start/end thì đặt theo câu này. */
	quote: z.string().trim().min(2).max(300).optional(),
	/** Vùng đặt (chuẩn hoá 0–1). Thiếu: panel khi đang chia đôi, không thì vùng visual mặc định. */
	region: region.optional(),
	/** Tỉ lệ video; thiếu thì chọn tỉ lệ gần vùng đặt nhất. */
	aspect_ratio: z.enum(Object.keys(RATIOS) as [Ratio, ...Ratio[]]).optional(),
	seed: z.number().int().min(0).max(2_147_483_647).optional(),
	...SceneFields.shape,
};

/** Luật chéo trường của cảnh (template nào cần dữ liệu nào) chạy lại trên input phẳng. */
function sceneRules(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
	const parsed = SceneContentSchema.safeParse(sceneOfInput(value));
	if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
}

/** Input của tool agent (không có `op`): object phẳng, JSON schema có `properties`. */
export const studio3dToolInput = z.object(fields).superRefine(sceneRules);

export const studio3dInput = z.object({ op: z.literal('add_3d_studio'), ...fields }).superRefine(sceneRules);

export type Studio3dInput = z.infer<typeof studio3dInput>;

/** Phần input là dữ liệu cảnh — đúng thứ đi vào spec (và hash). */
export function sceneOfInput(input: Record<string, unknown>): SceneContent {
	const { op: _op, start: _s, end: _e, quote: _q, region: _r, aspect_ratio: _a, seed: _seed, ...scene } = input;
	return Object.fromEntries(Object.entries(scene).filter(([, value]) => value !== undefined)) as SceneContent;
}

/** Câu tóm tắt cho người đọc (prompt của generation; tên lớp, tên file). */
export function sceneSummary(scene: SceneContent): string {
	const unit = (value: number) => `${scene.prefix ?? ''}${formatValue(value, scene.decimals)}${scene.suffix ?? ''}`;
	const head = scene.title ? `${scene.title}: ` : '';
	let body: string;
	switch (scene.template) {
		case 'bars':
			body = `3D bars ${(scene.bars ?? []).map((bar) => `${bar.label} ${unit(bar.value)}`).join(', ')}`;
			break;
		case 'number':
			body = `3D number ${unit(scene.value ?? 0)}${scene.label ? ` ${scene.label}` : ''}`;
			break;
		case 'rise':
			body = `3D growth line to ${unit((scene.points ?? []).at(-1) ?? 0)}${scene.label ? ` ${scene.label}` : ''}`;
			break;
		case 'product':
			body = `3D ${scene.object ?? 'object'}${scene.label ? ` ${scene.label}` : ''}`;
			break;
		case 'code':
			// Cảnh agent tự viết: tên là thứ agent đặt (title), không suy được từ code.
			return (scene.title ?? 'Custom 3D animation').slice(0, 200);
	}
	const text = `${head}${body}`.replace(/\s+/g, ' ').trim();
	return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

/** Hình khung của clip (9:16, 16:9…) — agent dựng preview 3D toàn khung theo nó. */
export function frameRatio(document: ClipDocument): Ratio | null {
	const scene = sceneOf(document);
	return scene?.width && scene.height ? nearestRatio({ x: 0, y: 0, width: scene.width, height: scene.height }) : null;
}

function nearestRatio(box: Box): Ratio {
	const aspect = box.width / box.height;
	return (Object.keys(RATIOS) as Ratio[]).reduce((best, key) => (Math.abs(Math.log(RATIOS[key] / aspect)) < Math.abs(Math.log(RATIOS[best] / aspect)) ? key : best));
}

/** Giây của video: dài bằng đoạn hiện, trong khoảng model nhận (3–10, số nguyên). */
export const studioSeconds = (length: number): number => Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(length)));

/**
 * Khai báo + vị trí — dùng chung cho op và tool của agent (tool cần spec để
 * báo giá trước khi op chạy).
 */
export async function planStudio3d(document: ClipDocument, input: Studio3dInput, ctx?: Pick<OpContext, 'readTranscript'>) {
	const scene = sceneOf(document);
	if (!scene?.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
	const frame = { width: scene.width, height: scene.height };
	const workarea = scene.workarea as [number, number] | undefined;
	const when = await resolveTiming(document, ctx, input, { min: MIN_SECONDS, max: MAX_SECONDS });
	const seconds = studioSeconds(when.end - when.start);
	const end = Math.min(when.start + seconds, workarea ? workarea[1] : Infinity);
	if (!(end > when.start)) throw new OpFailure('The 3D scene must end after it starts, inside the clip.');

	const area = (input.region as Box | undefined) ?? panelRegionAt(document, when.start) ?? defaultRegion(frame);
	const pixels = toPixels(area, frame);
	const aspectRatio = input.aspect_ratio ?? nearestRatio(pixels);
	const ratio = RATIOS[aspectRatio];
	const width = Math.min(pixels.width, pixels.height * ratio);
	const height = width / ratio;
	// Clip đã áp Brand Kit: cảnh 3D mang màu + font tiêu đề của kit (vào spec, nên
	// vào hash — đổi kit rồi render lại là một lượt mới, đúng ý).
	const kit = readBrand(document);
	const scene3d = sceneOfInput(input as Record<string, unknown>);
	const branded = kit && !scene3d.brand && !scene3d.theme
		? { ...scene3d, brand: { background: kit.colors.background, text: kit.colors.text, colors: [kit.colors.accent, kit.colors.primary, kit.colors.secondary], font: kit.fonts.heading } }
		: scene3d;
	const content = SceneContentSchema.parse(branded);
	const src: AssetDeclaration = {
		generate: 'video',
		prompt: sceneSummary(content),
		model: STUDIO_MODEL,
		aspectRatio,
		duration: seconds,
		scene: content as Record<string, unknown>,
		...(input.seed === undefined ? {} : { seed: input.seed }),
	};
	const box = {
		x: Math.round(pixels.x + (pixels.width - width) / 2),
		y: Math.round(pixels.y + (pixels.height - height) / 2),
		width: Math.round(width),
		height: Math.round(height),
	};
	return { src, box, start: r2(when.start), end: r2(end), spec: { prompt: src.prompt, aspectRatio, duration: seconds, scene: content, ...(input.seed === undefined ? {} : { seed: input.seed }) } };
}

export const add3dStudio = {
	name: 'add_3d_studio',
	agent: false,
	input: studio3dInput,
	describe: (input: Studio3dInput) => `Render a 3D scene: ${sceneSummary(sceneOfInput(input as Record<string, unknown>))}`,
	async apply(document: ClipDocument, input: Studio3dInput, ctx?: OpContext) {
		const plan = await planStudio3d(document, input, ctx);
		const next = clone(document);
		const root = sceneOf(next)!;
		// Nằm dưới phụ đề/chữ như mọi media sinh ra: phụ đề không bị che.
		const children = [...(root.children ?? [])];
		const at = children.findIndex((child) => child.kind === 'captions' || child.kind === 'text');
		children.splice(at < 0 ? children.length : at, 0, {
			kind: 'rect',
			name: plan.src.prompt.length > 40 ? `${plan.src.prompt.slice(0, 40)}…` : plan.src.prompt,
			keepAspectRatio: true,
			...plan.box,
			start: plan.start,
			end: plan.end,
			paints: [{ type: 'video', src: plan.src }],
			...(input.quote ? { marks: { studio3d: { quote: input.quote } } } : {}),
		} as never);
		root.children = children;
		return checked(next, 'That 3D scene cannot be added');
	},
};
