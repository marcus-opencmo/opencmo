/**
 * `add_shape`: một nét chỉ trỏ trên video — mũi tên, gạch chân, khoanh tròn,
 * tô sáng. Loại visual dùng nhiều nhất cho video người nói: chỉ vào thứ đang
 * được nhắc tới. Vẽ nét như tay vẽ (Create của manim).
 */

import { z } from 'zod';

import { tint, arrowPath, diamondPath, ellipsePath, pt, roundRectPath, strokePath, THEME, type Box, type Node, type Point } from './common';

export const SHAPES = ['arrow', 'line', 'underline', 'circle', 'box', 'diamond', 'highlight', 'check', 'cross'] as const;

const unit = z.number().min(-0.5).max(1.5);
const point = z.tuple([unit, unit]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Colors are hex, like #FFD400.');
export const regionSchema = z.object({ x: unit, y: unit, width: z.number().min(0.01).max(2), height: z.number().min(0.01).max(2) });

export const shapeInput = z
	.object({
		shape: z.enum(SHAPES),
		/** Đường (arrow/line/underline): điểm đầu và cuối, chuẩn hoá 0–1 theo khung. */
		from: point.optional(),
		to: point.optional(),
		/** Hình khép (circle/box/diamond/highlight/check/cross): hộp chuẩn hoá. */
		box: regionSchema.optional(),
		/** Độ cong của mũi tên, −1…1 (0 = thẳng). */
		bend: z.number().min(-1).max(1).optional(),
		color: color.optional(),
		/** Bề dày nét, px của khung 1080 (tự scale theo khung). */
		width: z.number().min(1).max(60).optional(),
		/** Vẽ nét dần (mặc định có) trong `draw_seconds`. */
		draw_on: z.boolean().optional(),
		draw_seconds: z.number().min(0.1).max(5).optional(),
	})
	.refine((input) => (['arrow', 'line', 'underline'].includes(input.shape) ? Boolean(input.from && input.to) : Boolean(input.box)), {
		message: 'Arrows and lines need "from" and "to"; other shapes need a "box".',
	});

export type ShapeInput = z.infer<typeof shapeInput>;

export const SHAPE_NAMES: Record<(typeof SHAPES)[number], string> = {
	arrow: 'Arrow',
	line: 'Line',
	underline: 'Underline',
	circle: 'Circle',
	box: 'Box',
	diamond: 'Diamond',
	highlight: 'Highlight',
	check: 'Check mark',
	cross: 'Cross',
};

export function buildShape(input: ShapeInput, frame: { width: number; height: number }): Node[] {
	const scale = Math.min(frame.width, frame.height) / 1080;
	const width = (input.width ?? (input.shape === 'underline' ? 12 : 10)) * scale;
	const color = input.color ?? THEME.accent;
	const drawFor = input.draw_seconds ?? 0.6;
	const draw = input.draw_on === false ? {} : { drawAt: 0, drawFor };
	const px = ([x, y]: [number, number]): Point => [x * frame.width, y * frame.height];
	const boxPx = (b: Box): Box => ({ x: b.x * frame.width, y: b.y * frame.height, width: b.width * frame.width, height: b.height * frame.height });

	switch (input.shape) {
		case 'arrow':
			return [strokePath(arrowPath(px(input.from!), px(input.to!), input.bend ?? 0.25, Math.max(28 * scale, width * 3.2)), color, width, draw)];
		case 'line':
			return [strokePath(`M ${pt(px(input.from!))} L ${pt(px(input.to!))}`, color, width, draw)];
		case 'underline': {
			// Hơi cong lên ở giữa: gạch chân bằng tay, không phải thước kẻ.
			const a = px(input.from!);
			const b = px(input.to!);
			const control: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + width * 1.2];
			return [strokePath(`M ${pt(a)} Q ${pt(control)} ${pt(b)}`, color, width, draw)];
		}
		case 'circle':
			return [strokePath(ellipsePath(boxPx(input.box!)), color, width, draw)];
		case 'box':
			return [strokePath(roundRectPath(boxPx(input.box!), 24 * scale), color, width, draw)];
		case 'diamond':
			return [strokePath(diamondPath(boxPx(input.box!)), color, width, draw)];
		case 'highlight': {
			// Vệt bút dạ quang: nền trong suốt nửa, mọc từ trái sang (keyframe width).
			const b = boxPx(input.box!);
			return [
				{
					kind: 'rect',
					x: b.x,
					y: b.y,
					width: b.width,
					height: b.height,
					...tint(color, 0.4),
					cornerRadius: Math.min(12 * scale, b.height / 3),
					...(input.draw_on === false
						? {}
						: { tracks: [{ property: 'width', keyframes: [{ time: 0, value: 0, easing: 'easeOut' }, { time: drawFor, value: b.width }] }] }),
				},
			];
		}
		case 'check': {
			const b = boxPx(input.box!);
			const d = `M ${pt([b.x + b.width * 0.08, b.y + b.height * 0.55])} L ${pt([b.x + b.width * 0.4, b.y + b.height * 0.85])} L ${pt([b.x + b.width * 0.92, b.y + b.height * 0.15])}`;
			return [strokePath(d, input.color ?? '#4ADE80', width * 1.4, draw)];
		}
		case 'cross': {
			const b = boxPx(input.box!);
			const d = `M ${pt([b.x, b.y])} L ${pt([b.x + b.width, b.y + b.height])} M ${pt([b.x + b.width, b.y])} L ${pt([b.x, b.y + b.height])}`;
			return [strokePath(d, input.color ?? '#F87171', width * 1.4, draw)];
		}
	}
}
