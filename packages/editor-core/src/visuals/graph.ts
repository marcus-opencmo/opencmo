/**
 * `add_graph`: đồ thị hàm y = f(x) trên trục, vẽ nét như manim (Axes +
 * plot + Create). Biểu thức do agent/người dùng gõ nên đọc bằng parser nhỏ tự
 * viết — KHÔNG `eval`/`Function`: document chạy lại trên server lúc export.
 */

import { z } from 'zod';

import { ExprError, parseExpr } from '@opencmo/clip-doc';

import { appear, arrowHead, colorAt, drawOn, fitSize, pt, r2, strokePath, textNode, THEME, type Box, type Node, type Point } from './common';
import { regionSchema } from './shape';

/** Công thức theo x (parser của clip-doc, không eval). */
export function parseGraph(source: string): (x: number) => number {
	const f = parseExpr(source, ['x']);
	return (x) => f({ x });
}

export { ExprError };

// ------------------------------------------------------------------ đồ thị

export const graphInput = z
	.object({
		/** Công thức theo x, vd. "x^2", "sin(x)", "2^x". */
		expr: z.string().trim().min(1).max(200),
		x: z.tuple([z.number().finite(), z.number().finite()]).optional(),
		/** Khoảng y; thiếu thì tự lấy theo giá trị hàm. */
		y: z.tuple([z.number().finite(), z.number().finite()]).optional(),
		label: z.string().trim().max(40).optional(),
		title: z.string().trim().min(1).max(60).optional(),
		region: regionSchema.optional(),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
		draw_on: z.boolean().optional(),
	})
	.superRefine((input, ctx) => {
		try {
			parseGraph(input.expr);
		} catch (error) {
			ctx.addIssue({ code: 'custom', path: ['expr'], message: error instanceof Error ? error.message : 'Invalid formula.' });
		}
		if (input.x && input.x[1] <= input.x[0]) ctx.addIssue({ code: 'custom', path: ['x'], message: 'The x range must go from low to high.' });
		if (input.y && input.y[1] <= input.y[0]) ctx.addIssue({ code: 'custom', path: ['y'], message: 'The y range must go from low to high.' });
	});

export type GraphInput = z.infer<typeof graphInput>;

const SAMPLES = 240;

export function buildGraph(input: GraphInput, frame: { width: number; height: number }, area: Box, duration: number): Node[] {
	const unit = Math.min(frame.width, frame.height) / 1080;
	const f = parseGraph(input.expr);
	const [x0, x1] = input.x ?? [-5, 5];
	const xs = Array.from({ length: SAMPLES + 1 }, (_, k) => x0 + ((x1 - x0) * k) / SAMPLES);
	const ys = xs.map((x) => f(x));
	const finite = ys.filter((y) => Number.isFinite(y));
	if (!finite.length) throw new ExprError('The formula has no value in that x range.');
	let [y0, y1] = input.y ?? [Math.min(...finite), Math.max(...finite)];
	if (y1 - y0 < 1e-9) {
		y0 -= 1;
		y1 += 1;
	}
	if (!input.y) {
		// Chừa 8% hai đầu để đỉnh đồ thị không dính mép.
		const pad = (y1 - y0) * 0.08;
		y0 -= pad;
		y1 += pad;
	}
	const out: Node[] = [];
	let body = area;
	if (input.title) {
		const h = Math.min(area.height * 0.16, 90 * unit);
		out.push({ ...textNode(input.title, { x: area.x, y: area.y, width: area.width, height: h }, { size: fitSize([input.title], area.width, h, 60 * unit) }), animations: appear('fade', 0) });
		body = { x: area.x, y: area.y + h * 1.2, width: area.width, height: area.height - h * 1.2 };
	}
	const X = (x: number) => body.x + ((x - x0) / (x1 - x0)) * body.width;
	const Y = (y: number) => body.y + (1 - (y - y0) / (y1 - y0)) * body.height;

	// Trục: đi qua 0 nếu 0 trong khoảng, không thì bám mép.
	const axisY = Y(Math.min(Math.max(0, y0), y1));
	const axisX = X(Math.min(Math.max(0, x0), x1));
	const head = 18 * unit;
	const axes = `M ${pt([body.x, axisY])} L ${pt([body.x + body.width, axisY])} ${arrowHead([body.x + body.width, axisY], [1, 0], head)} M ${pt([axisX, body.y + body.height])} L ${pt([axisX, body.y])} ${arrowHead([axisX, body.y], [0, -1], head)}`;
	const draw = input.draw_on !== false;
	out.push(strokePath(axes, '#E2E8F0', 4 * unit, draw ? { drawAt: 0, drawFor: 0.5, shadow: false } : { shadow: false }));

	// Đường: bẻ ở chỗ hàm không xác định hoặc nhảy vọt (tan, 1/x).
	const jump = (y1 - y0) * 1.5;
	const parts: string[] = [];
	let pen = false;
	let previous: number | null = null;
	xs.forEach((x, k) => {
		const y = ys[k]!;
		const ok = Number.isFinite(y) && y > y0 - jump && y < y1 + jump && (previous === null || Math.abs(y - previous) < jump);
		if (!ok) {
			pen = false;
			previous = Number.isFinite(y) ? y : null;
			return;
		}
		const clamped: Point = [X(x), Y(Math.min(Math.max(y, y0 - (y1 - y0)), y1 + (y1 - y0)))];
		parts.push(`${pen ? 'L' : 'M'} ${pt(clamped)}`);
		pen = true;
		previous = y;
	});
	const color = input.color ?? colorAt(THEME, 1);
	const drawFor = Math.min(1.5, duration * 0.45);
	out.push({
		...strokePath(parts.join(' '), color, 8 * unit),
		// Đường vượt khỏi khung trục bị cắt: mask = hộp đồ thị.
		masks: [{ kind: 'rect', x: r2(body.x), y: r2(body.y), width: r2(body.width), height: r2(body.height), fill: '#000000' }],
		...(draw ? { tracks: [drawOn(0.4, drawFor)] } : {}),
	});
	if (input.label) {
		const w = Math.min(body.width * 0.5, 420 * unit);
		const h = 64 * unit;
		out.push({ ...textNode(input.label, { x: body.x + body.width - w, y: body.y, width: w, height: h }, { size: fitSize([input.label], w, h, 48 * unit), color, align: 'right' }), animations: appear('fade', draw ? 0.4 + drawFor : 0) });
	}
	return out;
}
