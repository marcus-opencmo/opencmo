/**
 * Nền chung của visual sinh bằng op (spec visuals §4): bảng màu, vùng đặt, chữ
 * nhãn, hình học đường. Thuần — chỉ dựng object node của clip-doc.
 *
 * Toạ độ vào op là CHUẨN HOÁ 0–1 theo khung (agent và nút bấm không phải biết
 * khung 1080×1920 hay 1920×1080); ra node là pixel của scene.
 */

import { parsePath, pathBounds } from '@opencmo/clip-doc';

export type Node = Record<string, unknown>;
export type Point = [number, number];
export type Box = { x: number; y: number; width: number; height: number };

export type Theme = { text: string; panel: string; panelOpacity: number; line: string; accent: string; palette: string[]; /** Font chữ của visual (Brand Kit); thiếu = Inter. */ font?: string };

/**
 * Màu mặc định đọc được TRÊN VIDEO: chữ trắng, ô nền tối gần đặc, nét vàng.
 * Visual giải thích nằm đè người nói, nên độ tương phản thắng thẩm mỹ.
 */
export const THEME: Theme = {
	text: '#FFFFFF',
	panel: '#0F172A',
	panelOpacity: 0.9,
	line: '#FFFFFF',
	accent: '#FACC15',
	palette: ['#FACC15', '#38BDF8', '#F472B6', '#4ADE80', '#A78BFA', '#FB923C', '#F87171', '#2DD4BF'],
};

/**
 * Tô màu có độ mờ. Renderer bỏ alpha trong mã màu (như DS: "alpha ignored,
 * dùng opacity"), nên nền mờ phải là paint có `opacity`, không phải #RRGGBBAA.
 */
export const tint = (color: string, opacity: number): Node => ({ paints: [{ type: 'solid', color: color.slice(0, 7), opacity: round(opacity) }] });

export const colorAt = (theme: Theme, index: number): string => theme.palette[index % theme.palette.length]!;

/** Bóng dưới nét/chữ: tách khỏi nền video bất kỳ. */
export const SHADOW = { color: '#000000', blur: 12, offsetY: 3, opacity: 0.55 };

const round = (value: number): number => Math.round(value * 100) / 100;
export const r2 = round;

/**
 * Vùng đặt visual (chuẩn hoá). Khung dọc: phần trên, chừa đầu khung và chừa
 * mặt người nói + phụ đề ở nửa dưới. Khung ngang: nửa phải.
 */
export function defaultRegion(frame: { width: number; height: number }): Box {
	return frame.height > frame.width
		? { x: 0.06, y: 0.08, width: 0.88, height: 0.34 }
		: { x: 0.52, y: 0.1, width: 0.44, height: 0.8 };
}

export function toPixels(region: Box, frame: { width: number; height: number }): Box {
	return {
		x: round(region.x * frame.width),
		y: round(region.y * frame.height),
		width: round(region.width * frame.width),
		height: round(region.height * frame.height),
	};
}

/**
 * Ngắt nhãn thành tối đa `maxLines` dòng cân nhau theo số ký tự. Renderer chỉ
 * xuống dòng ở `\n`, và nhãn trong ô diagram phải vừa ô.
 */
export function wrapLabel(label: string, maxLines = 2): string[] {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length <= 1 || label.length <= 12 || maxLines <= 1) return [label.trim()];
	const target = label.length / Math.min(maxLines, words.length);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if (current && current.length + 1 + word.length > target * 1.15 && lines.length < maxLines - 1) {
			lines.push(current);
			current = word;
		} else current = current ? `${current} ${word}` : word;
	}
	lines.push(current);
	return lines;
}

/** Bề ngang ước lượng của một dòng chữ đậm: ~0.56 em mỗi ký tự (Inter đậm). */
export const textWidth = (line: string, size: number): number => line.length * size * 0.56;

/** Cỡ chữ lớn nhất để các dòng vừa `width × height`, trong [min, max]. */
export function fitSize(lines: string[], width: number, height: number, max: number, min = 18): number {
	const longest = Math.max(...lines.map((line) => line.length), 1);
	const byWidth = (width * 0.88) / (longest * 0.56);
	const byHeight = (height * 0.8) / (lines.length * 1.2);
	return Math.round(Math.max(min, Math.min(max, byWidth, byHeight)));
}

export function textNode(text: string, box: Box, options: { size: number; color?: string; weight?: number; align?: 'left' | 'center' | 'right'; shadow?: boolean }): Node {
	return {
		kind: 'text',
		x: round(box.x),
		y: round(box.y),
		width: round(box.width),
		height: round(box.height),
		text,
		color: options.color ?? THEME.text,
		fontFamily: 'Inter',
		fontWeight: options.weight ?? 700,
		fontSize: options.size,
		textAlign: options.align ?? 'center',
		textBaseline: 'middle',
		...(options.shadow === false ? {} : { shadows: [{ ...SHADOW }] }),
	};
}

// ------------------------------------------------------------------ đường

const fmt = (value: number): string => String(round(value));
export const pt = ([x, y]: Point): string => `${fmt(x)} ${fmt(y)}`;

/** Đầu mũi tên hai cạnh ở `tip`, hướng theo vector `dir`. */
export function arrowHead(tip: Point, dir: Point, size: number): string {
	const length = Math.hypot(dir[0], dir[1]) || 1;
	const ux = dir[0] / length;
	const uy = dir[1] / length;
	const back: Point = [tip[0] - ux * size, tip[1] - uy * size];
	const left: Point = [back[0] - uy * size * 0.6, back[1] + ux * size * 0.6];
	const right: Point = [back[0] + uy * size * 0.6, back[1] - ux * size * 0.6];
	return `M ${pt(left)} L ${pt(tip)} L ${pt(right)}`;
}

/**
 * Mũi tên từ `from` tới `to`, cong theo `bend` (−1…1, tỉ lệ độ dài; dương cong
 * sang trái hướng đi). Thân vẽ trước, đầu sau — trim vẽ lần lượt theo `d`.
 */
export function arrowPath(from: Point, to: Point, bend: number, headSize: number): string {
	const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
	const dx = to[0] - from[0];
	const dy = to[1] - from[1];
	const control: Point = [mid[0] + dy * bend * 0.5, mid[1] - dx * bend * 0.5];
	const body = bend === 0 ? `M ${pt(from)} L ${pt(to)}` : `M ${pt(from)} Q ${pt(control)} ${pt(to)}`;
	const dir: Point = bend === 0 ? [dx, dy] : [to[0] - control[0], to[1] - control[1]];
	return `${body} ${arrowHead(to, dir, headSize)}`;
}

/** Ellipse bằng hai cung, bắt đầu ở đỉnh trên, chạy theo chiều kim đồng hồ. */
export function ellipsePath(box: Box): string {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const rx = box.width / 2;
	const ry = box.height / 2;
	return `M ${pt([cx, cy - ry])} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${pt([cx, cy + ry])} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${pt([cx, cy - ry])} Z`;
}

export function roundRectPath(box: Box, radius: number): string {
	const r = Math.min(radius, box.width / 2, box.height / 2);
	const { x, y, width: w, height: h } = box;
	return [
		`M ${pt([x + r, y])}`,
		`H ${fmt(x + w - r)}`,
		`Q ${pt([x + w, y])} ${pt([x + w, y + r])}`,
		`V ${fmt(y + h - r)}`,
		`Q ${pt([x + w, y + h])} ${pt([x + w - r, y + h])}`,
		`H ${fmt(x + r)}`,
		`Q ${pt([x, y + h])} ${pt([x, y + h - r])}`,
		`V ${fmt(y + r)}`,
		`Q ${pt([x, y])} ${pt([x + r, y])}`,
		'Z',
	].join(' ');
}

export function diamondPath(box: Box): string {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	return `M ${pt([cx, box.y])} L ${pt([box.x + box.width, cy])} L ${pt([cx, box.y + box.height])} L ${pt([box.x, cy])} Z`;
}

/** Cung tròn (độ, 0 = 12 giờ, theo chiều kim đồng hồ) — lát bánh/donut. */
export function arcPath(center: Point, radius: number, fromDeg: number, toDeg: number): string {
	const at = (deg: number): Point => {
		const rad = ((deg - 90) * Math.PI) / 180;
		return [center[0] + radius * Math.cos(rad), center[1] + radius * Math.sin(rad)];
	};
	const sweep = toDeg - fromDeg;
	// Cung ≥ 360° là hai nửa: một lệnh A không vẽ được vòng tròn trọn.
	if (sweep >= 359.99) {
		return `M ${pt(at(fromDeg))} A ${fmt(radius)} ${fmt(radius)} 0 1 1 ${pt(at(fromDeg + 180))} A ${fmt(radius)} ${fmt(radius)} 0 1 1 ${pt(at(fromDeg + 359.99))}`;
	}
	return `M ${pt(at(fromDeg))} A ${fmt(radius)} ${fmt(radius)} 0 ${sweep > 180 ? 1 : 0} 1 ${pt(at(toDeg))}`;
}

// ------------------------------------------------------------------ node

/** Keyframe `trimEnd` 0 → 1: vẽ nét trong `duration` giây, bắt đầu ở `delay`. */
export function drawOn(delay: number, duration: number): Node {
	return {
		property: 'trimEnd',
		keyframes: [
			{ time: round(delay), value: 0, easing: 'easeInOut' },
			{ time: round(delay + duration), value: 1 },
		],
	};
}

export function strokePath(d: string, color: string, width: number, options: { drawAt?: number; drawFor?: number; shadow?: boolean; dash?: number[] } = {}): Node {
	return {
		kind: 'path',
		d,
		strokes: [{ color, width: round(width), cap: 'round', join: 'round' }],
		...(options.dash ? { dash: options.dash } : {}),
		...(options.shadow === false ? {} : { shadows: [{ ...SHADOW }] }),
		...(options.drawAt !== undefined ? { tracks: [drawOn(options.drawAt, options.drawFor ?? 0.5)] } : {}),
	};
}

/**
 * Animation "hiện ra" lúc `delay`. `grow` của DS chỉ phóng 0.5 → 1 và KHÔNG
 * đổi độ mờ — một mình nó thì phần tử đứng sẵn ở nửa cỡ trong lúc chờ tới
 * lượt; nên luôn đi kèm `fade` cùng nhịp.
 */
export const appear = (type: 'grow' | 'fade' | 'slideUp', delay: number, duration = 0.35): Node[] => {
	const one = (kind: string): Node => ({ type: kind, duration: round(duration), ...(delay > 0 ? { delay: round(delay) } : {}) });
	return type === 'grow' ? [one('fade'), one('grow')] : [one(type)];
};

/**
 * Path dựng bằng toạ độ scene: đặt hộp của node = hộp bao của `d` (và
 * `viewBox` trùng hộp đó, nên nét không bị scale). Thiếu hộp, node nhận hộp
 * mặc định 100×100 ở gốc và mọi animation phóng/xoay quanh tâm sai chỗ.
 */
export function placePath(node: Node): Node {
	if (node.kind !== 'path' || node.width !== undefined || typeof node.d !== 'string') return node;
	const bounds = pathBounds(parsePath(node.d));
	const width = Math.max(round(bounds.width), 1);
	const height = Math.max(round(bounds.height), 1);
	const x = round(bounds.x);
	const y = round(bounds.y);
	// Mask nằm trong toạ độ CỦA node: dời gốc về góc hộp thì mask viết theo
	// pixel scene (mask khung đồ thị) phải dời theo, không thì lệch cả một hộp.
	const masks = Array.isArray(node.masks)
		? (node.masks as Node[]).map((mask) => ({ ...mask, x: round(((mask.x as number) ?? 0) - x), y: round(((mask.y as number) ?? 0) - y) }))
		: undefined;
	return { ...node, x, y, width, height, viewBox: [x, y, width, height], ...(masks ? { masks } : {}) };
}

/**
 * Group ở gốc scene (toạ độ con = pixel của scene), sống từ `start` tới
 * `end`, mờ đi ở cuối. Mark `visual` giữ op + input để `update_visual` sinh lại.
 */
export function visualGroup(name: string, children: Node[], timing: { start: number; end: number }, _frame: { width: number; height: number }, mark: { op: string; input: unknown }): Node {
	const duration = round(timing.end - timing.start);
	return {
		kind: 'group',
		name,
		x: 0,
		y: 0,
		start: round(timing.start),
		end: round(timing.end),
		animations: [{ type: 'fade', phase: 'out', duration: Math.min(0.3, duration / 4) }],
		marks: { visual: mark },
		children: children.map((child) => ({ start: 0, end: duration, ...placePath(child) })),
	};
}
