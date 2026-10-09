/**
 * `product`: vật thể trên bệ tròn bóng, xoay chậm kiểu turntable, camera bay
 * vào từ xa rồi vòng nhẹ; vòng đèn màu nhấn quanh bệ phát sáng. Nhãn trên sàn.
 */

import * as THREE from 'three';

import type { SceneSpec } from '../spec.ts';
import { easeInOutCubic, easeOutBack, easeOutCubic, fitDistance, glossy, orbit, phase, textGeometry, textMesh, type Stage } from '../studio.ts';
import { buildProduct } from './objects.ts';

export function product(stage: Stage, spec: SceneSpec): (t: number) => void {
	const group = new THREE.Group();
	stage.root.add(group);
	const color = new THREE.Color(spec.color ?? stage.palette.colors[1]!);
	const { object, animate } = buildProduct(spec.object!, color, stage.accent);

	const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.45, 0.28, 96), glossy(stage.palette.floor, { roughness: 0.22, metalness: 0.4 }));
	pedestal.position.y = 0.14;
	pedestal.castShadow = true;
	pedestal.receiveShadow = true;
	const halo = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.022, 12, 160), new THREE.MeshBasicMaterial({ color: new THREE.Color(stage.accent).multiplyScalar(2.5) }));
	halo.rotation.x = -Math.PI / 2;
	halo.position.y = 0.285;
	const turntable = new THREE.Group();
	turntable.position.y = 0.28;
	turntable.add(object);
	group.add(pedestal, halo, turntable);

	const text = new THREE.MeshStandardMaterial({ color: stage.palette.text, roughness: 0.6, envMapIntensity: 0.25 });
	let caption: THREE.Mesh | null = null;
	if (spec.label) {
		// Nhãn phía trên vật (đặt trước bệ thì gần camera, phóng to và tràn khung).
		const size = Math.min(0.3, 2.9 / Math.max(8, spec.label.length) / 0.62);
		caption = textMesh(textGeometry(spec.label, { font: 'display', size, depth: 0.05, bevel: 0.01 }), text);
		caption.position.set(0, 2.85, -0.4);
		group.add(caption);
	}
	if (spec.title) {
		const title = textMesh(textGeometry(spec.title, { font: 'display', size: 0.32, depth: 0.05, bevel: 0.01 }), text);
		title.position.set(0, spec.label ? 3.35 : 2.85, -0.4);
		group.add(title);
	}

	const center = new THREE.Vector3(0, 1.5, 0);
	const distance = fitDistance(stage.camera, 3.6, 3.9, 1.1);
	return (t) => {
		const intro = easeOutCubic(phase(t, 0, Math.min(1.6, spec.duration * 0.35)));
		object.scale.setScalar(easeOutBack(phase(t, 0.15, 0.7)));
		turntable.rotation.y = -0.6 + t * 0.55;
		animate(t);
		if (caption) caption.visible = t > 0.6;
		const k = easeInOutCubic(phase(t, 0, spec.duration));
		// Bay vào từ xa + cao, sau đó vòng chậm quanh vật.
		orbit(stage.camera, center, 25 - 40 * k, 18 - 6 * intro, distance * (1.6 - 0.6 * intro));
	};
}
