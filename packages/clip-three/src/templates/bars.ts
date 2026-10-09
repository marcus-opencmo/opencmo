/**
 * `bars`: 2–6 cột bo góc mọc lên lần lượt, số trên đỉnh đếm lên theo chiều
 * cao cột, nhãn nằm trên sàn trước chân cột. Cột `highlight` (hoặc cột cao
 * nhất khi không đánh dấu) sơn màu nhấn và phát sáng — bloom ăn vào nó.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { formatValue, type SceneSpec } from '../spec.ts';
import { easeInOutCubic, easeOutBack, easeOutCubic, fitDistance, glossy, orbit, phase, textGeometry, textMesh, type Stage } from '../studio.ts';

const HEIGHT = 3.2;
const GAP = 0.45;

export function bars(stage: Stage, spec: SceneSpec): (t: number) => void {
	const items = spec.bars!;
	const max = Math.max(...items.map((item) => item.value), 1e-9);
	const width = Math.min(1.1, 5.2 / items.length);
	const span = items.length * width + (items.length - 1) * GAP;
	const hasHighlight = items.some((item) => item.highlight);
	const top = items.findIndex((item) => item.value === max);

	const group = new THREE.Group();
	stage.root.add(group);
	const text = new THREE.MeshStandardMaterial({ color: stage.palette.text, roughness: 0.65, metalness: 0, envMapIntensity: 0.25 });
	const muted = new THREE.MeshStandardMaterial({ color: stage.palette.muted, roughness: 0.5 });

	const columns = items.map((item, index) => {
		const star = hasHighlight ? !!item.highlight : index === top;
		const color = star ? stage.accent : new THREE.Color(stage.palette.colors[(index + 1) % stage.palette.colors.length]!);
		const height = Math.max(0.06, (item.value / max) * HEIGHT);
		// Hình cao 1 đơn vị, đáy ở y = 0: scale.y = chiều cao hiện tại.
		const geometry = new RoundedBoxGeometry(width, 1, width, 5, Math.min(0.12, width * 0.14));
		geometry.translate(0, 0.5, 0);
		const mesh = new THREE.Mesh(geometry, glossy(color, { emissive: star ? 1.4 : 0, roughness: star ? 0.18 : 0.32 }));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		const x = -span / 2 + width / 2 + index * (width + GAP);
		mesh.position.set(x, 0, 0);
		const value = textMesh(new THREE.BufferGeometry(), text);
		const name = textMesh(textGeometry(item.label, { font: 'body', size: Math.min(0.26, width * 0.3), depth: 0.02, align: 'center' }), muted);
		name.rotation.x = -Math.PI / 2;
		name.position.set(x, 0.01, width / 2 + 0.45);
		group.add(mesh, value, name);
		return { item, mesh, value, height, x, star, start: 0.35 + index * 0.22 };
	});

	let title: THREE.Mesh | null = null;
	if (spec.title) {
		title = textMesh(textGeometry(spec.title, { font: 'display', size: 0.34, depth: 0.06, bevel: 0.01 }), text);
		title.position.set(0, HEIGHT + 1.05, -0.4);
		group.add(title);
	}

	// Tiêu đề nằm trên đỉnh cột cao nhất: khung phải chừa thêm chỗ cho nó (font
	// display cao như Anton thì tràn mép trên — thấy khi thử Brand Kit).
	const center = new THREE.Vector3(0, HEIGHT * 0.45 + (title ? 0.4 : 0), 0);
	const distance = fitDistance(stage.camera, span + 1.2, HEIGHT + 2.2 + (title ? 0.9 : 0), 1.12);
	const grow = Math.min(1.1, spec.duration * 0.18);

	return (t) => {
		for (const column of columns) {
			const p = phase(t, column.start, grow);
			const h = column.height * easeOutBack(p);
			column.mesh.scale.y = Math.max(0.001, h);
			column.mesh.visible = p > 0;
			// Số đếm theo chiều cao đang có (dừng đúng giá trị khi cột đứng).
			const shown = column.item.value * easeOutCubic(p);
			const digits = Number.isInteger(column.item.value) ? 0 : 1;
			column.value.geometry = textGeometry(`${spec.prefix ?? ''}${formatValue(p >= 1 ? column.item.value : shown, digits)}${spec.suffix ?? ''}`, {
				font: 'display',
				size: Math.min(0.36, 0.34 + (column.star ? 0.06 : 0)),
				depth: 0.08,
				bevel: 0.012,
			});
			column.value.position.set(column.x, Math.max(h, 0.05) + 0.18, 0);
			column.value.visible = p > 0.05;
			column.value.scale.setScalar(0.6 + 0.4 * easeOutCubic(phase(t, column.start, 0.35)));
		}
		if (title) (title.material as THREE.Material).opacity = 1;
		// Camera: hạ thấp nhìn lên rồi nâng dần, quay nhẹ — cảm giác "đi quanh" số liệu.
		const k = easeInOutCubic(phase(t, 0, spec.duration));
		orbit(stage.camera, center, -16 + 26 * k, 14 + 8 * k, distance * (1.14 - 0.04 * k));
	};
}
