/**
 * Vật thể dựng bằng code cho template `product` — không tải model, không lo
 * giấy phép. Mỗi hàm trả một Group cao ~2 đơn vị, đáy ở y = 0, tâm ngang ở
 * gốc. Vật liệu PBR thật (kim loại, kính, sơn bóng) để ăn ánh studio.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { Product } from '../spec.ts';
import { canvas2d, glossy, metal, textGeometry } from '../studio.ts';

const shadowed = <T extends THREE.Object3D>(object: T): T => {
	object.traverse((child) => {
		if ((child as THREE.Mesh).isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
	return object;
};

/** Màn hình phát sáng: gradient màu nhấn + vài khối UI mờ. */
function screenTexture(accent: THREE.Color, width: number, height: number): THREE.Texture {
	const canvas = canvas2d(width, height);
	const ctx = canvas.getContext('2d')! as CanvasRenderingContext2D;
	const gradient = ctx.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, `#${accent.clone().multiplyScalar(0.55).getHexString()}`);
	gradient.addColorStop(1, '#0b1020');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = 'rgba(255,255,255,0.18)';
	const unit = width / 12;
	for (let row = 0; row < 4; row++) ctx.fillRect(unit, height * 0.25 + row * unit * 1.6, width - unit * 2 - (row % 2) * unit * 3, unit * 0.7);
	ctx.fillStyle = `#${accent.getHexString()}`;
	ctx.beginPath();
	ctx.arc(width / 2, height * 0.13, unit * 0.9, 0, Math.PI * 2);
	ctx.fill();
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

/** Tiện: xoay một biên dạng (x = bán kính, y = độ cao) quanh trục y. */
const lathe = (profile: [number, number][], segments = 96, smooth = false) => {
	const points = profile.map(([x, y]) => new THREE.Vector2(x, y));
	// Biên dạng cong (bóng đèn, chai): nội suy spline, không thì thành các đốt gãy.
	return new THREE.LatheGeometry(smooth ? new THREE.SplineCurve(points).getPoints(80) : points, segments);
};

function phone(color: THREE.Color, accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	// Thân graphite + viền kim loại sáng: điện thoại cao cấp, không theo màu cảnh.
	const body = new THREE.Mesh(new RoundedBoxGeometry(1.05, 2.1, 0.12, 8, 0.14), metal('#3f4450', 0.32));
	void color;
	const glass = new THREE.Mesh(
		new RoundedBoxGeometry(0.98, 2.02, 0.02, 6, 0.12),
		new THREE.MeshPhysicalMaterial({ map: screenTexture(accent, 256, 512), emissive: '#ffffff', emissiveMap: screenTexture(accent, 256, 512), emissiveIntensity: 0.9, roughness: 0.05, clearcoat: 1 }),
	);
	glass.position.z = 0.065;
	const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 32), metal('#1f2937', 0.15));
	lens.rotation.x = Math.PI / 2;
	lens.position.set(-0.3, 0.8, -0.075);
	group.add(body, glass, lens);
	group.position.y = 1.05;
	group.rotation.x = -0.08;
	const holder = new THREE.Group();
	holder.add(group);
	return holder;
}

function laptop(color: THREE.Color, accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const shell = metal(color.clone().lerp(new THREE.Color('#cbd5e1'), 0.6), 0.3);
	const base = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.08, 1.6, 6, 0.04), shell);
	base.position.y = 0.04;
	const keys = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.7), new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.8 }));
	keys.rotation.x = -Math.PI / 2;
	keys.position.set(0, 0.081, -0.2);
	const lid = new THREE.Group();
	const back = new THREE.Mesh(new RoundedBoxGeometry(2.4, 1.55, 0.05, 6, 0.04), shell);
	back.position.y = 0.775;
	const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.35), new THREE.MeshBasicMaterial({ map: screenTexture(accent, 512, 320) }));
	screen.position.set(0, 0.775, 0.027);
	lid.add(back, screen);
	lid.position.set(0, 0.08, -0.78);
	lid.rotation.x = -0.25;
	group.add(base, keys, lid);
	group.userData.lid = lid;
	return group;
}

function coin(_color: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const gold = metal('#F5C542', 0.2);
	const rim = new THREE.Mesh(lathe([[0, -0.1], [0.95, -0.1], [1, -0.07], [1, 0.07], [0.95, 0.1], [0.82, 0.1], [0.8, 0.07], [0, 0.07]]), gold);
	rim.rotation.x = Math.PI / 2;
	const mark = new THREE.Mesh(textGeometry('$', { font: 'display', size: 0.9, depth: 0.08, bevel: 0.02 }), gold);
	mark.geometry.computeBoundingBox();
	mark.position.set(0, -0.48, 0.07);
	const back = mark.clone();
	back.rotation.y = Math.PI;
	back.position.z = -0.07;
	group.add(rim, mark, back);
	group.position.y = 1.15;
	const holder = new THREE.Group();
	holder.add(group);
	return holder;
}

function gift(color: THREE.Color, accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const box = new THREE.Mesh(new RoundedBoxGeometry(1.5, 1.2, 1.5, 6, 0.06), glossy(color, { roughness: 0.35 }));
	box.position.y = 0.6;
	const lid = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.26, 1.6, 6, 0.06), glossy(color, { roughness: 0.35 }));
	lid.position.y = 1.3;
	const ribbon = glossy(accent, { roughness: 0.2, metalness: 0.4 });
	const band1 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.46, 1.64), ribbon);
	band1.position.y = 0.72;
	const band2 = new THREE.Mesh(new THREE.BoxGeometry(1.64, 1.46, 0.22), ribbon);
	band2.position.y = 0.72;
	const loop = (angle: number) => {
		const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.07, 16, 48), ribbon);
		mesh.position.set(Math.cos(angle) * 0.22, 1.62, Math.sin(angle) * 0.22);
		mesh.rotation.set(0.3, -angle, Math.PI / 2);
		return mesh;
	};
	group.add(box, lid, band1, band2, loop(0), loop(Math.PI));
	return group;
}

function trophy(): THREE.Group {
	const group = new THREE.Group();
	const gold = metal('#F5C542', 0.16);
	const cup = new THREE.Mesh(lathe([[0.5, 0], [0.55, 0.08], [0.2, 0.2], [0.14, 0.55], [0.18, 0.75], [0.6, 1.0], [0.72, 1.55], [0.74, 1.95], [0.68, 1.95], [0.62, 1.58], [0.02, 1.05]]), gold);
	const base = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.26, 1.1, 5, 0.05), metal('#1f2937', 0.35));
	base.position.y = -0.13;
	const handle = (side: number) => {
		const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 16, 48, Math.PI), gold);
		mesh.position.set(side * 0.72, 1.45, 0);
		mesh.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
		return mesh;
	};
	const star = new THREE.Mesh(textGeometry('1', { font: 'display', size: 0.34, depth: 0.05 }), metal('#fff7d6', 0.2));
	star.position.set(0, 1.12, 0.46);
	group.add(cup, base, handle(1), handle(-1), star);
	group.position.y = 0.26;
	const holder = new THREE.Group();
	holder.add(group);
	return holder;
}

function rocket(color: THREE.Color, accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const body = new THREE.Mesh(lathe([[0, 2.2], [0.18, 2.05], [0.36, 1.7], [0.44, 1.2], [0.44, 0.5], [0.38, 0.25], [0.3, 0.2], [0, 0.2]]), glossy('#f1f5f9', { roughness: 0.25 }));
	const nose = new THREE.Mesh(lathe([[0, 2.2], [0.18, 2.05], [0.3, 1.82], [0, 1.82]]), glossy(accent, { roughness: 0.2 }));
	const window_ = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 16, 48), metal('#cbd5e1', 0.2));
	window_.position.set(0, 1.35, 0.42);
	const glass = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), new THREE.MeshPhysicalMaterial({ color: '#7dd3fc', roughness: 0.05, metalness: 0.1, clearcoat: 1, emissive: '#0ea5e9', emissiveIntensity: 0.4 }));
	glass.position.set(0, 1.35, 0.43);
	const finShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.42, -0.2), new THREE.Vector2(0.42, 0.05), new THREE.Vector2(0, 0.62)]);
	for (let k = 0; k < 3; k++) {
		const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02 }), glossy(color, { roughness: 0.25 }));
		fin.position.y = 0.3;
		const pivot = new THREE.Group();
		fin.position.x = 0.36;
		fin.position.z = -0.03;
		pivot.add(fin);
		pivot.rotation.y = (k / 3) * Math.PI * 2;
		group.add(pivot);
	}
	const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 32, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color('#fb923c').multiplyScalar(3), transparent: true, opacity: 0.9 }));
	flame.rotation.x = Math.PI;
	flame.position.y = -0.12;
	group.add(body, nose, window_, glass, flame);
	group.userData.flame = flame;
	group.position.y = 0.3;
	const holder = new THREE.Group();
	holder.add(group);
	return holder;
}

function lightbulb(accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const glass = new THREE.Mesh(
		lathe([[0.22, 0.55], [0.3, 0.8], [0.62, 1.25], [0.66, 1.55], [0.55, 1.9], [0.3, 2.07], [0, 2.1]], 96, true),
		new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.02, transmission: 1, thickness: 0.2, ior: 1.45, transparent: true, opacity: 0.35, clearcoat: 1, side: THREE.DoubleSide }),
	);
	const filament = new THREE.Mesh(new THREE.TorusKnotGeometry(0.12, 0.012, 96, 8, 2, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color('#fde68a').multiplyScalar(4) }));
	filament.position.y = 1.35;
	filament.rotation.x = Math.PI / 2;
	const glow = new THREE.PointLight(accent, 0, 4, 2);
	glow.position.y = 1.4;
	const screw = new THREE.Mesh(lathe([[0.22, 0.55], [0.24, 0.5], [0.22, 0.45], [0.24, 0.4], [0.22, 0.35], [0.24, 0.3], [0.2, 0.2], [0.1, 0.12], [0, 0.12]]), metal('#cbd5e1', 0.25));
	group.add(glass, filament, glow, screw);
	group.userData.filament = filament;
	group.userData.glow = glow;
	return group;
}

function globe(accent: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.95, 64, 48), new THREE.MeshPhysicalMaterial({ color: '#0b1a33', roughness: 0.35, metalness: 0.2, clearcoat: 1 }));
	// Điểm "thành phố" theo xoắn Fibonacci, chỉ lấy một phần như lục địa.
	const count = 900;
	const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.8) }), count);
	const m = new THREE.Matrix4();
	let used = 0;
	for (let i = 0; i < count; i++) {
		const y = 1 - (i / (count - 1)) * 2;
		const r = Math.sqrt(1 - y * y);
		const theta = i * Math.PI * (3 - Math.sqrt(5));
		const x = Math.cos(theta) * r;
		const z = Math.sin(theta) * r;
		if (Math.sin(x * 3.1) + Math.cos(z * 2.3 + y * 2) < 0.2) continue;
		m.setPosition(x * 0.965, y * 0.965, z * 0.965);
		dots.setMatrixAt(used++, m);
	}
	dots.count = used;
	const atmosphere = new THREE.Mesh(
		new THREE.SphereGeometry(1.08, 64, 48),
		new THREE.ShaderMaterial({
			transparent: true,
			side: THREE.BackSide,
			depthWrite: false,
			uniforms: { color: { value: accent } },
			vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
			fragmentShader: 'uniform vec3 color; varying vec3 vN; void main(){ float i = pow(0.7 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(color * 1.6, clamp(i, 0.0, 1.0)); }',
		}),
	);
	const spin = new THREE.Group();
	spin.add(sphere, dots);
	group.add(spin, atmosphere);
	group.position.y = 1.15;
	group.userData.spin = spin;
	const holder = new THREE.Group();
	holder.add(group);
	holder.userData.spin = spin;
	return holder;
}

function box(): THREE.Group {
	const group = new THREE.Group();
	const cardboard = new THREE.MeshStandardMaterial({ color: '#c8925a', roughness: 0.85 });
	const body = new THREE.Mesh(new RoundedBoxGeometry(1.8, 1.3, 1.4, 4, 0.03), cardboard);
	body.position.y = 0.65;
	const tape = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 1.42), new THREE.MeshStandardMaterial({ color: '#e7c08a', roughness: 0.4 }));
	tape.position.y = 1.306;
	const label = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.7 }));
	label.position.set(0.45, 0.8, 0.701);
	group.add(body, tape, label);
	return group;
}

function bottle(color: THREE.Color): THREE.Group {
	const group = new THREE.Group();
	const glass = new THREE.Mesh(
		lathe([[0, 0], [0.48, 0], [0.52, 0.06], [0.52, 1.2], [0.46, 1.42], [0.2, 1.62], [0.18, 1.9], [0, 1.9]], 96, true),
		new THREE.MeshPhysicalMaterial({ color, roughness: 0.04, transmission: 0.9, thickness: 0.6, ior: 1.5, clearcoat: 1, attenuationColor: color, attenuationDistance: 1.2 }),
	);
	const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.22, 48), metal('#e5e7eb', 0.22));
	cap.position.y = 2.0;
	const label = new THREE.Mesh(new THREE.CylinderGeometry(0.525, 0.525, 0.55, 64, 1, true), new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.6, side: THREE.DoubleSide }));
	label.position.y = 0.62;
	group.add(glass, cap, label);
	return group;
}

/** Vật + hàm cập nhật chuyển động riêng (lật nắp laptop, lửa tên lửa, đèn bật…). */
export function buildProduct(kind: Product, color: THREE.Color, accent: THREE.Color): { object: THREE.Group; animate: (t: number) => void } {
	const object = shadowed(
		{
			phone: () => phone(color, accent),
			laptop: () => laptop(color, accent),
			coin: () => coin(color),
			gift: () => gift(color, accent),
			trophy: () => trophy(),
			rocket: () => rocket(color, accent),
			lightbulb: () => lightbulb(accent),
			globe: () => globe(accent),
			box: () => box(),
			bottle: () => bottle(color),
		}[kind](),
	);
	const animate = (t: number) => {
		if (kind === 'laptop') object.userData.lid.rotation.x = -1.55 + 1.3 * Math.min(1, Math.max(0, (t - 0.4) / 1.1)) ** 0.6;
		if (kind === 'rocket') {
			const flame = object.children[0]!.userData.flame as THREE.Mesh;
			flame.scale.set(1, 0.85 + 0.25 * Math.sin(t * 40), 1);
		}
		if (kind === 'lightbulb') {
			const on = Math.min(1, Math.max(0, (t - 0.8) / 0.4));
			(object.userData.glow as THREE.PointLight).intensity = 6 * on;
			((object.userData.filament as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set('#fde68a').multiplyScalar(0.4 + 3.6 * on);
		}
		if (kind === 'globe') (object.userData.spin as THREE.Group).rotation.y = t * 0.5;
		if (kind === 'coin') object.children[0]!.rotation.y = t * 2.2;
	};
	return { object, animate };
}
