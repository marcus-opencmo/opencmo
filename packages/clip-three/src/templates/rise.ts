/**
 * `rise`: đường tăng trưởng 3D — ống phát sáng vẽ dần qua các điểm, mỗi điểm
 * bật lên một viên ngọc khi đường đi tới, mũi tên dẫn đầu, lưới sàn mờ và
 * "rèm" gradient dưới đường. Giá trị cuối hiện to ở đầu đường.
 */

import * as THREE from 'three';

import { formatValue, type SceneSpec } from '../spec.ts';
import { easeInOutCubic, easeOutBack, fitDistance, glossy, orbit, phase, textGeometry, textMesh, type Stage } from '../studio.ts';

const WIDTH = 6.4;
const HEIGHT = 3;

export function rise(stage: Stage, spec: SceneSpec): (t: number) => void {
	const values = spec.points!;
	const min = Math.min(...values, 0);
	const max = Math.max(...values);
	const range = max - min || 1;
	const points = values.map((value, index) => new THREE.Vector3(-WIDTH / 2 + (index / (values.length - 1)) * WIDTH, 0.25 + ((value - min) / range) * HEIGHT, 0));
	const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.4);

	const group = new THREE.Group();
	stage.root.add(group);

	// Ống: dựng một lần, vẽ dần bằng drawRange trên chỉ số tam giác theo chiều dài.
	const tubular = 400;
	const radial = 16;
	const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, tubular, 0.07, radial, false), glossy(stage.accent, { emissive: 1.6, roughness: 0.2 }));
	tube.castShadow = true;
	group.add(tube);
	const indexCount = tube.geometry.index!.count;

	// Rèm dưới đường: dải dọc từ đường xuống sàn, trong suốt dần xuống dưới.
	const curtainGeometry = new THREE.BufferGeometry();
	const samples = 200;
	const positions = new Float32Array((samples + 1) * 2 * 3);
	const alphas = new Float32Array((samples + 1) * 2);
	const index: number[] = [];
	for (let i = 0; i <= samples; i++) {
		const p = curve.getPointAt(i / samples);
		positions.set([p.x, p.y, p.z - 0.02, p.x, 0.001, p.z - 0.02], i * 6);
		alphas.set([0.45, 0], i * 2);
		if (i < samples) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
	}
	curtainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	curtainGeometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
	curtainGeometry.setIndex(index);
	const curtain = new THREE.Mesh(
		curtainGeometry,
		new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			uniforms: { color: { value: new THREE.Color(stage.accent) } },
			vertexShader: 'attribute float alpha; varying float vAlpha; void main(){ vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
			fragmentShader: 'uniform vec3 color; varying float vAlpha; void main(){ gl_FragColor = vec4(color, vAlpha); }',
		}),
	);
	group.add(curtain);
	const curtainCount = index.length;

	// Lưới sàn mờ cho cảm giác "trục".
	const grid = new THREE.GridHelper(WIDTH + 2, 12, stage.palette.muted, stage.palette.muted);
	(grid.material as THREE.Material).transparent = true;
	(grid.material as THREE.Material).opacity = 0.12;
	grid.position.y = 0.003;
	group.add(grid);

	const gems = points.map((point) => {
		const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), glossy('#ffffff', { roughness: 0.1, metalness: 0.3 }));
		gem.position.copy(point);
		gem.castShadow = true;
		group.add(gem);
		return gem;
	});
	const head = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.42, 24), glossy(stage.accent, { emissive: 1.2 }));
	group.add(head);

	const text = new THREE.MeshStandardMaterial({ color: stage.palette.text, roughness: 0.6, envMapIntensity: 0.25 });
	const last = values.at(-1)!;
	const endLabel = textMesh(textGeometry(`${spec.prefix ?? ''}${formatValue(last, spec.decimals)}${spec.suffix ?? ''}`, { font: 'display', size: 0.5, depth: 0.1, bevel: 0.015, align: 'right' }), text);
	endLabel.position.copy(points.at(-1)!).add(new THREE.Vector3(0.1, 0.45, 0));
	group.add(endLabel);
	const nodes: THREE.Object3D[] = [];
	if (spec.label) {
		const caption = textMesh(textGeometry(spec.label, { font: 'body', size: 0.28, depth: 0.03, align: 'left' }), text);
		caption.position.set(-WIDTH / 2, HEIGHT + 0.9, 0);
		group.add(caption);
		nodes.push(caption);
	}
	if (spec.title) {
		const title = textMesh(textGeometry(spec.title, { font: 'display', size: 0.34, depth: 0.05, bevel: 0.01, align: 'left' }), text);
		title.position.set(-WIDTH / 2, HEIGHT + (spec.label ? 1.4 : 0.9), 0);
		group.add(title);
	}

	const draw = Math.min(2.4, spec.duration * 0.5);
	const center = new THREE.Vector3(0, HEIGHT * 0.62, 0);
	const distance = fitDistance(stage.camera, WIDTH + 1.2, HEIGHT + 1.8, 1.05);
	const tangent = new THREE.Vector3();

	return (t) => {
		const p = easeInOutCubic(phase(t, 0.3, draw));
		// drawRange theo bội số của một vòng ống (6 chỉ số × radial) để mép cắt thẳng.
		const ringStep = radial * 6;
		tube.geometry.setDrawRange(0, Math.floor((p * indexCount) / ringStep) * ringStep);
		curtain.geometry.setDrawRange(0, Math.floor((p * curtainCount) / 6) * 6);
		tube.visible = p > 0.002;
		const at = curve.getPointAt(Math.max(0.001, p));
		curve.getTangentAt(Math.max(0.001, p), tangent);
		head.position.copy(at);
		head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
		head.visible = p > 0.01 && p < 0.999;
		gems.forEach((gem, index) => {
			const reach = index / (values.length - 1);
			const pop = phase(t, 0.3 + reach * draw, 0.35);
			gem.scale.setScalar(easeOutBack(pop));
			gem.rotation.y = t * 1.5 + index;
			gem.visible = pop > 0;
		});
		const end = phase(t, 0.3 + draw, 0.4);
		endLabel.scale.setScalar(easeOutBack(end));
		endLabel.visible = end > 0;
		for (const node of nodes) node.visible = t > 0.2;
		const k = easeInOutCubic(phase(t, 0, spec.duration));
		orbit(stage.camera, center, -22 + 30 * k, 12 + 6 * k, distance * (1.1 - 0.1 * k));
	};
}
