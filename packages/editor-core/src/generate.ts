/**
 * Catalog model sinh media (spec AI Studio §7.2) cho phía TypeScript: route
 * kiểm spec (lớp 1), editor hiện giá trước khi bấm. Bản gốc là
 * `packages/contracts/ai-models.json`; SQL giữ bản sao trong `ai_models`
 * (check:api so hai bên), worker đọc file JSON đó.
 *
 * Không ts-morph, không DOM: editor import được mà không kéo cả bộ sửa TSX.
 */

import { z } from 'zod';

import { SceneContentSchema, type SceneContent } from '@opencmo/clip-three';

import catalog from '../../contracts/ai-models.json';

export type GenerationKind = 'image' | 'video' | 'voice' | 'audio';

export type AiModel = {
	id: string;
	kind: GenerationKind;
	provider: string;
	/** Id model phía provider; chỉ worker dùng. */
	providerModel?: string;
	/** Endpoint phụ theo chế độ (aggregator): `image` = ảnh→video, `edit` = ảnh có tham chiếu. Chỉ worker dùng. */
	providerModels?: Record<string, string>;
	name: string;
	description: string;
	/** `resolution`: hệ số nhân theo độ phân giải (thiếu = 1), làm tròn lên — cùng `ai_price` (SQL). */
	price: { unit: 'generation' | 'second' | 'kchars'; credits: number; resolution?: Record<string, number> };
	limits: {
		maxPromptChars: number;
		aspectRatios?: string[];
		durations?: number[];
		minSeconds?: number;
		maxSeconds?: number;
		voices?: string[];
		/** Số ảnh tham chiếu model nhận; thiếu = 0. */
		maxReferences?: number;
		/** 3D Studio: spec mang `scene` (dữ liệu cảnh), `prompt` chỉ là câu tóm tắt. */
		scene?: boolean;
		/** Độ phân giải chọn được (ảnh/video); có thì spec nhận `resolution`. */
		resolutions?: string[];
		/** Video bắt đầu / kết thúc trên ảnh của người dùng (`startImage` / `endImage`). */
		firstFrame?: boolean;
		lastFrame?: boolean;
		/** Video có tiếng bật/tắt được (`audio`). */
		audio?: boolean;
		/**
		 * Sửa video có sẵn (G2, video-to-video): spec BẮT BUỘC mang `sourceVideo` + `sourceStart`;
		 * `duration` là số giây cắt từ nguồn. Không hiện trong danh sách sinh thường.
		 */
		sourceVideo?: boolean;
		/** Upscale (G4): model `sourceVideo` không cần lời — provider gửi độ phân giải đích. */
		upscale?: boolean;
		/** Tên tham số kích thước phía provider (chỉ worker dùng). */
		sizeParam?: string;
	};
};

export const AI_MODELS = catalog.models as AiModel[];

export const aiModel = (id: string): AiModel | undefined => AI_MODELS.find((model) => model.id === id);

/** Spec đã chuẩn hoá — đúng thứ được băm (JCS) và lưu vào `generations.spec`. */
export type GenerationSpec = {
	prompt: string;
	aspectRatio?: string;
	duration?: number;
	voice?: string;
	/** Model 3D Studio: nội dung cảnh — thứ quyết định hình, nằm trong hash. */
	scene?: SceneContent;
	seed?: number;
	resolution?: string;
	/** Tên object trong bucket `media` của chính người dùng (`<uid>/…`); SQL kiểm chủ + tồn tại. */
	startImage?: string;
	endImage?: string;
	references?: string[];
	audio?: boolean;
	/** Video nguồn của model sửa video (tên object media) và giây bắt đầu cắt trong file đó. */
	sourceVideo?: string;
	sourceStart?: number;
};

/** Tên object media của người dùng: kiểm hình dạng ở đây, chủ sở hữu + tồn tại ở SQL. */
const mediaRef = z
	.string()
	.max(500)
	.regex(/^[0-9a-f-]{36}\/[^]+$/, 'Choose an image from your library.')
	.refine((value) => !value.includes('..'), 'Choose an image from your library.');

/**
 * Schema zod của spec theo MỘT model: field nào không thuộc loại đó bị từ chối
 * (`strict`), để hai spec khác nhau không bao giờ băm ra cùng một hash chỉ vì
 * một field lạ bị bỏ qua ở lớp dưới.
 */
export function specSchema(model: AiModel) {
	const { limits } = model;
	const prompt = z.string().trim().min(1, 'Write a prompt first.').max(limits.maxPromptChars, `Keep the prompt under ${limits.maxPromptChars} characters.`);
	const seed = z.number().int().min(0).max(2_147_483_647).optional();
	const aspectRatio = z.enum((limits.aspectRatios ?? ['16:9']) as [string, ...string[]], {
		error: `${model.name} does not support that aspect ratio.`,
	});
	// Trường theo khả năng của model: model không khai báo thì `strict` từ chối trường đó.
	const resolution = limits.resolutions?.length
		? { resolution: z.enum(limits.resolutions as [string, ...string[]], { error: `${model.name} does not support that resolution.` }).optional() }
		: {};
	const references = (limits.maxReferences ?? 0) > 0
		? { references: z.array(mediaRef).min(1).max(limits.maxReferences!, `${model.name} takes up to ${limits.maxReferences} reference images.`).optional() }
		: {};
	switch (model.kind) {
		case 'image':
			return z.strictObject({ prompt, aspectRatio, ...resolution, ...references, seed });
		case 'video':
			return z.strictObject({
				prompt,
				aspectRatio,
				duration: z.number().int().refine((value) => (limits.durations ?? []).includes(value), {
					message: `${model.name} does not support that duration.`,
				}),
				...resolution,
				...references,
				...(limits.firstFrame ? { startImage: mediaRef.optional() } : {}),
				...(limits.lastFrame ? { endImage: mediaRef.optional() } : {}),
				...(limits.audio ? { audio: z.boolean().optional() } : {}),
				...(limits.sourceVideo
					? {
							sourceVideo: z.string().max(500).regex(/^[0-9a-f-]{36}\/[^]+$/, 'Choose the video to edit.').refine((value) => !value.includes('..'), 'Choose the video to edit.'),
							sourceStart: z.number().finite().min(0).max(86_400),
						}
					: {}),
				...(limits.scene ? { scene: SceneContentSchema } : {}),
				seed,
			});
		case 'voice':
			return z.strictObject({
				prompt,
				voice: z.enum((limits.voices ?? ['default']) as [string, ...string[]], { error: 'Choose one of the listed voices.' }),
				seed,
			});
		case 'audio':
			return z.strictObject({
				prompt,
				duration: z
					.number()
					.int()
					.min(limits.minSeconds ?? 1, `Sounds are ${limits.minSeconds ?? 1} to ${limits.maxSeconds ?? 22} seconds long.`)
					.max(limits.maxSeconds ?? 22, `Sounds are ${limits.minSeconds ?? 1} to ${limits.maxSeconds ?? 22} seconds long.`),
				seed,
			});
	}
}

/**
 * Giá credit đặt trước cho một spec — cùng công thức với `ai_price()` trong
 * SQL. Worker có thể chốt thấp hơn (chi phí thật), không bao giờ cao hơn.
 */
export function priceOf(model: AiModel, spec: GenerationSpec): number {
	const base = (() => {
		switch (model.price.unit) {
			case 'generation':
				return model.price.credits;
			case 'second':
				return model.price.credits * Math.ceil(spec.duration ?? 1);
			case 'kchars':
				return model.price.credits * Math.max(1, Math.ceil(spec.prompt.trim().length / 1000));
		}
	})();
	const factor = (spec.resolution && model.price.resolution?.[spec.resolution]) || 1;
	return Math.ceil(base * factor);
}
