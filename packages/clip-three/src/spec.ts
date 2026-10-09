/**
 * Spec của một cảnh 3D Studio (spec studio-3d): thứ DUY NHẤT quyết định video
 * ra — cùng spec, cùng khung hình. Hash của spec là khoá cache của lượt render
 * (đường Generate), nên mọi thứ ảnh hưởng hình phải nằm ở đây, kể cả seed.
 *
 * File này chỉ có zod, không có three: editor-core, route web và engine đều
 * kiểm spec mà không kéo cả thư viện 3D.
 */

import { z } from 'zod';

/** `code`: cảnh do agent tự viết code three.js (spec code-scenes); code lưu ở `scene_codes`, scene chỉ mang `code_ref`. */
export const TEMPLATES = ['bars', 'number', 'rise', 'product', 'code'] as const;
export const THEMES = ['midnight', 'aurora', 'sunset', 'mono'] as const;

/** Trần độ dài code cảnh (template `code`), cùng số với SQL `save_scene_code`. */
export const MAX_CODE_CHARS = 32_000;
export const PRODUCTS = ['phone', 'laptop', 'coin', 'gift', 'trophy', 'rocket', 'lightbulb', 'globe', 'box', 'bottle'] as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const label = z.string().trim().min(1).max(24);

export const BarSchema = z.object({ label, value: z.number().finite().min(0).max(1e12), highlight: z.boolean().optional() }).strict();

/** Nội dung cảnh (không có cỡ khung, thời lượng): phần `scene` trong spec Generate. */
const sceneFields = {
	template: z.enum(TEMPLATES),
	/** Dòng tiêu đề nhỏ trên cảnh (tuỳ chọn). */
	title: z.string().trim().min(1).max(40).optional(),
	theme: z.enum(THEMES).optional(),
	/** Màu nhấn (cột nổi bật, đường tăng trưởng, ánh sáng viền). */
	accent: hex.optional(),
	/** bars: 2–6 cột. */
	bars: z.array(BarSchema).min(2).max(6).optional(),
	/** number: con số lớn đếm lên. */
	value: z.number().finite().min(-1e12).max(1e12).optional(),
	decimals: z.number().int().min(0).max(2).optional(),
	prefix: z.string().max(3).optional(),
	suffix: z.string().max(4).optional(),
	/** Nhãn dưới con số / dưới đường / trên vật thể. */
	label: z.string().trim().min(1).max(40).optional(),
	/** rise: 3–12 giá trị theo thời gian. */
	points: z.array(z.number().finite().min(-1e12).max(1e12)).min(3).max(12).optional(),
	/** product: vật thể dựng sẵn. */
	object: z.enum(PRODUCTS).optional(),
	color: hex.optional(),
	/** code: sha256 của code đã lưu (`save_scene_code`). */
	code_ref: z.string().regex(/^[0-9a-f]{64}$/).optional(),
	/** code: mọi chữ cảnh vẽ ra — để subset font brand (chữ nằm trong code, không trong field). */
	glyphs: z.string().max(400).optional(),
	/**
	 * Brand Kit của clip: thay theme bằng màu thương hiệu (nền, chữ, bảng màu —
	 * màu đầu là màu nhấn) và font tiêu đề (một họ font tự host của editor).
	 */
	brand: z
		.object({
			background: hex,
			text: hex,
			colors: z.array(hex).min(1).max(6),
			font: z.string().regex(/^[A-Za-z0-9 ]{2,40}$/).optional(),
		})
		.strict()
		.optional(),
};

function requireData(spec: { template: Template; bars?: unknown; value?: unknown; points?: unknown; object?: unknown; code_ref?: unknown }, ctx: z.RefinementCtx): void {
	const need = (key: 'bars' | 'value' | 'points' | 'object' | 'code_ref', message: string) => {
		if (spec[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message });
	};
	if (spec.template === 'bars') need('bars', 'bars needs 2-6 bars with a label and a value.');
	if (spec.template === 'number') need('value', 'number needs a value.');
	if (spec.template === 'rise') need('points', 'rise needs 3-12 points.');
	if (spec.template === 'product') need('object', `product needs an object: ${PRODUCTS.join(', ')}.`);
	if (spec.template === 'code') need('code_ref', 'code needs code_ref (save the scene code first).');
}

/** Các trường của cảnh, chưa có luật chéo — op/tool phẳng hoá vào input của mình. */
export const SceneFields = z.object(sceneFields);

export const SceneContentSchema = z.object(sceneFields).strict().superRefine(requireData);
export type SceneContent = z.infer<typeof SceneContentSchema>;

export const SceneSpecSchema = z
	.object({
		...sceneFields,
		/** Giây của video; cảnh tự dàn nhịp theo độ dài này. */
		duration: z.number().min(3).max(10),
		width: z.number().int().min(64).max(1920),
		height: z.number().int().min(64).max(1920),
		seed: z.number().int().min(0).max(2_147_483_647).optional(),
	})
	.strict()
	.superRefine((spec, ctx) => {
		requireData(spec, ctx);
		if (spec.width % 2 || spec.height % 2) ctx.addIssue({ code: 'custom', path: ['width'], message: 'width and height must be even.' });
	});

/** Cỡ khung render theo tỉ lệ: cạnh ngắn 1080, cạnh dài không quá 1920. */
export function frameSize(aspectRatio: string): { width: number; height: number } {
	const [w, h] = aspectRatio.split(':').map(Number) as [number, number];
	const scale = Math.min(1080 / Math.min(w, h), 1920 / Math.max(w, h));
	const even = (value: number) => Math.round((value * scale) / 2) * 2;
	return { width: even(w), height: even(h) };
}

export type SceneSpec = z.infer<typeof SceneSpecSchema>;
export type Template = (typeof TEMPLATES)[number];
export type Theme = (typeof THEMES)[number];
export type Product = (typeof PRODUCTS)[number];

export const FPS = 30;

/** Số khung của video (làm tròn lên, ít nhất 1). */
export const frameCount = (spec: Pick<SceneSpec, 'duration'>): number => Math.max(1, Math.ceil(spec.duration * FPS));

/** Chuỗi con số như người đọc: 12.5K, 3.2M, 1,234 — cùng hàm cho nhãn và số đếm. */
export function formatValue(value: number, decimals?: number): string {
	const abs = Math.abs(value);
	const compact = (n: number, unit: string) => `${(value / n).toFixed(decimals ?? (abs / n >= 100 ? 0 : 1)).replace(/\.0$/, '')}${unit}`;
	if (abs >= 1e9) return compact(1e9, 'B');
	if (abs >= 1e6) return compact(1e6, 'M');
	if (abs >= 1e4) return compact(1e3, 'K');
	return value.toLocaleString('en-US', { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? (Number.isInteger(value) ? 0 : 1) });
}

/** Phần spec Generate mà 3D Studio đọc (model `studio-3d`). */
export type SceneGeneration = { scene: SceneContent; aspectRatio: string; duration: number; seed?: number };

/**
 * Spec Generate → spec render. Cỡ khung suy từ tỉ lệ (không nằm trong spec
 * Generate): cùng spec Generate luôn ra cùng khung, nên hash vẫn là khoá cache.
 */
export function fromGeneration(input: SceneGeneration): SceneSpec {
	return SceneSpecSchema.parse({ ...input.scene, ...frameSize(input.aspectRatio), duration: input.duration, ...(input.seed === undefined ? {} : { seed: input.seed }) });
}
