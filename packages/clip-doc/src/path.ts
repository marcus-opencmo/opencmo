/**
 * Đường SVG (`d`) của node `path`: đọc thành đoạn tuyệt đối, đo độ dài.
 *
 * Tự viết thay vì `Path2D(d)`: renderer cần độ dài đường (vẽ nét = dash theo
 * độ dài), cần scale từ `viewBox` vào hộp mà không làm méo nét, và cần cùng một
 * bộ điểm cho morph — `Path2D` không cho đọc lại gì cả. Thuần, chạy ở schema
 * (validate), trình duyệt và Node như nhau.
 *
 * Mọi lệnh quy về năm loại: M, L, C, Q, Z. H/V → L, S/T → C/Q với điểm điều
 * khiển phản chiếu, A (cung ellipse) → một dãy cubic (mỗi ≤ 90°).
 */

export type PathSegment =
	| { type: 'M'; x: number; y: number }
	| { type: 'L'; x: number; y: number }
	| { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
	| { type: 'Q'; x1: number; y1: number; x: number; y: number }
	| { type: 'Z' };

/** Số tham số của từng lệnh. */
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Trần để một `d` khổng lồ không treo validate/render. */
export const MAX_PATH_SEGMENTS = 5000;

export class PathSyntaxError extends Error {}

/** Đọc `d` tuần tự: số thường, hoặc cờ một chữ số (tham số 4–5 của lệnh A). */
class Scanner {
	private i = 0;
	private readonly d: string;
	constructor(d: string) {
		this.d = d;
	}
	private skip(): void {
		while (this.i < this.d.length && /[\s,]/.test(this.d[this.i]!)) this.i++;
	}
	done(): boolean {
		this.skip();
		return this.i >= this.d.length;
	}
	/** Chữ lệnh ở vị trí hiện tại (không tiến), hoặc null nếu là số. */
	command(): string | null {
		this.skip();
		const char = this.d[this.i];
		if (char === undefined) return null;
		if (/[MmLlHhVvCcSsQqTtAaZz]/.test(char)) return char;
		if (/[-+.\d]/.test(char)) return null;
		throw new PathSyntaxError(`Unexpected "${char}" in path data.`);
	}
	advance(): void {
		this.i++;
	}
	number(flag = false): number {
		this.skip();
		if (flag) {
			const char = this.d[this.i];
			if (char !== '0' && char !== '1') throw new PathSyntaxError('Arc flags must be 0 or 1.');
			this.i++;
			return Number(char);
		}
		const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.d.slice(this.i, this.i + 64));
		if (!match) throw new PathSyntaxError('Path data is missing a number.');
		this.i += match[0].length;
		return Number(match[0]);
	}
}

export function parsePath(d: string): PathSegment[] {
	const scan = new Scanner(d);
	const out: PathSegment[] = [];
	let command = '';
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	// Điểm điều khiển cuối cho S/T; null khi lệnh trước không phải C/S hay Q/T.
	let lastCubic: [number, number] | null = null;
	let lastQuad: [number, number] | null = null;

	while (!scan.done()) {
		const token = scan.command();
		if (token) {
			command = token;
			scan.advance();
		} else if (!command) {
			throw new PathSyntaxError('Path data must start with a move (M).');
		}
		let upper = command.toUpperCase();
		let relative = command !== upper;
		if (out.length === 0 && upper !== 'M') throw new PathSyntaxError('Path data must start with a move (M).');
		if (out.length > MAX_PATH_SEGMENTS) throw new PathSyntaxError(`Path data has more than ${MAX_PATH_SEGMENTS} segments.`);

		if (upper === 'Z') {
			out.push({ type: 'Z' });
			x = startX;
			y = startY;
			lastCubic = lastQuad = null;
			// Z không có tham số: lệnh sau phải là chữ mới.
			if (!scan.done() && scan.command() === null) throw new PathSyntaxError('Z takes no numbers.');
			continue;
		}
		if (scan.done() || scan.command() !== null) throw new PathSyntaxError(`${command} is missing its numbers.`);

		// Một chữ lệnh có thể theo sau bởi nhiều bộ tham số (lặp ngầm).
		do {
			// M đổi `command` thành L cho các cặp số lặp ngầm sau nó.
			upper = command.toUpperCase();
			relative = command !== upper;
			const arity = ARITY[upper]!;
			const ox = relative ? x : 0;
			const oy = relative ? y : 0;
			const args: number[] = [];
			for (let k = 0; k < arity; k++) args.push(scan.number(upper === 'A' && (k === 3 || k === 4)));
			switch (upper) {
				case 'M': {
					x = ox + args[0]!;
					y = oy + args[1]!;
					startX = x;
					startY = y;
					out.push({ type: 'M', x, y });
					// Cặp số tiếp theo sau M là L ngầm.
					command = relative ? 'l' : 'L';
					lastCubic = lastQuad = null;
					break;
				}
				case 'L':
				case 'H':
				case 'V': {
					if (upper === 'L') {
						x = ox + args[0]!;
						y = oy + args[1]!;
					} else if (upper === 'H') x = (relative ? x : 0) + args[0]!;
					else y = (relative ? y : 0) + args[0]!;
					out.push({ type: 'L', x, y });
					lastCubic = lastQuad = null;
					break;
				}
				case 'C':
				case 'S': {
					let x1: number;
					let y1: number;
					let rest = args;
					if (upper === 'C') {
						x1 = ox + args[0]!;
						y1 = oy + args[1]!;
						rest = args.slice(2);
					} else {
						x1 = lastCubic ? 2 * x - lastCubic[0] : x;
						y1 = lastCubic ? 2 * y - lastCubic[1] : y;
					}
					const x2 = ox + rest[0]!;
					const y2 = oy + rest[1]!;
					x = ox + rest[2]!;
					y = oy + rest[3]!;
					out.push({ type: 'C', x1, y1, x2, y2, x, y });
					lastCubic = [x2, y2];
					lastQuad = null;
					break;
				}
				case 'Q':
				case 'T': {
					let x1: number;
					let y1: number;
					if (upper === 'Q') {
						x1 = ox + args[0]!;
						y1 = oy + args[1]!;
						x = ox + args[2]!;
						y = oy + args[3]!;
					} else {
						x1 = lastQuad ? 2 * x - lastQuad[0] : x;
						y1 = lastQuad ? 2 * y - lastQuad[1] : y;
						x = ox + args[0]!;
						y = oy + args[1]!;
					}
					out.push({ type: 'Q', x1, y1, x, y });
					lastQuad = [x1, y1];
					lastCubic = null;
					break;
				}
				case 'A': {
					const [rx, ry, angle, large, sweep] = args as [number, number, number, number, number];
					const ex = ox + args[5]!;
					const ey = oy + args[6]!;
					out.push(...arcToCubics(x, y, rx, ry, angle, large !== 0, sweep !== 0, ex, ey));
					x = ex;
					y = ey;
					lastCubic = lastQuad = null;
					break;
				}
			}
		} while (!scan.done() && scan.command() === null);
	}
	if (!out.length) throw new PathSyntaxError('Path data is empty.');
	return out;
}

/**
 * Cung ellipse SVG → cubic (chuẩn SVG 1.1 phụ lục F.6: điểm đầu/cuối → tâm).
 * Bán kính quá nhỏ thì phóng lên cho vừa; bán kính 0 là đường thẳng.
 */
function arcToCubics(
	x0: number,
	y0: number,
	rxIn: number,
	ryIn: number,
	angleDeg: number,
	large: boolean,
	sweep: boolean,
	x: number,
	y: number,
): PathSegment[] {
	if (x0 === x && y0 === y) return [];
	let rx = Math.abs(rxIn);
	let ry = Math.abs(ryIn);
	if (rx === 0 || ry === 0) return [{ type: 'L', x, y }];
	const phi = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x0 - x) / 2;
	const dy = (y0 - y) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	let coef = Math.sqrt(Math.max(0, num / den));
	if (large === sweep) coef = -coef;
	const cxp = (coef * rx * y1p) / ry;
	const cyp = (-coef * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
	const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => {
		const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return a;
	};
	const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!sweep && delta > 0) delta -= 2 * Math.PI;
	else if (sweep && delta < 0) delta += 2 * Math.PI;

	const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
	const step = delta / parts;
	const k = (4 / 3) * Math.tan(step / 4);
	const point = (t: number): [number, number] => {
		const px = rx * Math.cos(t);
		const py = ry * Math.sin(t);
		return [cx + cos * px - sin * py, cy + sin * px + cos * py];
	};
	const derivative = (t: number): [number, number] => {
		const px = -rx * Math.sin(t);
		const py = ry * Math.cos(t);
		return [cos * px - sin * py, sin * px + cos * py];
	};
	const out: PathSegment[] = [];
	let t = theta1;
	for (let n = 0; n < parts; n++) {
		const t2 = t + step;
		const [ax, ay] = point(t);
		const [bx, by] = n === parts - 1 ? [x, y] : point(t2);
		const [dax, day] = derivative(t);
		const [dbx, dby] = derivative(t2);
		out.push({ type: 'C', x1: ax + k * dax, y1: ay + k * day, x2: bx - k * dbx, y2: by - k * dby, x: bx, y: by });
		t = t2;
	}
	return out;
}

/** Đường đã scale: mỗi toạ độ qua `(v - origin) · scale`. */
export function transformPath(segments: PathSegment[], sx: number, sy: number, ox = 0, oy = 0): PathSegment[] {
	const X = (v: number) => (v - ox) * sx;
	const Y = (v: number) => (v - oy) * sy;
	return segments.map((s) => {
		switch (s.type) {
			case 'M':
			case 'L':
				return { type: s.type, x: X(s.x), y: Y(s.y) };
			case 'C':
				return { type: 'C', x1: X(s.x1), y1: Y(s.y1), x2: X(s.x2), y2: Y(s.y2), x: X(s.x), y: Y(s.y) };
			case 'Q':
				return { type: 'Q', x1: X(s.x1), y1: Y(s.y1), x: X(s.x), y: Y(s.y) };
			default:
				return s;
		}
	});
}

/** Số đoạn thẳng xấp xỉ một cong — đủ mịn để độ dài sai < 0.1% trên cong thường gặp. */
const FLATTEN = 32;

/**
 * Tổng độ dài của đường (đoạn thẳng + cong làm phẳng), tính cả nét đóng Z.
 * Canvas vẽ dash theo đúng độ dài hình học này.
 */
export function pathLength(segments: PathSegment[]): number {
	let length = 0;
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	const add = (nx: number, ny: number) => {
		length += Math.hypot(nx - x, ny - y);
		x = nx;
		y = ny;
	};
	for (const s of segments) {
		switch (s.type) {
			case 'M':
				x = startX = s.x;
				y = startY = s.y;
				break;
			case 'L':
				add(s.x, s.y);
				break;
			case 'C': {
				const [x0, y0] = [x, y];
				for (let k = 1; k <= FLATTEN; k++) {
					const t = k / FLATTEN;
					const u = 1 - t;
					add(
						u * u * u * x0 + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
						u * u * u * y0 + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
					);
				}
				break;
			}
			case 'Q': {
				const [x0, y0] = [x, y];
				for (let k = 1; k <= FLATTEN; k++) {
					const t = k / FLATTEN;
					const u = 1 - t;
					add(u * u * x0 + 2 * u * t * s.x1 + t * t * s.x, u * u * y0 + 2 * u * t * s.y1 + t * t * s.y);
				}
				break;
			}
			case 'Z':
				add(startX, startY);
				break;
		}
	}
	return length;
}

/** Hộp bao của các điểm (kể cả điểm điều khiển — đủ cho viewBox mặc định). */
export function pathBounds(segments: PathSegment[]): { x: number; y: number; width: number; height: number } {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const s of segments) {
		if (s.type === 'Z') continue;
		xs.push(s.x);
		ys.push(s.y);
		if (s.type === 'C') xs.push(s.x1, s.x2), ys.push(s.y1, s.y2);
		if (s.type === 'Q') xs.push(s.x1), ys.push(s.y1);
	}
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// ------------------------------------------------------------------ trim

type Drawn = { from: [number, number]; seg: Exclude<PathSegment, { type: 'M' } | { type: 'Z' }>; subpath: number; table: number[] };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function pointAt(from: [number, number], seg: Drawn['seg'], t: number): [number, number] {
	const [x0, y0] = from;
	const u = 1 - t;
	if (seg.type === 'L') return [lerp(x0, seg.x, t), lerp(y0, seg.y, t)];
	if (seg.type === 'Q') return [u * u * x0 + 2 * u * t * seg.x1 + t * t * seg.x, u * u * y0 + 2 * u * t * seg.y1 + t * t * seg.y];
	return [
		u * u * u * x0 + 3 * u * u * t * seg.x1 + 3 * u * t * t * seg.x2 + t * t * t * seg.x,
		u * u * u * y0 + 3 * u * u * t * seg.y1 + 3 * u * t * t * seg.y2 + t * t * t * seg.y,
	];
}

/** Đoạn vẽ được (L/C/Q; Z thành L về đầu đường con), kèm bảng độ dài cộng dồn theo t. */
function drawnSegments(segments: PathSegment[]): Drawn[] {
	const out: Drawn[] = [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	let subpath = -1;
	for (const s of segments) {
		if (s.type === 'M') {
			x = startX = s.x;
			y = startY = s.y;
			subpath++;
			continue;
		}
		const seg: Drawn['seg'] = s.type === 'Z' ? { type: 'L', x: startX, y: startY } : s;
		const from: [number, number] = [x, y];
		const steps = seg.type === 'L' ? 1 : FLATTEN;
		const table = [0];
		let previous = from;
		for (let k = 1; k <= steps; k++) {
			const point = pointAt(from, seg, k / steps);
			table.push(table[k - 1]! + Math.hypot(point[0] - previous[0], point[1] - previous[1]));
			previous = point;
		}
		out.push({ from, seg, subpath, table });
		x = seg.x;
		y = seg.y;
	}
	return out;
}

/** t của đoạn ứng với độ dài `at` tính từ đầu đoạn (nội suy trên bảng). */
function tAt(table: number[], at: number): number {
	const total = table[table.length - 1]!;
	if (total <= 0) return 0;
	const steps = table.length - 1;
	for (let k = 1; k <= steps; k++) {
		if (table[k]! >= at) {
			const span = table[k]! - table[k - 1]!;
			const local = span > 0 ? (at - table[k - 1]!) / span : 0;
			return (k - 1 + local) / steps;
		}
	}
	return 1;
}

/** Phần [t0, t1] của một đoạn, cùng loại đoạn (de Casteljau). */
function piece(from: [number, number], seg: Drawn['seg'], t0: number, t1: number): { start: [number, number]; seg: Drawn['seg'] } {
	const start = pointAt(from, seg, t0);
	const end = pointAt(from, seg, t1);
	if (seg.type === 'L') return { start, seg: { type: 'L', x: end[0], y: end[1] } };
	const d = t1 - t0;
	if (seg.type === 'Q') {
		// Điểm điều khiển của đoạn con: P(t0) + (t1−t0)/2 · P'(t0).
		const [x0, y0] = from;
		const dx = 2 * (1 - t0) * (seg.x1 - x0) + 2 * t0 * (seg.x - seg.x1);
		const dy = 2 * (1 - t0) * (seg.y1 - y0) + 2 * t0 * (seg.y - seg.y1);
		return { start, seg: { type: 'Q', x1: start[0] + (d / 2) * dx, y1: start[1] + (d / 2) * dy, x: end[0], y: end[1] } };
	}
	const [x0, y0] = from;
	const derivative = (t: number): [number, number] => {
		const u = 1 - t;
		return [
			3 * u * u * (seg.x1 - x0) + 6 * u * t * (seg.x2 - seg.x1) + 3 * t * t * (seg.x - seg.x2),
			3 * u * u * (seg.y1 - y0) + 6 * u * t * (seg.y2 - seg.y1) + 3 * t * t * (seg.y - seg.y2),
		];
	};
	const [ax, ay] = derivative(t0);
	const [bx, by] = derivative(t1);
	return {
		start,
		seg: { type: 'C', x1: start[0] + (d / 3) * ax, y1: start[1] + (d / 3) * ay, x2: end[0] - (d / 3) * bx, y2: end[1] - (d / 3) * by, x: end[0], y: end[1] },
	};
}

/**
 * Phần đường từ `start` tới `end` (0–1 theo độ dài), cắt hình học.
 *
 * Không làm bằng dash: canvas đặt lại mẫu dash ở MỖI đường con, nên mũi tên
 * (thân + đầu là hai đường con) hiện cả đầu mũi tên ngay khi mới vẽ vài phần
 * trăm thân. Cắt hình học vẽ các đường con lần lượt theo thứ tự trong `d` —
 * đầu mũi tên hiện sau cùng, như tay vẽ.
 */
export function trimPath(segments: PathSegment[], start: number, end: number): PathSegment[] {
	const drawn = drawnSegments(segments);
	const total = drawn.reduce((sum, item) => sum + item.table[item.table.length - 1]!, 0);
	const a = Math.max(0, Math.min(1, start)) * total;
	const b = Math.max(0, Math.min(1, end)) * total;
	const out: PathSegment[] = [];
	if (b <= a || total <= 0) return out;
	let cursor = 0;
	let pen: { x: number; y: number; subpath: number } | null = null;
	for (const item of drawn) {
		const length = item.table[item.table.length - 1]!;
		const from = Math.max(a, cursor);
		const to = Math.min(b, cursor + length);
		cursor += length;
		if (to <= from) continue;
		const t0 = tAt(item.table, from - (cursor - length));
		const t1 = tAt(item.table, to - (cursor - length));
		const part = piece(item.from, item.seg, t0, t1);
		const joined = pen && pen.subpath === item.subpath && Math.abs(pen.x - part.start[0]) < 1e-6 && Math.abs(pen.y - part.start[1]) < 1e-6;
		if (!joined) out.push({ type: 'M', x: part.start[0], y: part.start[1] });
		out.push(part.seg);
		pen = { x: part.seg.x, y: part.seg.y, subpath: item.subpath };
	}
	return out;
}

// ------------------------------------------------------------------ morph

type Cubic = [number, number, number, number, number, number];
type Subpath = { start: [number, number]; cubics: Cubic[]; closed: boolean };

/** Mọi đoạn thành cubic, gom theo đường con. Z thêm cubic thẳng về đầu nếu cần. */
function toSubpaths(segments: PathSegment[]): Subpath[] {
	const out: Subpath[] = [];
	let current: Subpath | null = null;
	let x = 0;
	let y = 0;
	const line = (x0: number, y0: number, x1: number, y1: number): Cubic => [
		x0 + (x1 - x0) / 3,
		y0 + (y1 - y0) / 3,
		x0 + (2 * (x1 - x0)) / 3,
		y0 + (2 * (y1 - y0)) / 3,
		x1,
		y1,
	];
	for (const s of segments) {
		if (s.type === 'M') {
			current = { start: [s.x, s.y], cubics: [], closed: false };
			out.push(current);
			x = s.x;
			y = s.y;
			continue;
		}
		if (!current) continue;
		if (s.type === 'L') current.cubics.push(line(x, y, s.x, s.y));
		else if (s.type === 'Q')
			current.cubics.push([x + (2 / 3) * (s.x1 - x), y + (2 / 3) * (s.y1 - y), s.x + (2 / 3) * (s.x1 - s.x), s.y + (2 / 3) * (s.y1 - s.y), s.x, s.y]);
		else if (s.type === 'C') current.cubics.push([s.x1, s.y1, s.x2, s.y2, s.x, s.y]);
		else {
			const [sx, sy] = current.start;
			if (Math.hypot(x - sx, y - sy) > 1e-9) current.cubics.push(line(x, y, sx, sy));
			current.closed = true;
			x = sx;
			y = sy;
			continue;
		}
		x = s.x;
		y = s.y;
	}
	// Đường con chỉ có M: cho nó một cubic điểm để còn cái mà nội suy.
	for (const sub of out) if (!sub.cubics.length) sub.cubics.push([...sub.start, ...sub.start, ...sub.start] as Cubic);
	return out;
}

/** Chia cubic dài nhất (theo dây cung) làm đôi cho tới khi đủ `count` cubic. */
function subdivide(sub: Subpath, count: number): Subpath {
	const cubics = [...sub.cubics];
	const startOf = (index: number): [number, number] => (index === 0 ? sub.start : [cubics[index - 1]![4], cubics[index - 1]![5]]);
	while (cubics.length < count) {
		let longest = 0;
		let best = -1;
		cubics.forEach((c, index) => {
			const [sx, sy] = startOf(index);
			const chord = Math.hypot(c[4] - sx, c[5] - sy) + 1e-9 * index;
			if (chord > best) {
				best = chord;
				longest = index;
			}
		});
		const [x0, y0] = startOf(longest);
		const [x1, y1, x2, y2, x3, y3] = cubics[longest]!;
		const m = (a: number, b: number) => (a + b) / 2;
		const ax = m(x0, x1), ay = m(y0, y1), bx = m(x1, x2), by = m(y1, y2), cx = m(x2, x3), cy = m(y2, y3);
		const dx = m(ax, bx), dy = m(ay, by), ex = m(bx, cx), ey = m(by, cy);
		const fx = m(dx, ex), fy = m(dy, ey);
		cubics.splice(longest, 1, [ax, ay, dx, dy, fx, fy], [ex, ey, cx, cy, x3, y3]);
	}
	return { ...sub, cubics };
}

/**
 * Hai đường về cùng hình dạng dữ liệu để nội suy từng điểm: cùng số đường con
 * (đường thiếu thêm đường con co về một điểm — "mọc ra" từ đó, như Transform
 * của manim), rồi cùng số cubic trong từng cặp.
 */
export function alignPaths(a: PathSegment[], b: PathSegment[]): [Subpath[], Subpath[]] {
	const left = toSubpaths(a);
	const right = toSubpaths(b);
	const pad = (list: Subpath[], count: number) => {
		const last = list[list.length - 1];
		const [px, py] = last ? [last.cubics[last.cubics.length - 1]![4], last.cubics[last.cubics.length - 1]![5]] : [0, 0];
		while (list.length < count) list.push({ start: [px, py], cubics: [[px, py, px, py, px, py]], closed: false });
	};
	const count = Math.max(left.length, right.length);
	pad(left, count);
	pad(right, count);
	for (let i = 0; i < count; i++) {
		const n = Math.max(left[i]!.cubics.length, right[i]!.cubics.length);
		left[i] = subdivide(left[i]!, n);
		right[i] = subdivide(right[i]!, n);
	}
	return [left, right];
}

/** Đường ở giữa `a` (t=0) và `b` (t=1) đã căn bằng `alignPaths`. */
export function morphAligned([left, right]: [Subpath[], Subpath[]], t: number): PathSegment[] {
	const out: PathSegment[] = [];
	const mix = (p: number, q: number) => p + (q - p) * t;
	left.forEach((sub, i) => {
		const other = right[i]!;
		out.push({ type: 'M', x: mix(sub.start[0], other.start[0]), y: mix(sub.start[1], other.start[1]) });
		sub.cubics.forEach((c, k) => {
			const d = other.cubics[k]!;
			out.push({ type: 'C', x1: mix(c[0], d[0]), y1: mix(c[1], d[1]), x2: mix(c[2], d[2]), y2: mix(c[3], d[3]), x: mix(c[4], d[4]), y: mix(c[5], d[5]) });
		});
		if (t < 0.5 ? sub.closed : other.closed) out.push({ type: 'Z' });
	});
	return out;
}

export function morphPath(a: PathSegment[], b: PathSegment[], t: number): PathSegment[] {
	return morphAligned(alignPaths(a, b), t);
}
