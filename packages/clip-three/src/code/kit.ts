/**
 * Kit v2 của cảnh code (spec code-scenes): thứ agent gọi để KHÔNG phải tự tính
 * hình học. Spike 01/10 cho thấy model chọn ý rất tốt nhưng tự đặt camera và
 * chữ thì trôi ra ngoài khung; nên khung hình, nhãn và số liệu do kit lo:
 *
 * - `frame()`: camera tự canh theo hộp bao THẬT của cảnh ở trạng thái cuối
 *   (runtime chạy trước `update(duration)` một lần), model chỉ nói góc và độ đẩy.
 * - `label()`: chữ 3D luôn quay về camera, bám theo vật nếu có.
 * - `bars()`, `counter()`, `product()`: mảnh ghép số liệu — con số do kit vẽ
 *   từ dữ liệu, không phải model tự dựng hình.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { formatValue, PRODUCTS, type Product } from '../spec.ts';
import { clamp01, easeInOutCubic, easeOutBack, easeOutCubic, easeOutExpo, fitDistance, glossy, metal, orbit, phase, rng, textGeometry, textMesh, type Stage } from '../studio.ts';
import { buildProduct } from '../templates/objects.ts';

type Label = { mesh: THREE.Mesh; at: THREE.Object3D | THREE.Vector3 | null; lift: number };

export type FrameOptions = {
	/** Góc quay quanh trục đứng (độ). Mặc định 16. */
	yaw?: number;
	/** Góc nhìn từ trên xuống (độ). Mặc định 12. */
	pitch?: number;
	/** Khoảng chừa quanh cảnh (0.15 = 15%). Mặc định 0.18. */
	padding?: number;
	/** 0 → 1: đẩy camera vào gần (1 = gần hơn 12%). */
	push?: number;
	/** true: bám hộp bao HIỆN TẠI thay vì hộp của trạng thái cuối (camera theo vật lớn dần). */
	follow?: boolean;
};

export function createKit(stage: Stage) {
	const labels: Label[] = [];
	const scratch = new THREE.Box3();
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	let finalBounds: THREE.Box3 | null = null;
	let framed = false;

	const boundsOf = (follow: boolean): THREE.Box3 => {
		if (!follow && finalBounds) return finalBounds;
		stage.root.updateMatrixWorld(true);
		return scratch.setFromObject(stage.root, true);
	};

	const kit = {
		// ---- thời gian
		phase,
		clamp01,
		easeOutCubic,
		easeInOutCubic,
		easeOutExpo,
		easeOutBack,
		/** Tiến độ 0→1 của phần tử thứ `index` trong một dãy xuất hiện lần lượt. */
		stagger: (t: number, index: number, options: { start?: number; step?: number; length?: number } = {}) =>
			phase(t, (options.start ?? 0) + index * (options.step ?? 0.18), options.length ?? 0.6),

		// ---- vật liệu, chữ, camera tay
		glossy,
		metal,
		textGeometry,
		textMesh,
		rng,
		orbit,
		fitDistance,

		/** Đặt camera nhìn trọn cảnh. Gọi MỖI khung trong `update` (có thể đổi yaw/push theo t). */
		frame(options: FrameOptions = {}): void {
			framed = true;
			const box = boundsOf(options.follow ?? false);
			if (box.isEmpty()) return;
			box.getSize(size);
			box.getCenter(center);
			// Kẹp lề: Gemini đặt padding 1.0 (lề gấp ba cảnh) — vật chỉ còn 1/3 khung (01/10).
			const pad = 1 + Math.min(0.35, Math.max(0, options.padding ?? 0.18)) * 2;
			const distance = fitDistance(stage.camera, size.x * pad, size.y * pad, 1) + size.z / 2;
			// Tầm nhìn theo cảnh: cảnh to (chữ cỡ 4…) đẩy camera ra xa hơn mặt phẳng xa
			// mặc định (200) — mọi vật bị cắt, khung trống (đo thật 01/10, Gemini).
			const reach = distance + size.length();
			if (stage.camera.far < reach * 1.5 || stage.camera.near > distance / 100) {
				stage.camera.far = Math.max(200, reach * 2);
				stage.camera.near = Math.max(0.05, Math.min(0.1, distance / 200));
				stage.camera.updateProjectionMatrix();
			}
			orbit(stage.camera, center, options.yaw ?? 16, options.pitch ?? 12, distance * (1 - 0.12 * clamp01(options.push ?? 0)));
		},

		/** Nhãn chữ 3D quay về camera. `at`: vật để bám (nhãn nằm trên đỉnh nó) hoặc một điểm. */
		label(text: string, options: { size?: number; color?: THREE.ColorRepresentation; font?: 'display' | 'body'; at?: THREE.Object3D | THREE.Vector3; lift?: number; glow?: number | boolean } = {}): THREE.Mesh {
			const size_ = options.size ?? 0.32;
			const material = new THREE.MeshStandardMaterial({ color: options.color ?? stage.palette.text, roughness: 0.55, envMapIntensity: 0.2 });
			if (options.glow) {
				// Chữ sáng qua bloom thì nhoè, không đọc được: `true` là mức vừa, trần 0,8.
				material.emissive = new THREE.Color(options.color ?? stage.palette.text);
				material.emissiveIntensity = Math.min(0.8, options.glow === true ? 0.35 : Number(options.glow) || 0);
			}
			const mesh = textMesh(textGeometry(text, { font: options.font ?? 'display', size: size_, depth: size_ * 0.12, bevel: size_ * 0.02 }), material);
			mesh.name = `label "${text}"`;
			mesh.userData.label = text;
			stage.root.add(mesh);
			labels.push({ mesh, at: options.at ?? null, lift: options.lift ?? 0.25 });
			return mesh;
		},

		/** Cột so sánh: `values` cùng thang. `grow(p)` 0→1 cho cột mọc lần lượt. */
		bars(values: number[], options: { labels?: string[]; highlight?: number; width?: number; height?: number; decimals?: number; showValues?: boolean } = {}) {
			const group = new THREE.Group();
			group.name = 'bars';
			stage.root.add(group);
			const max = Math.max(...values, 1e-9);
			const span = options.width ?? 3.6;
			const tall = options.height ?? 2.6;
			const gap = 0.35;
			const width = Math.min(1.1, (span - gap * (values.length - 1)) / values.length);
			const key = options.highlight ?? values.indexOf(max);
			const columns = values.map((value, index) => {
				const color = index === key ? stage.accent : new THREE.Color(stage.palette.colors[(index + 1) % stage.palette.colors.length]);
				const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, 1, width, 4, Math.min(0.08, width * 0.12)), glossy(color, { emissive: index === key ? 0.35 : 0 }));
				mesh.castShadow = true;
				mesh.position.x = -span / 2 + width / 2 + index * (width + gap);
				group.add(mesh);
				const caption = options.labels?.[index] ? kit.label(options.labels[index]!, { size: 0.2, font: 'body', at: new THREE.Vector3(mesh.position.x, -0.05, width), lift: -0.3 }) : null;
				const number = options.showValues === false ? null : kit.label(formatValue(value, options.decimals), { size: 0.24, at: mesh, lift: 0.18 });
				return { mesh, height: (value / max) * tall, caption, number };
			});
			const grow = (p: number) => {
				columns.forEach((column, index) => {
					const q = easeOutBack(clamp01(p * columns.length - index * 0.6));
					const h = Math.max(1e-3, column.height * q);
					column.mesh.scale.y = h;
					column.mesh.position.y = h / 2;
					if (column.number) column.number.visible = q > 0.4;
				});
			};
			grow(1);
			return { group, columns: columns.map((column) => column.mesh), grow };
		},

		/** Số lớn đếm lên: `set(p)` 0→1. Chữ số kim loại màu nhấn. */
		counter(value: number, options: { prefix?: string; suffix?: string; decimals?: number; size?: number } = {}) {
			const size_ = options.size ?? 1.1;
			const material = new THREE.MeshPhysicalMaterial({ color: stage.accent, metalness: 0.85, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 });
			const text = (v: number) => `${options.prefix ?? ''}${formatValue(v, options.decimals ?? (Number.isInteger(value) ? 0 : 1))}${options.suffix ?? ''}`;
			const geometry = (v: number) => textGeometry(text(v), { font: 'display', size: size_, depth: size_ * 0.3, bevel: size_ * 0.04 });
			const mesh = textMesh(geometry(value), material);
			mesh.name = `counter ${text(value)}`;
			stage.root.add(mesh);
			const set = (p: number) => {
				mesh.geometry = geometry(value * easeOutExpo(clamp01(p)));
			};
			return { mesh, set };
		},

		/** Vật dựng sẵn (phone, laptop, coin, gift, trophy, rocket, lightbulb, globe, box, bottle). `animate(t)` chạy chuyển động riêng của nó. */
		product(name: Product, options: { color?: THREE.ColorRepresentation } = {}) {
			if (!(PRODUCTS as readonly string[]).includes(name)) throw new Error(`Unknown product "${name}". Use one of: ${PRODUCTS.join(', ')}.`);
			const built = buildProduct(name, new THREE.Color(options.color ?? stage.palette.colors[1] ?? stage.accent), stage.accent);
			built.object.name = name;
			stage.root.add(built.object);
			return built;
		},
	};

	return {
		kit,
		/** Runtime gọi sau `update(t)` mỗi khung: nhãn bám vật và quay về camera. */
		afterUpdate(): void {
			const at = new THREE.Vector3();
			for (const label of labels) {
				if (label.at instanceof THREE.Vector3) label.mesh.position.copy(label.at).y += label.lift;
				else if (label.at) {
					label.at.updateMatrixWorld(true);
					const box = new THREE.Box3().setFromObject(label.at, true);
					if (!box.isEmpty()) label.mesh.position.set((box.min.x + box.max.x) / 2, box.max.y + label.lift, (box.min.z + box.max.z) / 2);
					else label.mesh.position.copy(label.at.getWorldPosition(at)).y += label.lift;
				}
				label.mesh.quaternion.copy(stage.camera.quaternion);
			}
		},
		/** Chốt hộp bao của trạng thái cuối — camera `frame()` không giật khi vật lớn dần. */
		settle(): void {
			stage.root.updateMatrixWorld(true);
			finalBounds = new THREE.Box3().setFromObject(stage.root, true);
		},
		/** Cảnh không gọi `frame()` lần nào: runtime tự canh để không bao giờ ra khung rỗng. */
		get framed() {
			return framed;
		},
		labels,
	};
}

export type Kit = ReturnType<typeof createKit>['kit'];
