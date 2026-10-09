/**
 * `add_chart`: con số người nói nhắc tới thành hình — cột mọc lên, đường vẽ
 * nét, bánh quay dần, số lớn. Không trục chia vạch kiểu báo cáo: video ngắn cần
 * đọc được trong 2 giây, nên chỉ nhãn + giá trị trên từng phần.
 */

import { z } from 'zod';

import { appear, arcPath, colorAt, drawOn, fitSize, pt, r2, strokePath, textNode, THEME, tint, type Box, type Node, type Point } from './common';
import { regionSchema } from './shape';

export const CHART_TYPES = ['bar', 'line', 'pie', 'donut', 'stat'] as const;

export const chartInput = z
	.object({
		type: z.enum(CHART_TYPES),
		data: z
			.array(z.object({ label: z.string().trim().max(24), value: z.number().finite() }))
			.min(1)
			.max(12),
		title: z.string().trim().min(1).max(60).optional(),
		/** Hậu tố của giá trị: "%", "k", " users"… */
		unit: z.string().max(12).optional(),
		region: regionSchema.optional(),
		animate: z.boolean().optional(),
		colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(12).optional(),
	})
	.refine((input) => input.type !== 'pie' && input.type !== 'donut' ? true : input.data.every((item) => item.value >= 0), {
		message: 'Pie and donut charts need values of zero or more.',
	})
	.refine((input) => input.type !== 'line' || input.data.length >= 2, { message: 'A line chart needs at least two points.' });

export type ChartInput = z.infer<typeof chartInput>;

/** 1234567 → "1.2M", 0.5 → "0.5": đủ ngắn để đọc trên điện thoại. */
export function formatValue(value: number, unit = ''): string {
	const abs = Math.abs(value);
	const short =
		abs >= 1e9 ? `${r1(value / 1e9)}B` : abs >= 1e6 ? `${r1(value / 1e6)}M` : abs >= 1e4 ? `${r1(value / 1e3)}k` : Number.isInteger(value) ? String(value) : String(r1(value));
	return `${short}${unit}`;
}
const r1 = (value: number) => Math.round(value * 10) / 10;

export function buildChart(input: ChartInput, frame: { width: number; height: number }, area: Box, duration: number): Node[] {
	const unit = Math.min(frame.width, frame.height) / 1080;
	const theme = { ...THEME, ...(input.colors?.length ? { palette: input.colors } : {}) };
	const animate = input.animate !== false;
	const grow = Math.min(0.9, duration * 0.3);
	const out: Node[] = [];
	let body = area;
	if (input.title) {
		const h = Math.min(area.height * 0.16, 90 * unit);
		out.push({ ...textNode(input.title, { x: area.x, y: area.y, width: area.width, height: h }, { size: fitSize([input.title], area.width, h, 60 * unit) }), ...(animate ? { animations: appear('fade', 0) } : {}) });
		body = { x: area.x, y: area.y + h * 1.2, width: area.width, height: area.height - h * 1.2 };
	}
	const lead = input.title && animate ? 0.25 : 0;
	const labelHeight = Math.min(body.height * 0.14, 60 * unit);

	if (input.type === 'stat') {
		const item = input.data[0]!;
		const valueText = formatValue(item.value, input.unit);
		const big = { x: body.x, y: body.y, width: body.width, height: body.height * 0.7 };
		out.push({ ...textNode(valueText, big, { size: fitSize([valueText], big.width, big.height, 260 * unit), color: colorAt(theme, 0), weight: 900 }), ...(animate ? { animations: appear('grow', lead, 0.5) } : {}) });
		if (item.label) {
			const small = { x: body.x, y: body.y + body.height * 0.7, width: body.width, height: body.height * 0.3 };
			out.push({ ...textNode(item.label, small, { size: fitSize([item.label], small.width, small.height, 56 * unit), weight: 600 }), ...(animate ? { animations: appear('fade', lead + 0.3) } : {}) });
		}
		return out;
	}

	if (input.type === 'bar') {
		const n = input.data.length;
		const max = Math.max(...input.data.map((item) => item.value), 0);
		const min = Math.min(...input.data.map((item) => item.value), 0);
		const span = max - min || 1;
		const plot = { x: body.x, y: body.y + labelHeight, width: body.width, height: body.height - labelHeight * 2.1 };
		const baseline = plot.y + plot.height * (max / span);
		const slot = plot.width / n;
		const barWidth = slot * 0.64;
		// Một cỡ cho mọi nhãn, theo nhãn dài nhất (fitSize nhận các DÒNG của một nhãn).
		const longest = input.data.map((item) => item.label).reduce((a, b) => (b.length > a.length ? b : a), '');
		const labelSize = fitSize([longest || ' '], slot, labelHeight, 36 * unit, 14);
		input.data.forEach((item, i) => {
			const height = (Math.abs(item.value) / span) * plot.height;
			const x = plot.x + slot * i + (slot - barWidth) / 2;
			const y = item.value >= 0 ? baseline - height : baseline;
			const delay = lead + i * Math.min(0.15, (duration * 0.3) / n);
			const color = colorAt(theme, i);
			out.push({
				kind: 'rect',
				x: r2(x),
				y: r2(y),
				width: r2(barWidth),
				height: r2(height),
				fill: color,
				cornerRadius: r2(Math.min(12 * unit, barWidth / 4)),
				// Cột mọc từ đường gốc: height và y chạy cùng nhau (cột dương mọc lên).
				...(animate
					? {
							tracks: [
								{ property: 'height', keyframes: [{ time: r2(delay), value: 0, easing: 'easeOut' }, { time: r2(delay + grow), value: r2(height) }] },
								...(item.value >= 0 ? [{ property: 'y', keyframes: [{ time: r2(delay), value: r2(baseline), easing: 'easeOut' }, { time: r2(delay + grow), value: r2(y) }] }] : []),
							],
						}
					: {}),
			});
			const valueBox = { x: plot.x + slot * i, y: item.value >= 0 ? y - labelHeight : y + height, width: slot, height: labelHeight };
			out.push({ ...textNode(formatValue(item.value, input.unit), valueBox, { size: fitSize([formatValue(item.value, input.unit)], slot, labelHeight, 44 * unit, 14) }), ...(animate ? { animations: appear('fade', delay + grow * 0.8) } : {}) });
			if (item.label) {
				const labelBox = { x: plot.x + slot * i, y: plot.y + plot.height + labelHeight * 0.1, width: slot, height: labelHeight };
				out.push({ ...textNode(item.label, labelBox, { size: labelSize, weight: 600 }), ...(animate ? { animations: appear('fade', lead) } : {}) });
			}
		});
		out.push(strokePath(`M ${pt([plot.x, baseline])} L ${pt([plot.x + plot.width, baseline])}`, theme.line, 4 * unit, animate ? { drawAt: lead, drawFor: 0.4 } : {}));
		return out;
	}

	if (input.type === 'line') {
		const values = input.data.map((item) => item.value);
		const max = Math.max(...values);
		const min = Math.min(...values);
		const span = max - min || 1;
		const plot = { x: body.x + body.width * 0.04, y: body.y + labelHeight, width: body.width * 0.92, height: body.height - labelHeight * 2.2 };
		const points: Point[] = values.map((value, i) => [plot.x + (plot.width * i) / (values.length - 1), plot.y + plot.height * (1 - (value - min) / span)]);
		const d = points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${pt(point)}`).join(' ');
		const color = colorAt(theme, 0);
		const drawFor = Math.min(1.2, duration * 0.4);
		// Vùng tô mờ dưới đường hiện sau khi đường vẽ xong.
		const floor = plot.y + plot.height;
		out.push({
			kind: 'path',
			d: `${d} L ${pt([points[points.length - 1]![0], floor])} L ${pt([points[0]![0], floor])} Z`,
			...tint(color, 0.2),
			...(animate ? { animations: appear('fade', lead + drawFor, 0.4) } : {}),
		});
		out.push({ ...strokePath(d, color, 8 * unit), ...(animate ? { tracks: [drawOn(lead, drawFor)] } : {}) });
		points.forEach((point, i) => {
			const item = input.data[i]!;
			const at = lead + (drawFor * i) / (points.length - 1);
			const dot = 10 * unit;
			out.push({ kind: 'rect', x: r2(point[0] - dot), y: r2(point[1] - dot), width: r2(dot * 2), height: r2(dot * 2), cornerRadius: r2(dot), fill: '#FFFFFF', ...(animate ? { animations: appear('grow', at, 0.2) } : {}) });
			const text = formatValue(item.value, input.unit);
			const slot = plot.width / values.length;
			out.push({ ...textNode(text, { x: point[0] - slot / 2, y: point[1] - labelHeight * 1.3, width: slot, height: labelHeight }, { size: fitSize([text], slot, labelHeight, 38 * unit, 14) }), ...(animate ? { animations: appear('fade', at + 0.1) } : {}) });
			if (item.label) out.push({ ...textNode(item.label, { x: point[0] - slot / 2, y: floor + labelHeight * 0.2, width: slot, height: labelHeight }, { size: fitSize([item.label], slot, labelHeight, 32 * unit, 14), weight: 600 }), ...(animate ? { animations: appear('fade', lead) } : {}) });
		});
		return out;
	}

	// pie/donut: mỗi lát là một cung vẽ bằng nét dày; bánh = nét dày bằng bán kính.
	const total = input.data.reduce((sum, item) => sum + item.value, 0) || 1;
	const legendHeight = Math.min(body.height * 0.34, (input.data.length * 52 + 10) * unit);
	const size = Math.min(body.width, body.height - legendHeight);
	const center: Point = [body.x + body.width / 2, body.y + size / 2];
	const outer = size / 2;
	const thickness = input.type === 'donut' ? outer * 0.38 : outer;
	const radius = outer - thickness / 2;
	const spin = Math.min(1.2, duration * 0.4);
	let angle = 0;
	input.data.forEach((item, i) => {
		const sweep = (item.value / total) * 360;
		if (sweep <= 0) return;
		const delay = lead + (spin * angle) / 360;
		out.push({
			kind: 'path',
			d: arcPath(center, radius, angle, angle + sweep),
			strokes: [{ color: colorAt(theme, i), width: r2(thickness), cap: 'butt' }],
			...(animate ? { tracks: [{ property: 'trimEnd', keyframes: [{ time: r2(delay), value: 0 }, { time: r2(delay + (spin * sweep) / 360), value: 1 }] }] } : {}),
		});
		angle += sweep;
	});
	if (input.type === 'donut' && input.data[0]) {
		const share = `${Math.round((input.data[0].value / total) * 100)}%`;
		const inner = (radius - thickness / 2) * 1.4;
		out.push({ ...textNode(share, { x: center[0] - inner / 2, y: center[1] - inner / 3, width: inner, height: (inner * 2) / 3 }, { size: fitSize([share], inner, (inner * 2) / 3, 120 * unit), color: colorAt(theme, 0), weight: 900 }), ...(animate ? { animations: appear('grow', lead + spin) } : {}) });
	}
	// Chú giải: ô màu + "nhãn 42%".
	const rowHeight = Math.min(52 * unit, legendHeight / input.data.length);
	const legendTop = body.y + size + rowHeight * 0.4;
	input.data.forEach((item, i) => {
		const y = legendTop + i * rowHeight;
		const swatch = rowHeight * 0.55;
		const text = `${item.label} ${Math.round((item.value / total) * 100)}%`;
		const left = body.x + body.width * 0.18;
		out.push({ kind: 'rect', x: r2(left), y: r2(y + (rowHeight - swatch) / 2), width: r2(swatch), height: r2(swatch), cornerRadius: r2(swatch / 4), fill: colorAt(theme, i), ...(animate ? { animations: appear('fade', lead + spin) } : {}) });
		out.push({ ...textNode(text, { x: left + swatch * 1.6, y, width: body.width * 0.64, height: rowHeight }, { size: Math.round(rowHeight * 0.62), align: 'left', weight: 600 }), ...(animate ? { animations: appear('fade', lead + spin) } : {}) });
	});
	return out;
}
