/**
 * `number`: một con số lớn đùn khối, kim loại màu nhấn, đếm lên rồi chốt —
 * lúc chốt có vòng sáng nở ra và hạt bắn quanh. Nhãn nhỏ phía dưới. Camera
 * đẩy dần vào, chữ số nghiêng nhẹ theo thời gian để ánh phản chiếu chạy qua.
 */

import * as THREE from 'three';

import { formatValue, type SceneSpec } from '../spec.ts';
import { easeInOutCubic, easeOutCubic, easeOutExpo, fitDistance, orbit, phase, textGeometry, textMesh, type Stage } from '../studio.ts';

export function number(stage: Stage, spec: SceneSpec): (t: number) => void {
	const value = spec.value!;
	const decimals = spec.decimals;
	const final = `${spec.prefix ?? ''}${formatValue(value, decimals)}${spec.suffix ?? ''}`;
	const size = Math.min(1.5, 7.2 / Math.max(3, final.length));

	const group = new THREE.Group();
	stage.root.add(group);

	// Kim loại màu nhấn: phản chiếu môi trường studio + clearcoat bóng.
	const gold = new THREE.MeshPhysicalMaterial({ color: stage.accent, metalness: 0.85, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
	const digits = textMesh(new THREE.BufferGeometry(), gold);
	digits.position.y = 0.55;
	group.add(digits);

	const muted = new THREE.MeshStandardMaterial({ color: stage.palette.text, roughness: 0.6, envMapIntensity: 0.25 });
	let caption: THREE.Mesh | null = null;
	if (spec.label) {
		caption = textMesh(textGeometry(spec.label, { font: 'body', size: 0.3, depth: 0.03 }), muted);
		caption.position.set(0, 0.05, 0.3);
		group.add(caption);
	}
	let title: THREE.Mesh | null = null;
	if (spec.title) {
		title = textMesh(textGeometry(spec.title, { font: 'display', size: 0.3, depth: 0.05, bevel: 0.01 }), muted);
		title.position.set(0, 0.55 + size * 1.25, -0.3);
		group.add(title);
	}

	// Vòng sáng nằm trên sàn, nở ra lúc chốt số.
	const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 12, 128), new THREE.MeshBasicMaterial({ color: stage.accent, transparent: true }));
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.02;
	group.add(ring);

	// Hạt: hướng + tốc độ cố định theo seed.
	const count = 70;
	const sparks = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(stage.accent).multiplyScalar(2.2) }), count);
	const paths = Array.from({ length: count }, () => {
		const angle = stage.random() * Math.PI * 2;
		const lift = 0.2 + stage.random() * 0.9;
		return { dir: new THREE.Vector3(Math.cos(angle), lift, Math.sin(angle) * 0.6).normalize(), speed: 1.6 + stage.random() * 2.2, size: 0.5 + stage.random() * 0.9 };
	});
	group.add(sparks);
	const matrix = new THREE.Matrix4();
	const scratch = new THREE.Vector3();

	const count_ = Math.min(1.8, spec.duration * 0.4);
	const settle = 0.25 + count_;
	const center = new THREE.Vector3(0, 0.55 + size * 0.45, 0);
	// Khung theo hộp bao THẬT của chuỗi cuối (ước theo số ký tự thì "$2.4M" tràn mép).
	const finalGeometry = textGeometry(final, { font: 'display', size, depth: size * 0.32, bevel: size * 0.04 });
	finalGeometry.computeBoundingBox();
	const textWidth = finalGeometry.boundingBox!.max.x - finalGeometry.boundingBox!.min.x;
	const distance = fitDistance(stage.camera, Math.max(3.6, textWidth + 0.6), size * 2.6, 1.18);

	return (t) => {
		const p = phase(t, 0.25, count_);
		const shown = value * easeOutExpo(p);
		const text = p >= 1 ? final : `${spec.prefix ?? ''}${formatValue(shown, decimals ?? (Number.isInteger(value) ? 0 : 1))}${spec.suffix ?? ''}`;
		digits.geometry = textGeometry(text, { font: 'display', size, depth: size * 0.32, bevel: size * 0.04 });
		// Nảy nhẹ lúc chốt, nghiêng chậm cho ánh phản chiếu trượt qua mặt số.
		const pop = phase(t, settle, 0.35);
		digits.scale.setScalar(1 + 0.08 * Math.sin(pop * Math.PI));
		digits.rotation.y = -0.18 + 0.36 * easeInOutCubic(phase(t, 0, spec.duration));
		if (caption) caption.visible = t > settle - 0.2;

		const burst = phase(t, settle, 1.4);
		const ringScale = 0.6 + 3.2 * easeOutCubic(burst);
		ring.scale.setScalar(ringScale);
		(ring.material as THREE.MeshBasicMaterial).opacity = burst > 0 ? 0.9 * (1 - burst) : 0;
		paths.forEach((path, index) => {
			const d = path.speed * easeOutCubic(burst);
			scratch.copy(path.dir).multiplyScalar(d).add(center);
			scratch.y -= 1.2 * burst * burst;
			const s = burst > 0 && burst < 1 ? path.size * (1 - burst) : 0;
			matrix.makeScale(s, s, s).setPosition(scratch);
			sparks.setMatrixAt(index, matrix);
		});
		sparks.instanceMatrix.needsUpdate = true;

		const k = easeInOutCubic(phase(t, 0, spec.duration));
		orbit(stage.camera, center, 8 - 14 * k, 10 + 4 * k, distance * (1.12 - 0.12 * k));
	};
}
