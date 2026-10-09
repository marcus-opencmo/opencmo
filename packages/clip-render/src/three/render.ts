/**
 * Vẽ node `scene3d` bằng Canvas 2D (spec visuals V5) — cách renderer Cairo
 * của manim làm 3D không cần GPU: biến đổi từng vật, chiếu phối cảnh, tô theo
 * một nguồn sáng, rồi vẽ mặt xa trước mặt gần (painter's algorithm). Preview
 * và export chạy đúng đoạn mã này, nên ra cùng một khung hình.
 *
 * Không bỏ mặt quay lưng theo chiều quấn: chiều quấn của các lưới không đồng
 * nhất và torus không lồi. Mặt xa bị mặt gần phủ lên, và pháp tuyến luôn lật
 * về phía camera khi tính sáng (sáng hai mặt).
 */

import type { Object3D, Scene3DNode } from '@opencmo/clip-doc';

import { hex, parseColor } from '../color.ts';
import { sample } from '../frame.ts';
import { FPS, type RNode } from '../tree.ts';
import type { Ctx2D } from '../types.ts';
import { meshOf, type Mesh, type Vec3 } from './mesh.ts';

const DEG = Math.PI / 180;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
	const length = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / length, a[1] / length, a[2] / length];
};

/** Trần số mặt của một node: giữ thời gian export (mỗi mặt là một fill). */
export const MAX_FACES = 20_000;

type Camera = { position: Vec3; right: Vec3; up: Vec3; forward: Vec3; focal: number; cx: number; cy: number };

function camera(node: Scene3DNode, r: RNode, width: number, height: number): Camera {
	const v = r.values;
	const seconds = r.local / FPS;
	const phi = (Number.isNaN(v.cameraPhi) ? (node.camera?.phi ?? 65) : v.cameraPhi) * DEG;
	const theta = ((Number.isNaN(v.cameraTheta) ? (node.camera?.theta ?? -50) : v.cameraTheta) + (node.camera?.orbit ?? 0) * seconds) * DEG;
	const distance = Number.isNaN(v.cameraDistance) ? (node.camera?.distance ?? 12) : v.cameraDistance;
	const position: Vec3 = [distance * Math.sin(phi) * Math.cos(theta), distance * Math.sin(phi) * Math.sin(theta), distance * Math.cos(phi)];
	const forward = norm([-position[0], -position[1], -position[2]]);
	// Trục z hướng lên (manim). Nhìn thẳng từ trên thì lấy y làm "lên".
	const worldUp: Vec3 = Math.abs(Math.sin(phi)) < 1e-3 ? [0, 1, 0] : [0, 0, 1];
	const right = norm(cross(forward, worldUp));
	const up = cross(right, forward);
	const fov = (node.camera?.fov ?? 35) * DEG;
	return { position, right, up, forward, focal: height / 2 / Math.tan(fov / 2), cx: width / 2, cy: height / 2 };
}

/**
 * Lưới chỉ phụ thuộc khai báo của vật (và `t` với mặt cong có biến t): dựng
 * một lần theo object + độ chia. Trước đây dựng lại mỗi khung — parse lại SVG
 * của extrude 20k ký tự, tính lại (n+1)² điểm của surface — 30 lần mỗi giây.
 * Khoá là chính object (document không đổi trong một lần xuất; sửa trong editor
 * tạo object mới).
 */
const meshes = new WeakMap<Object3D, Map<number, Mesh>>();
function cachedMesh(object: Object3D, seconds: number, resolution: number | undefined): Mesh {
	const sized = resolution === undefined ? object : { ...object, resolution };
	if (object.type === 'surface' && /\bt\b/.test(object.expr ?? '')) return meshOf(sized, seconds);
	let byResolution = meshes.get(object);
	if (!byResolution) meshes.set(object, (byResolution = new Map()));
	const key = resolution ?? -1;
	let mesh = byResolution.get(key);
	if (!mesh) byResolution.set(key, (mesh = meshOf(sized, 0)));
	return mesh;
}

/** Độ chia mặc định của từng loại (khớp `meshOf`); loại không có độ chia: undefined. */
const DEFAULT_RESOLUTION: Partial<Record<Object3D['type'], number>> = { sphere: 32, cylinder: 32, cone: 32, torus: 36, plane: 8, surface: 24 };

/**
 * Ngân sách mặt của một cảnh mỗi khung. Mỗi mặt là một fill + stroke trên
 * Canvas 2D (~9 µs ở 1080p): 6.000 mặt ≈ 55 ms. Vượt ngân sách thì GIẢM ĐỘ CHIA
 * mọi vật theo cùng tỉ lệ (mặt ~ độ chia²) — không cắt bỏ mặt, vì cắt bỏ làm
 * mất nguyên vật (64 quả cầu chỉ còn 58) mà không ai hay.
 */
export const FACE_BUDGET = 6_000;

export function sceneMeshes(node: Scene3DNode, seconds: number): Mesh[] {
	const full = node.objects.map((object) => cachedMesh(object, seconds, undefined));
	const total = full.reduce((sum, mesh) => sum + mesh.faces.length, 0);
	if (total <= FACE_BUDGET) return full;
	const factor = Math.sqrt(FACE_BUDGET / total);
	return node.objects.map((object, index) => {
		const base = object.resolution ?? DEFAULT_RESOLUTION[object.type];
		if (base === undefined) return full[index]!;
		return cachedMesh(object, seconds, Math.max(3, Math.floor(base * factor)));
	});
}

type Projected = { x: number; y: number; depth: number };

function project(cam: Camera, p: Vec3): Projected {
	const rel = sub(p, cam.position);
	const depth = dot(rel, cam.forward);
	const safe = Math.max(depth, 1e-3);
	return { x: cam.cx + (dot(rel, cam.right) * cam.focal) / safe, y: cam.cy - (dot(rel, cam.up) * cam.focal) / safe, depth };
}

/** Giá trị của vật ở khung này: khai báo, rồi keyframe của vật đè lên. */
function objectState(object: Object3D, frame: number) {
	const scale = object.scale ?? 1;
	const state = {
		x: object.position?.[0] ?? 0,
		y: object.position?.[1] ?? 0,
		z: object.position?.[2] ?? 0,
		rotateX: object.rotation?.[0] ?? 0,
		rotateY: object.rotation?.[1] ?? 0,
		rotateZ: object.rotation?.[2] ?? 0,
		scale: (Array.isArray(scale) ? scale : [scale, scale, scale]) as Vec3,
		opacity: object.opacity ?? 1,
		progress: 1,
	};
	for (const track of object.tracks ?? []) {
		const value = sample(track as never, frame);
		if (value === null) continue;
		if (track.property === 'scale') state.scale = [value, value, value];
		else state[track.property] = value;
	}
	return state;
}

/** Điểm của vật → thế giới: phóng, xoay x → y → z (độ), dời. */
function transformer(state: ReturnType<typeof objectState>): (p: Vec3) => Vec3 {
	const [ax, ay, az] = [state.rotateX * DEG, state.rotateY * DEG, state.rotateZ * DEG];
	const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
	return ([x0, y0, z0]) => {
		let x = x0 * state.scale[0];
		let y = y0 * state.scale[1];
		let z = z0 * state.scale[2];
		[y, z] = [y * cx - z * sx, y * sx + z * cx];
		[x, z] = [x * cy + z * sy, -x * sy + z * cy];
		[x, y] = [x * cz - y * sz, x * sz + y * cz];
		return [x + state.x, y + state.y, z + state.z];
	};
}

/** Như `transformer` nhưng ghi vào `out[at..at+2]` — không cấp phát. */
function transformerInto(state: ReturnType<typeof objectState>): (p: Vec3, out: Float64Array, at: number) => void {
	const [ax, ay, az] = [state.rotateX * DEG, state.rotateY * DEG, state.rotateZ * DEG];
	const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
	const [kx, ky, kz] = state.scale;
	return (p, out, at) => {
		const x = p[0] * kx;
		let y = p[1] * ky;
		let z = p[2] * kz;
		const y1 = y * cx - z * sx;
		z = y * sx + z * cx;
		y = y1;
		const x1 = x * cy + z * sy;
		z = -x * sy + z * cy;
		const x2 = x1 * cz - y * sz;
		y = x1 * sz + y * cz;
		out[at] = x2 + state.x;
		out[at + 1] = y + state.y;
		out[at + 2] = z + state.z;
	};
}

/**
 * Pháp tuyến theo Newell (mọi đỉnh góp phần): ô lưới ở cực của mặt cầu co
 * thành tam giác có hai đỉnh trùng — lấy ba điểm đầu thì ra vector 0 và mặt
 * đó tô đen.
 Đỉnh ở mảng phẳng [x0,y0,z0,x1,…].
 */
function newellFlat(v: Float64Array, n: number): Vec3 {
	let nx = 0;
	let ny = 0;
	let nz = 0;
	for (let k = 0; k < n; k++) {
		const a = k * 3;
		const b = ((k + 1) % n) * 3;
		nx += (v[a + 1]! - v[b + 1]!) * (v[a + 2]! + v[b + 2]!);
		ny += (v[a + 2]! - v[b + 2]!) * (v[a]! + v[b]!);
		nz += (v[a]! - v[b]!) * (v[a + 1]! + v[b + 1]!);
	}
	const length = Math.hypot(nx, ny, nz) || 1;
	return [nx / length, ny / length, nz / length];
}

let scratch = new Float64Array(64);

const rgb = (color: string): Vec3 => {
	const value = parseColor(color);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = ([r, g, b]: Vec3, light: number): string => {
	const c = (value: number) => Math.max(0, Math.min(255, Math.round(value * light)));
	return hex((c(r) << 16) | (c(g) << 8) | c(b));
};

type Item =
	| { kind: 'face'; depth: number; rings: Float32Array[]; fill: string; edge: string | null; wire: boolean; alpha: number }
	| { kind: 'line'; depth: number; points: Projected[]; color: string; width: number; arrow: boolean; alpha: number }
	| { kind: 'dot'; depth: number; at: Projected; color: string; size: number; alpha: number };

const PALETTE = ['#58C4DD', '#FC6255', '#83C167', '#FFFF00', '#9A72AC', '#FF862F'];

export function drawScene3D(ctx: Ctx2D, r: RNode): void {
	const node = r.node as Scene3DNode;
	const { width, height } = r.values;
	if (width <= 0 || height <= 0) return;
	const cam = camera(node, r, width, height);
	const lightDir = norm(node.light?.direction ?? [-1, -1, 2]);
	const ambient = node.light?.ambient ?? 0.35;
	const seconds = r.local / FPS;
	const unit = Math.min(width, height) / 1080;
	const items: Item[] = [];
	let faceCount = 0;

	const meshList = sceneMeshes(node, seconds);
	node.objects.forEach((object, index) => {
		const state = objectState(object, r.local);
		if (state.opacity <= 0 || state.progress <= 0) return;
		const mesh = meshList[index]!;
		const toWorld = transformer(state);
		const toWorldInto = transformerInto(state);
		const base = rgb(object.color ?? (object.type === 'axes' ? '#E2E8F0' : PALETTE[index % PALETTE.length]!));
		const top = object.color2 ? rgb(object.color2) : null;
		// progress: phần lưới đã "dựng" theo thứ tự sinh — Create của manim cho khối.
		const faces = mesh.faces.slice(0, Math.ceil(mesh.faces.length * Math.min(1, state.progress)));
		for (const face of faces) {
			if (faceCount >= MAX_FACES) break;
			faceCount++;
			const outer = face.rings[0]!;
			if (outer.length < 3) continue;
			// Vòng nóng (tới 6.000 mặt × 30 khung/giây): ghi vào mảng số dùng lại,
			// không tạo mảng/đối tượng cho từng đỉnh — trước đây ~10 object mỗi mặt
			// làm heap mỗi luồng export phình ~300 MB giữa hai lần GC.
			const n = outer.length;
			if (scratch.length < n * 3) scratch = new Float64Array(n * 6);
			let cx = 0;
			let cy = 0;
			let cz = 0;
			for (let k = 0; k < n; k++) {
				toWorldInto(outer[k]!, scratch, k * 3);
				cx += scratch[k * 3]!;
				cy += scratch[k * 3 + 1]!;
				cz += scratch[k * 3 + 2]!;
			}
			let [nx, ny, nz] = newellFlat(scratch, n);
			// Sáng hai mặt: pháp tuyến luôn quay về phía camera.
			if (nx * (cam.position[0] - cx / n) + ny * (cam.position[1] - cy / n) + nz * (cam.position[2] - cz / n) < 0) [nx, ny, nz] = [-nx, -ny, -nz];
			const light = ambient + (1 - ambient) * Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);
			const color = top && face.shade !== undefined ? mix(base, top, face.shade) : base;
			const rings: Float32Array[] = [];
			let depth = 0;
			let behind = false;
			face.rings.forEach((ring, ringIndex) => {
				const points = new Float32Array(ring.length * 2);
				for (let k = 0; k < ring.length; k++) {
					const at = ringIndex === 0 ? k * 3 : -1;
					const [wx, wy, wz] = at >= 0 ? [scratch[at]!, scratch[at + 1]!, scratch[at + 2]!] : toWorld(ring[k]!);
					const rx = wx - cam.position[0];
					const ry = wy - cam.position[1];
					const rz = wz - cam.position[2];
					const d = rx * cam.forward[0] + ry * cam.forward[1] + rz * cam.forward[2];
					if (ringIndex === 0) {
						if (d <= 0.05) behind = true;
						depth += d;
					}
					const safe = Math.max(d, 1e-3);
					points[k * 2] = cam.cx + ((rx * cam.right[0] + ry * cam.right[1] + rz * cam.right[2]) * cam.focal) / safe;
					points[k * 2 + 1] = cam.cy - ((rx * cam.up[0] + ry * cam.up[1] + rz * cam.up[2]) * cam.focal) / safe;
				}
				rings.push(points);
			});
			if (behind) continue;
			items.push({ kind: 'face', depth: depth / n, rings, fill: css(color, light), edge: object.edges ?? null, wire: Boolean(object.wireframe), alpha: state.opacity });
		}
		const strokeWidth = (object.width ?? (object.type === 'axes' ? 4 : 6)) * unit;
		for (const line of mesh.lines) {
			const points = line.points.map(toWorld);
			// progress trên đường: vẽ nét dần theo số điểm.
			const shown = Math.max(2, Math.ceil(points.length * Math.min(1, state.progress)));
			const projected = points.slice(0, shown).map((p) => project(cam, p));
			if (projected.some((p) => p.depth <= 0.05)) continue;
			// Đường dài (trục) chia khúc để xếp chiều sâu đúng hơn với mặt xung quanh.
			for (let k = 0; k < projected.length - 1; k++) {
				const a = projected[k]!;
				const b = projected[k + 1]!;
				items.push({ kind: 'line', depth: (a.depth + b.depth) / 2, points: [a, b], color: css(base, 1), width: strokeWidth, arrow: Boolean(line.arrow) && k === projected.length - 2 && state.progress >= 1, alpha: state.opacity });
			}
		}
		for (const dot3 of mesh.dots.slice(0, Math.ceil(mesh.dots.length * Math.min(1, state.progress)))) {
			const at = project(cam, toWorld(dot3));
			if (at.depth <= 0.05) continue;
			items.push({ kind: 'dot', depth: at.depth, at, color: css(base, 1), size: (object.width ?? 10) * unit, alpha: state.opacity });
		}
	});

	items.sort((a, b) => b.depth - a.depth);
	ctx.save();
	ctx.beginPath();
	ctx.rect(0, 0, width, height);
	ctx.clip();
	if (node.background) {
		ctx.fillStyle = hex(parseColor(node.background));
		ctx.fillRect(0, 0, width, height);
	}
	const baseAlpha = ctx.globalAlpha;
	for (const item of items) {
		ctx.globalAlpha = baseAlpha * item.alpha;
		if (item.kind === 'face') {
			ctx.beginPath();
			for (const ring of item.rings) {
				ctx.moveTo(ring[0]!, ring[1]!);
				for (let k = 2; k < ring.length; k += 2) ctx.lineTo(ring[k]!, ring[k + 1]!);
				ctx.closePath();
			}
			if (item.wire) {
				ctx.strokeStyle = item.fill;
				ctx.lineWidth = 1.5 * unit;
				ctx.stroke();
				continue;
			}
			ctx.fillStyle = item.fill;
			ctx.fill(item.rings.length > 1 ? 'evenodd' : 'nonzero');
			// Viền cùng màu che khe khử răng cưa giữa hai mặt kề nhau.
			ctx.strokeStyle = item.edge ?? item.fill;
			ctx.lineWidth = item.edge ? 1.5 * unit : 1;
			ctx.lineJoin = 'round';
			ctx.stroke();
		} else if (item.kind === 'line') {
			const [a, b] = item.points as [Projected, Projected];
			ctx.strokeStyle = item.color;
			ctx.lineWidth = item.width;
			ctx.lineCap = 'round';
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
			if (item.arrow) {
				const angle = Math.atan2(b.y - a.y, b.x - a.x);
				const size = item.width * 4;
				ctx.fillStyle = item.color;
				ctx.beginPath();
				ctx.moveTo(b.x + Math.cos(angle) * size * 0.4, b.y + Math.sin(angle) * size * 0.4);
				ctx.lineTo(b.x - Math.cos(angle - 0.45) * size, b.y - Math.sin(angle - 0.45) * size);
				ctx.lineTo(b.x - Math.cos(angle + 0.45) * size, b.y - Math.sin(angle + 0.45) * size);
				ctx.closePath();
				ctx.fill();
			}
		} else {
			ctx.fillStyle = item.color;
			ctx.beginPath();
			ctx.roundRect(item.at.x - item.size / 2, item.at.y - item.size / 2, item.size, item.size, item.size / 2);
			ctx.fill();
		}
	}
	ctx.globalAlpha = baseAlpha;
	ctx.restore();
}
