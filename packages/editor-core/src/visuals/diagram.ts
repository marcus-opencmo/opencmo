/**
 * `add_diagram`: các ô có nhãn nối bằng mũi tên — quy trình, vòng lặp, cây,
 * so sánh. Tự dàn trong vùng đặt; `build` cho ô hiện lần lượt, mũi tên vẽ nét
 * nối sang ô kế — nhịp của người đang liệt kê từng bước.
 */

import { z } from 'zod';

import {
	appear,
	arrowPath,
	colorAt,
	diamondPath,
	ellipsePath,
	fitSize,
	r2,
	roundRectPath,
	strokePath,
	textNode,
	THEME,
	tint,
	wrapLabel,
	type Box,
	type Node,
	type Point,
} from './common';
import { regionSchema } from './shape';

export const LAYOUTS = ['row', 'column', 'cycle', 'tree', 'compare'] as const;
export const NODE_SHAPES = ['box', 'pill', 'circle', 'diamond'] as const;

const label = z.string().trim().min(1).max(60);

export const diagramInput = z
	.object({
		nodes: z
			.array(
				z.object({
					label,
					shape: z.enum(NODE_SHAPES).optional(),
					/** Chỉ cho layout `compare`: gạch đầu dòng dưới tiêu đề cột. */
					items: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
				}),
			)
			.min(1)
			.max(8),
		/** Cạnh theo chỉ số ô (0-based). Thiếu thì nối lần lượt (row/column/cycle) hoặc gốc → con (tree). */
		edges: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0) })).max(16).optional(),
		layout: z.enum(LAYOUTS).optional(),
		title: z.string().trim().min(1).max(60).optional(),
		region: regionSchema.optional(),
		/** Hiện dần từng ô (mặc định có). */
		build: z.boolean().optional(),
		/** Giây giữa hai ô khi `build`. */
		step: z.number().min(0.1).max(5).optional(),
		colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).optional(),
	})
	.refine((input) => (input.edges ?? []).every((edge) => edge.from < input.nodes.length && edge.to < input.nodes.length), {
		message: 'Edges point to node numbers that do not exist.',
	})
	.refine((input) => input.layout !== 'compare' || input.nodes.length === 2, { message: 'A compare diagram has exactly two nodes.' });

export type DiagramInput = z.infer<typeof diagramInput>;

type Placed = { box: Box; shape: (typeof NODE_SHAPES)[number] };

/** Hộp của từng ô trong vùng `area` (pixel). */
function place(input: DiagramInput, area: Box, portrait: boolean): Placed[] {
	const n = input.nodes.length;
	const layout = input.layout ?? (portrait && n > 3 ? 'column' : 'row');
	const shapeOf = (index: number) => input.nodes[index]!.shape ?? (layout === 'cycle' ? 'pill' : 'box');
	const gap = Math.min(area.width, area.height) * 0.08;

	if (layout === 'row') {
		const w = (area.width - gap * 1.6 * (n - 1)) / n;
		const h = Math.min(area.height, w * 0.72);
		const y = area.y + (area.height - h) / 2;
		return input.nodes.map((_, i) => ({ box: { x: area.x + i * (w + gap * 1.6), y, width: w, height: h }, shape: shapeOf(i) }));
	}
	if (layout === 'column') {
		const h = (area.height - gap * (n - 1)) / n;
		const w = Math.min(area.width * 0.8, Math.max(h * 3.2, area.width * 0.5));
		const x = area.x + (area.width - w) / 2;
		return input.nodes.map((_, i) => ({ box: { x, y: area.y + i * (h + gap), width: w, height: h }, shape: shapeOf(i) }));
	}
	if (layout === 'cycle') {
		const radius = Math.min(area.width, area.height) * 0.36;
		const center: Point = [area.x + area.width / 2, area.y + area.height / 2];
		const w = Math.min(radius * 1.15, (2 * Math.PI * radius) / n - gap);
		const h = Math.min(w * 0.55, radius * 0.6);
		return input.nodes.map((_, i) => {
			const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
			const cx = center[0] + Math.cos(angle) * radius;
			const cy = center[1] + Math.sin(angle) * radius;
			return { box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h }, shape: shapeOf(i) };
		});
	}
	if (layout === 'tree') {
		// Gốc ở hàng trên, còn lại xếp hàng dưới.
		const rest = Math.max(1, n - 1);
		const h = Math.min(area.height * 0.34, (area.width / rest) * 0.6);
		const w = Math.min(area.width * 0.45, (area.width - gap * (rest - 1)) / rest);
		const rootW = Math.min(area.width * 0.6, w * 1.4);
		const root: Placed = { box: { x: area.x + (area.width - rootW) / 2, y: area.y, width: rootW, height: h }, shape: shapeOf(0) };
		const rowWidth = rest * w + (rest - 1) * gap;
		const left = area.x + (area.width - rowWidth) / 2;
		const children = input.nodes.slice(1).map((_, i) => ({
			box: { x: left + i * (w + gap), y: area.y + area.height - h, width: w, height: h },
			shape: shapeOf(i + 1),
		}));
		return [root, ...children];
	}
	// compare: hai cột cao, chữ VS ở giữa.
	const w = (area.width - gap * 3) / 2;
	return [0, 1].map((i) => ({ box: { x: area.x + i * (w + gap * 3), y: area.y, width: w, height: area.height }, shape: shapeOf(i) }));
}

function outline(placed: Placed, radius: number): string {
	switch (placed.shape) {
		case 'circle':
			return ellipsePath(placed.box);
		case 'diamond':
			return diamondPath(placed.box);
		case 'pill':
			return roundRectPath(placed.box, placed.box.height / 2);
		default:
			return roundRectPath(placed.box, radius);
	}
}

const centerOf = (box: Box): Point => [box.x + box.width / 2, box.y + box.height / 2];

/** Điểm trên mép hộp theo hướng tới `toward` (giao với hình chữ nhật bao). */
function edgePoint(box: Box, toward: Point, margin: number): Point {
	const [cx, cy] = centerOf(box);
	const dx = toward[0] - cx;
	const dy = toward[1] - cy;
	const hw = box.width / 2 + margin;
	const hh = box.height / 2 + margin;
	const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 1e-9);
	return [cx + dx * scale, cy + dy * scale];
}

export function buildDiagram(input: DiagramInput, frame: { width: number; height: number }, area: Box, duration: number): Node[] {
	const unit = Math.min(frame.width, frame.height) / 1080;
	const layout = input.layout ?? (frame.height > frame.width && input.nodes.length > 3 ? 'column' : 'row');
	const out: Node[] = [];
	let body = area;
	if (input.title) {
		const titleHeight = Math.min(area.height * 0.18, 90 * unit);
		out.push({ ...textNode(input.title, { x: area.x, y: area.y, width: area.width, height: titleHeight }, { size: fitSize([input.title], area.width, titleHeight, 64 * unit) }), animations: appear('fade', 0) });
		body = { x: area.x, y: area.y + titleHeight * 1.15, width: area.width, height: area.height - titleHeight * 1.15 };
	}
	const placed = place({ ...input, layout }, body, frame.height > frame.width);
	const theme = { ...THEME, ...(input.colors?.length ? { palette: input.colors } : {}) };
	const build = input.build !== false;
	// Nhịp mặc định: cả diagram dựng xong trong ~60% thời gian hiện.
	const step = build ? Math.min(input.step ?? 0.7, (duration * 0.6) / Math.max(1, input.nodes.length)) : 0;
	const lead = input.title ? 0.3 : 0;
	const at = (index: number) => r2(lead + index * step);

	placed.forEach((item, index) => {
		const node = input.nodes[index]!;
		const color = colorAt(theme, index);
		out.push({
			kind: 'path',
			d: outline(item, 20 * unit),
			...tint(theme.panel, theme.panelOpacity),
			strokes: [{ color, width: r2(5 * unit), join: 'round' }],
			...(build ? { animations: appear('grow', at(index)) } : {}),
		});
		if (layout === 'compare') {
			const headerHeight = Math.min(item.box.height * 0.22, 110 * unit);
			const header = { x: item.box.x, y: item.box.y + headerHeight * 0.2, width: item.box.width, height: headerHeight };
			out.push({ ...textNode(node.label, header, { size: fitSize(wrapLabel(node.label, 1), header.width, header.height, 60 * unit), color }), ...(build ? { animations: appear('fade', at(index) + 0.15) } : {}) });
			const items = node.items ?? [];
			const rowHeight = Math.min((item.box.height - headerHeight * 1.4) / Math.max(1, items.length), 80 * unit);
			const rowWidth = item.box.width * 0.84;
			// Một cỡ cho mọi gạch đầu dòng (của cả hai cột): cỡ lệch nhau trông như lỗi.
			const bullets = input.nodes.flatMap((other) => (other.items ?? []).map((entry) => `• ${entry}`));
			const itemSize = Math.min(...bullets.map((line) => fitSize([line], rowWidth, rowHeight, 40 * unit)));
			items.forEach((text, k) => {
				const row = { x: item.box.x + item.box.width * 0.08, y: item.box.y + headerHeight * 1.4 + k * rowHeight, width: rowWidth, height: rowHeight };
				out.push({
					...textNode(`• ${text}`, row, { size: itemSize, align: 'left', weight: 600 }),
					...(build ? { animations: appear('slideUp', at(index) + 0.3 + k * 0.15, 0.3) } : {}),
				});
			});
			return;
		}
		const lines = wrapLabel(node.label, 2);
		const inner = item.shape === 'diamond' || item.shape === 'circle' ? { ...item.box, x: item.box.x + item.box.width * 0.15, width: item.box.width * 0.7 } : item.box;
		out.push({
			...textNode(lines.join('\n'), inner, { size: fitSize(lines, inner.width, inner.height, 56 * unit) }),
			...(build ? { animations: appear('fade', at(index) + 0.15) } : {}),
		});
	});

	if (layout === 'compare') {
		const [a, b] = placed as [Placed, Placed];
		const mid: Point = [(a.box.x + a.box.width + b.box.x) / 2, a.box.y + a.box.height / 2];
		const size = Math.min(b.box.x - (a.box.x + a.box.width), 140 * unit);
		out.push({ ...textNode('VS', { x: mid[0] - size, y: mid[1] - size / 2, width: size * 2, height: size }, { size: Math.round(size * 0.55), color: theme.palette[0] }), ...(build ? { animations: appear('grow', at(1) - 0.1) } : {}) });
		return out;
	}

	const edges =
		input.edges ??
		(layout === 'tree'
			? placed.slice(1).map((_, i) => ({ from: 0, to: i + 1 }))
			: placed.slice(1).map((_, i) => ({ from: i, to: i + 1 })).concat(layout === 'cycle' && placed.length > 2 ? [{ from: placed.length - 1, to: 0 }] : []));
	const head = 22 * unit;
	for (const edge of edges) {
		const from = placed[edge.from]!.box;
		const to = placed[edge.to]!.box;
		const start = edgePoint(from, centerOf(to), 10 * unit);
		const end = edgePoint(to, centerOf(from), 12 * unit);
		if (Math.hypot(end[0] - start[0], end[1] - start[1]) < head * 1.5) continue;
		const bend = layout === 'cycle' ? 0.35 : 0;
		// Mũi tên vẽ ngay sau ô nguồn (ô đích kế tiếp hiện khi nó vừa xong); cạnh
		// quay về ô đầu của vòng vì thế vẽ sau cùng.
		const drawAt = build ? at(edge.from) + Math.min(0.3, step * 0.4) : undefined;
		out.push(strokePath(arrowPath(start, end, bend, head), theme.line, 5 * unit, build ? { drawAt, drawFor: Math.max(0.2, step * 0.5) } : {}));
	}
	return out;
}
