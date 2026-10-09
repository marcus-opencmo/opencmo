/**
 * `check`: lint cấu trúc của một clip, cho agent (spec agent-editor §4) và
 * cho loop tự chạy sau mỗi bước có ghi.
 *
 * Hành vi lấy từ tool `check` của DS (đọc tài liệu, không đọc mã): tìm những
 * lỗi mà file vẫn "chạy" nhưng video hỏng — khoảng đen, node không bao giờ
 * hiện, độ dài 0, trong suốt, thiếu nguồn, ra ngoài khung, chữ đè phụ đề.
 *
 * Thuần: không DOM, không tải media. Hình học đọc từ `createRenderer().layout`
 * — đúng hộp mà preview và export vẽ — lấy mẫu mỗi 0.2 giây. Chữ chỉ có hộp
 * thật khi có `measurer` (canvas); thiếu nó thì không kiểm tràn chữ.
 */

import type { AssetInput, ClipDocument, ClipNode } from '@opencmo/clip-doc';
import { createRenderer, FPS, type LayoutBox, type Mat, type Measurer, type Transcript } from '@opencmo/clip-render';

import { MASTER_SRC } from './doc';
import { speakerBandAt } from './layout';
import { activeScene } from './ops/timeline';

export type CheckIssue = {
	severity: 'error' | 'warning';
	code:
		| 'no-visuals'
		| 'black-gap'
		| 'zero-duration'
		| 'never-visible'
		| 'transparent'
		| 'missing-source'
		| 'offscreen'
		| 'covers-speaker'
		| 'text-overflow'
		| 'caption-overlap'
		| 'subject-offscreen';
	node_id?: string;
	/** Giây trên timeline của scene. */
	start?: number;
	end?: number;
	message: string;
};

export type CheckReport = {
	ok: boolean;
	/** Độ dài scene, giây. */
	duration: number;
	issues: CheckIssue[];
	stats: { nodes: number; visuals: number; texts: number; captions: number; media: number };
};

export type CheckMedia = {
	duration(src: AssetInput): number | null;
	transcript?(src: string): Transcript | null;
	/** Nguồn có tồn tại không (thư viện/manifest). Thiếu hàm thì không kiểm `missing-source`. */
	exists?(src: string): boolean;
};

/** Nhịp lấy mẫu: 6 frame = 0.2 giây. */
const STEP = 6;
const seconds = (frames: number): number => Math.round((frames / FPS) * 100) / 100;

const VISUAL = new Set<ClipNode['kind']>(['video', 'image', 'rect', 'path', 'scene3d', 'lottie', 'text', 'captions']);
/** Thứ phủ được nền: thiếu chúng thì khung là màu nền scene (thường đen). */
const BACKDROP = new Set<ClipNode['kind']>(['video', 'image', 'rect', 'path']);

type Point = [number, number];
function corners(matrix: Mat, box: [number, number, number, number]): Point[] {
	const [ox, oy, w, h] = box;
	return [
		[ox, oy],
		[ox + w, oy],
		[ox + w, oy + h],
		[ox, oy + h],
	].map(([x, y]) => [matrix[0] * x! + matrix[2] * y! + matrix[4], matrix[1] * x! + matrix[3] * y! + matrix[5]] as Point);
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
function bounds(layout: LayoutBox): Rect {
	const points = corners(layout.matrix, layout.box);
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const overlap = (a: Rect, b: Rect): Rect => ({
	x0: Math.max(a.x0, b.x0),
	y0: Math.max(a.y0, b.y0),
	x1: Math.min(a.x1, b.x1),
	y1: Math.min(a.y1, b.y1),
});

const idOf = (node: ClipNode): string | undefined => (node as { id?: string }).id;
const label = (node: ClipNode): string => {
	const name = (node as { name?: string }).name;
	const text = node.kind === 'text' ? (node as { text?: string }).text : undefined;
	return name ?? (text ? `"${text.slice(0, 30)}"` : node.kind);
};

/** Nền phủ được khung khi có fill/paint đặc — rect/path trong suốt không phủ gì. */
function opaque(node: ClipNode): boolean {
	if (node.kind !== 'rect' && node.kind !== 'path') return true;
	const rect = node as { fill?: string; paints?: { type: string; hidden?: boolean }[] };
	return Boolean(rect.fill) || Boolean(rect.paints?.some((paint) => !paint.hidden));
}

/**
 * Tâm mặt (0–1 theo bề ngang nguồn) ở giây nguồn `at`, đọc từ mark `reframe`
 * mà bộ sinh ghi từ dữ liệu bám mặt. Nội suy tuyến tính như keyframe; chỗ đổi
 * cảnh đã là hai mốc cách nhau một frame nên không bị nội suy qua nền.
 */
function focusAt(mark: { focus?: unknown; track?: unknown }, at: number): number | null {
	const track = (Array.isArray(mark.track) ? mark.track : []).filter(
		(point): point is [number, number] => Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number',
	);
	if (track.length < 2) return typeof mark.focus === 'number' ? mark.focus : null;
	if (at <= track[0]![0]) return track[0]![1];
	for (let i = 1; i < track.length; i++) {
		const [t1, f1] = track[i]!;
		if (at > t1) continue;
		const [t0, f0] = track[i - 1]!;
		return t1 > t0 ? f0 + ((f1 - f0) * (at - t0)) / (t1 - t0) : f1;
	}
	return track[track.length - 1]![1];
}

export function checkDocument(document: ClipDocument, media: CheckMedia, options: { measurer?: Measurer } = {}): CheckReport {
	const scene = activeScene(document);
	const renderer = createRenderer(document, {
		image: () => null,
		video: () => null,
		duration: (src) => media.duration(src),
		transcript: (src) => media.transcript?.(src) ?? null,
	}, { scene: scene.id });
	const end = renderer.end;
	const issues: CheckIssue[] = [];
	const stats = { nodes: 0, visuals: 0, texts: 0, captions: 0, media: 0 };
	const frameRect: Rect = { x0: 0, y0: 0, x1: scene.width, y1: scene.height };
	const frameArea = area(frameRect);

	// ---- lỗi đọc thẳng từ cây: không cần lấy mẫu
	const visit = (node: ClipNode) => {
		stats.nodes++;
		if (VISUAL.has(node.kind)) stats.visuals++;
		if (node.kind === 'text') stats.texts++;
		if (node.kind === 'captions') stats.captions++;
		const record = node as ClipNode & { src?: AssetInput; opacity?: number; tracks?: { property: string }[]; start?: number; end?: number };
		if (node.kind === 'video' || node.kind === 'image' || node.kind === 'audio') {
			stats.media++;
			if (typeof record.src === 'string' && media.exists && !media.exists(record.src)) {
				issues.push({
					severity: 'error',
					code: 'missing-source',
					node_id: idOf(node),
					message: `${label(node)} points to "${record.src}", which is not in the library.`,
				});
			}
		}
		if (record.opacity === 0 && !record.tracks?.some((track) => track.property === 'opacity') && VISUAL.has(node.kind)) {
			issues.push({
				severity: 'warning',
				code: 'transparent',
				node_id: idOf(node),
				message: `${label(node)} has opacity 0 and no opacity keyframes, so it never shows.`,
			});
		}
		for (const child of (node as { children?: ClipNode[] }).children ?? []) visit(child);
	};
	(scene.children ?? []).forEach(visit);

	if (!(scene.children ?? []).some(function has(node: ClipNode): boolean {
		return VISUAL.has(node.kind) || ((node as { children?: ClipNode[] }).children ?? []).some(has);
	})) {
		issues.push({ severity: 'error', code: 'no-visuals', message: 'The scene has nothing to show.' });
	}

	// ---- thời gian: độ dài 0, nằm ngoài scene (lấy từ layout frame 0 — start/end là đã giải)
	const seen = new Map<ClipNode, { visibleSamples: number; inFrame: boolean; box: LayoutBox }>();
	for (const box of renderer.layout(0, options.measurer)) {
		const kind = box.node.kind;
		if (kind === 'scene' || kind === 'group' || kind === 'sequence') continue;
		if (box.end <= box.start) {
			issues.push({
				severity: 'error',
				code: 'zero-duration',
				node_id: idOf(box.node),
				message: `${label(box.node)} has no duration (end is not after start).`,
			});
		} else if (box.start >= end) {
			issues.push({
				severity: 'warning',
				code: 'never-visible',
				node_id: idOf(box.node),
				start: seconds(box.start),
				message: `${label(box.node)} starts at ${seconds(box.start)}s, after the clip ends (${seconds(end)}s).`,
			});
		}
	}

	// ---- khoảng đen, CHÍNH XÁC theo frame: hợp các khoảng [start, end) của
	// thứ phủ được nền (hình học đo ở giữa đời của nó). Lấy mẫu thì sót chỗ hở
	// đúng một frame giữa hai đoạn — chớp đen thật trong bản xuất.
	const covers: [number, number][] = [];
	for (const box of renderer.layout(0, options.measurer)) {
		// Phòng hờ: độ dài scene luôn bao mọi node, nên node bắt đầu từ `end` trở đi
		// hiện không thể có — nếu renderer đổi luật, nó sẽ đẻ khoảng ngược.
		if (!BACKDROP.has(box.node.kind) || !opaque(box.node) || box.end <= box.start || box.start >= end) continue;
		const mid = Math.min(end - 1, Math.floor((box.start + box.end) / 2));
		const at = renderer.layout(Math.max(0, mid), options.measurer).find((item) => item.node === box.node);
		if (!at || at.values.opacity <= 0 || area(overlap(bounds(at), frameRect)) < frameArea * 0.25) continue;
		covers.push([Math.max(0, box.start), Math.min(end, box.end)]);
	}
	covers.sort((a, b) => a[0] - b[0]);
	const gaps: [number, number][] = [];
	let cursor = 0;
	for (const [from, to] of covers) {
		if (from > cursor) gaps.push([cursor, from]);
		cursor = Math.max(cursor, to);
	}
	if (cursor < end) gaps.push([cursor, end]);

	// ---- lấy mẫu: ra ngoài khung, chữ tràn, chữ đè phụ đề, người nói ra khỏi khung
	// Người nói lọt khỏi khung là lỗi IM LẶNG nhất: khung vẫn phủ kín, không có
	// khoảng đen, chỉ là toàn nền. Lượt edit thật đầu tiên agent xoá keyframe
	// `x` của bám mặt và nhìn ảnh chụp không ra; ở đây đo bằng hình học.
	const reframe = (scene as { marks?: Record<string, unknown> }).marks?.reframe as { focus?: unknown; track?: unknown } | undefined;
	const lost: { start: number; end: number }[] = [];
	const overlaps = new Map<string, { a: ClipNode; b: ClipNode; start: number; end: number }>();
	const overflow = new Map<ClipNode, { start: number; end: number }>();
	// Visual đè lên dải người nói khi đang chia đôi khung (`layout.ts`).
	const onSpeaker = new Map<ClipNode, { start: number; end: number }>();
	for (let frame = 0; frame < end; frame += STEP) {
		const boxes = renderer.layout(frame, options.measurer).filter((box) => box.visible);
		const band = speakerBandAt(document, frame / FPS);
		const bandRect: Rect | null = band ? { x0: 0, y0: band.y * scene.height, x1: scene.width, y1: (band.y + band.height) * scene.height } : null;
		const texts: { node: ClipNode; rect: Rect }[] = [];
		const captions: { node: ClipNode; rect: Rect }[] = [];
		for (const box of boxes) {
			if (!VISUAL.has(box.node.kind) || box.values.opacity <= 0) continue;
			const rect = bounds(box);
			const inside = area(overlap(rect, frameRect));
			const entry = seen.get(box.node) ?? { visibleSamples: 0, inFrame: false, box };
			entry.visibleSamples++;
			if (inside > 0) entry.inFrame = true;
			seen.set(box.node, entry);
			if (box.node.kind === 'text' && area(rect) > 0) {
				texts.push({ node: box.node, rect });
				const spill = Math.max(frameRect.x0 - rect.x0, rect.x1 - frameRect.x1, frameRect.y0 - rect.y0, rect.y1 - frameRect.y1);
				if (options.measurer && spill > scene.width * 0.02) {
					const run = overflow.get(box.node);
					if (run) run.end = frame + STEP;
					else overflow.set(box.node, { start: frame, end: frame + STEP });
				}
			}
			if (box.node.kind === 'captions' && area(rect) > 0) captions.push({ node: box.node, rect });
			const role = (box.node as { marks?: { layout?: unknown } }).marks?.layout;
			const master = box.node.kind === 'video' && (box.node as { src?: unknown }).src === MASTER_SRC;
			if (bandRect && !master && !role && box.node.kind !== 'captions' && area(rect) > 0 && area(overlap(rect, bandRect)) > area(rect) * 0.3) {
				const run = onSpeaker.get(box.node);
				if (run) run.end = frame + STEP;
				else onSpeaker.set(box.node, { start: frame, end: frame + STEP });
			}
			if (reframe && box.node.kind === 'video' && (box.node as { src?: unknown }).src === MASTER_SRC) {
				const focus = focusAt(reframe, box.localFrame / FPS);
				// Hộp video mang đúng tỉ lệ nguồn (bộ sinh và reframe dựng nó như vậy),
				// nên tâm chuẩn hoá đổi thẳng ra toạ độ scene. Chừa 8% mỗi bên: tâm mặt
				// sát mép là mất nửa khuôn mặt.
				const x = focus === null ? null : rect.x0 + focus * (rect.x1 - rect.x0);
				if (x !== null && (x < scene.width * 0.08 || x > scene.width * 0.92)) {
					const run = lost[lost.length - 1];
					if (run && run.end === frame) run.end = frame + STEP;
					else lost.push({ start: frame, end: frame + STEP });
				}
			}
		}
		for (const caption of captions) {
			for (const text of texts) {
				if (area(overlap(caption.rect, text.rect)) <= 0) continue;
				const key = `${idOf(caption.node) ?? 'captions'}:${idOf(text.node) ?? label(text.node)}`;
				const run = overlaps.get(key);
				if (run) run.end = frame + STEP;
				else overlaps.set(key, { a: caption.node, b: text.node, start: frame, end: frame + STEP });
			}
		}
	}
	for (const [from, to] of gaps) {
		const frames = to - from;
		issues.push({
			severity: 'error',
			code: 'black-gap',
			start: seconds(from),
			end: seconds(to),
			message:
				frames <= 2
					? `A ${frames}-frame gap at ${seconds(from)}s: the export flashes the background between two clips.`
					: `Nothing covers the frame from ${seconds(from)}s to ${seconds(to)}s: viewers see an empty background.`,
		});
	}
	for (const run of lost) {
		const from = seconds(run.start);
		const to = seconds(Math.min(run.end, end));
		issues.push({
			severity: 'error',
			code: 'subject-offscreen',
			start: from,
			end: to,
			message: `The speaker is outside the frame from ${from}s to ${to}s: viewers see only the background. Follow the face-tracking data (scene mark "reframe") — do not remove the video's x keyframes.`,
		});
	}
	for (const [node, run] of onSpeaker) {
		issues.push({
			severity: 'warning',
			code: 'covers-speaker',
			node_id: idOf(node),
			start: seconds(run.start),
			end: seconds(Math.min(run.end, end)),
			message: `${label(node)} sits on the speaker's half of the split frame from ${seconds(run.start)}s to ${seconds(Math.min(run.end, end))}s. Move it into the visual panel.`,
		});
	}
	for (const [node, entry] of seen) {
		if (entry.inFrame) continue;
		issues.push({
			severity: 'warning',
			code: 'offscreen',
			node_id: idOf(node),
			message: `${label(node)} is always outside the frame.`,
		});
	}
	for (const [node, run] of overflow) {
		issues.push({
			severity: 'warning',
			code: 'text-overflow',
			node_id: idOf(node),
			start: seconds(run.start),
			end: seconds(Math.min(run.end, end)),
			message: `${label(node)} runs past the edge of the frame.`,
		});
	}
	for (const run of overlaps.values()) {
		issues.push({
			severity: 'warning',
			code: 'caption-overlap',
			node_id: idOf(run.b),
			start: seconds(run.start),
			end: seconds(Math.min(run.end, end)),
			message: `${label(run.b)} overlaps the captions from ${seconds(run.start)}s to ${seconds(Math.min(run.end, end))}s.`,
		});
	}

	return { ok: !issues.some((issue) => issue.severity === 'error'), duration: seconds(end), issues, stats };
}
