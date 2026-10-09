/**
 * Lưới của vật thể 3D (spec visuals V5), trong toạ độ của chính vật: mặt đa
 * giác + đường. Trục z hướng lên như manim. Thuần, không phụ thuộc canvas.
 */

import { parseExpr, parsePath, pathBounds, type Object3D, type PathSegment } from '@opencmo/clip-doc';

export type Vec3 = [number, number, number];

/** Một mặt phẳng: đa giác (hoặc nhiều vòng cho mặt có lỗ, tô evenodd). */
export type Face = {
	rings: Vec3[][];
	/** Mặt khép (khối): bỏ mặt quay lưng. Mặt hở (surface, plane): hai mặt đều vẽ. */
	solid: boolean;
	/** 0–1 theo độ cao trên surface, để tô chuyển màu. */
	shade?: number;
};

export type Line = { points: Vec3[]; arrow?: boolean };

export type Mesh = { faces: Face[]; lines: Line[]; dots: Vec3[] };

const TAU = Math.PI * 2;

export function cube(size: number): Mesh {
	const h = size / 2;
	const v = (x: number, y: number, z: number): Vec3 => [x * h, y * h, z * h];
	// Mỗi mặt theo chiều ngược kim đồng hồ khi nhìn từ ngoài: pháp tuyến hướng ra.
	const faces: Vec3[][] = [
		[v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
		[v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1), v(-1, -1, -1)],
		[v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
		[v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)],
		[v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
		[v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)],
	];
	return { faces: faces.map((ring) => ({ rings: [ring], solid: true })), lines: [], dots: [] };
}

/** Lưới tham số (u, v) → điểm; mỗi ô thành một tứ giác. */
function grid(uCount: number, vCount: number, at: (u: number, v: number) => Vec3, solid: boolean, shade?: (u: number, v: number) => number): Face[] {
	const faces: Face[] = [];
	for (let i = 0; i < uCount; i++) {
		for (let j = 0; j < vCount; j++) {
			const a = at(i / uCount, j / vCount);
			const b = at((i + 1) / uCount, j / vCount);
			const c = at((i + 1) / uCount, (j + 1) / vCount);
			const d = at(i / uCount, (j + 1) / vCount);
			faces.push({ rings: [[a, b, c, d]], solid, ...(shade ? { shade: shade((i + 0.5) / uCount, (j + 0.5) / vCount) } : {}) });
		}
	}
	return faces;
}

export function sphere(radius: number, resolution: number): Mesh {
	const rings = Math.max(4, Math.round(resolution / 2));
	const faces = grid(resolution, rings, (u, v) => {
		const theta = u * TAU;
		const phi = v * Math.PI;
		return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi)];
	}, true);
	return { faces, lines: [], dots: [] };
}

export function torus(major: number, tube: number, resolution: number): Mesh {
	const faces = grid(resolution, Math.max(6, Math.round(resolution / 2)), (u, v) => {
		const a = u * TAU;
		const b = v * TAU;
		const r = major + tube * Math.cos(b);
		return [r * Math.cos(a), r * Math.sin(a), tube * Math.sin(b)];
	}, true);
	return { faces, lines: [], dots: [] };
}

/** Trụ (topRadius = radius) hoặc nón (topRadius = 0), trục z, tâm ở gốc. */
export function cylinder(radius: number, topRadius: number, height: number, resolution: number): Mesh {
	const h = height / 2;
	const ring = (r: number, z: number, k: number): Vec3 => [r * Math.cos((k / resolution) * TAU), r * Math.sin((k / resolution) * TAU), z];
	const faces: Face[] = [];
	for (let k = 0; k < resolution; k++) {
		const side = [ring(radius, -h, k), ring(radius, -h, k + 1), ring(topRadius, h, k + 1), ring(topRadius, h, k)];
		faces.push({ rings: [topRadius > 0 ? side : side.slice(0, 3)], solid: true });
	}
	faces.push({ rings: [Array.from({ length: resolution }, (_, k) => ring(radius, -h, resolution - k))], solid: true });
	if (topRadius > 0) faces.push({ rings: [Array.from({ length: resolution }, (_, k) => ring(topRadius, h, k))], solid: true });
	return { faces, lines: [], dots: [] };
}

export function plane(size: number, resolution: number): Mesh {
	const h = size / 2;
	return { faces: grid(resolution, resolution, (u, v) => [-h + u * size, -h + v * size, 0], false), lines: [], dots: [] };
}

/** z = f(x, y, t) trên lưới; `shade` là độ cao chuẩn hoá để tô chuyển màu. */
export function surface(expr: string, xRange: [number, number], yRange: [number, number], resolution: number, t: number): Mesh {
	const f = parseExpr(expr, ['x', 'y', 't']);
	const n = resolution;
	const zs: number[][] = [];
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i <= n; i++) {
		zs.push([]);
		for (let j = 0; j <= n; j++) {
			const x = xRange[0] + ((xRange[1] - xRange[0]) * i) / n;
			const y = yRange[0] + ((yRange[1] - yRange[0]) * j) / n;
			const z = f({ x, y, t });
			const value = Number.isFinite(z) ? z : 0;
			zs[i]!.push(value);
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
	}
	const span = max - min || 1;
	const point = (u: number, v: number): Vec3 => {
		const i = Math.round(u * n);
		const j = Math.round(v * n);
		return [xRange[0] + (xRange[1] - xRange[0]) * (i / n), yRange[0] + (yRange[1] - yRange[0]) * (j / n), zs[i]![j]!];
	};
	const shade = (u: number, v: number) => {
		const i = Math.min(n, Math.round(u * n));
		const j = Math.min(n, Math.round(v * n));
		return (zs[i]![j]! - min) / span;
	};
	return { faces: grid(n, n, point, false, shade), lines: [], dots: [] };
}

export function axes(length: number): Mesh {
	return {
		faces: [],
		lines: [
			{ points: [[-length, 0, 0], [length, 0, 0]], arrow: true },
			{ points: [[0, -length, 0], [0, length, 0]], arrow: true },
			{ points: [[0, 0, -length * 0.6], [0, 0, length]], arrow: true },
		],
		dots: [],
	};
}

/** Làm phẳng đường SVG thành các vòng điểm (mỗi đường con một vòng). */
function rings2d(segments: PathSegment[]): [number, number][][] {
	const out: [number, number][][] = [];
	let current: [number, number][] = [];
	let x = 0;
	let y = 0;
	const STEPS = 10;
	for (const s of segments) {
		if (s.type === 'M') {
			if (current.length > 2) out.push(current);
			current = [[s.x, s.y]];
			x = s.x;
			y = s.y;
		} else if (s.type === 'L') {
			current.push([s.x, s.y]);
			x = s.x;
			y = s.y;
		} else if (s.type === 'C' || s.type === 'Q') {
			for (let k = 1; k <= STEPS; k++) {
				const t = k / STEPS;
				const u = 1 - t;
				current.push(
					s.type === 'C'
						? [u * u * u * x + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x, u * u * u * y + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y]
						: [u * u * x + 2 * u * t * s.x1 + t * t * s.x, u * u * y + 2 * u * t * s.y1 + t * t * s.y],
				);
			}
			x = s.x;
			y = s.y;
		}
	}
	if (current.length > 2) out.push(current);
	return out;
}

/**
 * Khối đùn từ đường SVG (logo, biểu tượng): mặt trước/sau là các vòng tô
 * evenodd (có lỗ vẫn đúng), mặt bên là dải tứ giác. Đường được canh vào bề
 * rộng `size`, tâm ở gốc, lật trục y (SVG y hướng xuống).
 */
export function extrude(d: string, size: number, depth: number): Mesh {
	const segments = parsePath(d);
	const bounds = pathBounds(segments);
	const scale = size / Math.max(bounds.width, bounds.height, 1e-9);
	const cx = bounds.x + bounds.width / 2;
	const cy = bounds.y + bounds.height / 2;
	const flat = rings2d(segments).map((ring) => ring.map(([px, py]) => [(px - cx) * scale, -(py - cy) * scale] as [number, number]));
	const h = depth / 2;
	const faces: Face[] = [
		{ rings: flat.map((ring) => ring.map(([px, py]) => [px, py, h] as Vec3)), solid: false },
		{ rings: flat.map((ring) => ring.map(([px, py]) => [px, py, -h] as Vec3)), solid: false },
	];
	for (const ring of flat) {
		for (let k = 0; k < ring.length; k++) {
			const [ax, ay] = ring[k]!;
			const [bx, by] = ring[(k + 1) % ring.length]!;
			faces.push({ rings: [[[ax, ay, -h], [bx, by, -h], [bx, by, h], [ax, ay, h]]], solid: false });
		}
	}
	return { faces, lines: [], dots: [] };
}

/** Lưới của một vật theo khai báo; `t` = giây từ đầu node (mặt chuyển động). */
export function meshOf(object: Object3D, t: number): Mesh {
	const resolution = object.resolution;
	switch (object.type) {
		case 'cube':
			return cube(object.size ?? 2);
		case 'sphere':
			return sphere(object.radius ?? object.size ?? 1.5, resolution ?? 32);
		case 'cylinder':
			return cylinder(object.radius ?? 1, object.radius ?? 1, object.height ?? 2, resolution ?? 32);
		case 'cone':
			return cylinder(object.radius ?? 1, 0, object.height ?? 2, resolution ?? 32);
		case 'torus':
			return torus(object.radius ?? object.size ?? 1.5, object.tube ?? 0.5, resolution ?? 36);
		case 'plane':
			return plane(object.size ?? 4, resolution ?? 8);
		case 'surface':
			return surface(object.expr ?? '0', object.xRange ?? [-3, 3], object.yRange ?? [-3, 3], resolution ?? 24, t);
		case 'axes':
			return axes(object.length ?? 3);
		case 'extrude':
			return object.d ? extrude(object.d, object.size ?? 3, object.depth ?? 0.6) : { faces: [], lines: [], dots: [] };
		case 'line':
			return { faces: [], lines: object.points && object.points.length > 1 ? [{ points: object.points as Vec3[] }] : [], dots: [] };
		case 'points':
			return { faces: [], lines: [], dots: (object.points ?? []) as Vec3[] };
	}
}
