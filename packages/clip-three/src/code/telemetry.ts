/**
 * Báo cáo bố cục của một khung cho agent: vật hay nhãn nào ra khỏi khung, và
 * khung có trống không. Ảnh cho model THẤY, báo cáo cho nó biết CHÍNH XÁC sửa
 * gì ("label 'HIGH GEAR' cut off at the top") — spike 01/10: chữ bị cắt là lỗi
 * hay gặp nhất mà model không tự nhận ra.
 */

import * as THREE from 'three';

import type { Stage } from '../studio.ts';

/** Lề an toàn trong toạ độ NDC (−1…1): 4% mỗi cạnh. */
const SAFE = 0.92;

export type FrameReport = {
	t: number;
	/** Mô tả tiếng Anh, mỗi mục một vật/nhãn lệch khung. */
	issues: string[];
	/** Phần khung mà cảnh chiếm (0–1, theo hộp bao chiếu lên màn hình). */
	coverage: number;
};

const side = (min: THREE.Vector2, max: THREE.Vector2): string[] => {
	const out: string[] = [];
	if (min.x < -SAFE) out.push('left');
	if (max.x > SAFE) out.push('right');
	if (max.y > SAFE) out.push('top');
	if (min.y < -SAFE) out.push('bottom');
	return out;
};

type Projection = { min: THREE.Vector2; max: THREE.Vector2 } | 'behind' | 'beyond' | null;

/** Hộp bao của một vật chiếu lên màn hình (NDC); 'behind' sau lưng camera, 'beyond' xa quá tầm nhìn. */
function projected(object: THREE.Object3D, camera: THREE.PerspectiveCamera): Projection {
	const box = new THREE.Box3().setFromObject(object, true);
	if (box.isEmpty()) return null;
	const min = new THREE.Vector2(Infinity, Infinity);
	const max = new THREE.Vector2(-Infinity, -Infinity);
	const point = new THREE.Vector3();
	const view = new THREE.Vector3();
	for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
		// Toạ độ camera: nhìn về −z. z ≥ 0 là sau lưng; −z > far là xa quá tầm (bị cắt).
		view.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
		if (view.z >= -camera.near) return 'behind';
		if (-view.z > camera.far) return 'beyond';
		point.set(x, y, z).project(camera);
		min.min(new THREE.Vector2(point.x, point.y));
		max.max(new THREE.Vector2(point.x, point.y));
	}
	return { min, max };
}

/** Số tam giác của cảnh (không phải của lượt vẽ cuối — lượt hậu kỳ chỉ vẽ một tam giác). */
export function sceneTriangles(root: THREE.Object3D): number {
	let total = 0;
	root.traverse((object) => {
		const mesh = object as THREE.Mesh;
		if (!mesh.isMesh || !mesh.visible) return;
		const geometry = mesh.geometry as THREE.BufferGeometry;
		const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
		total += Math.floor(count / 3) * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
	});
	return total;
}

/** Tên đọc được cho vật chưa đặt `name`: chữ thì theo nội dung, mesh theo hình, nhóm theo số con. */
function describe(object: THREE.Object3D, index: number): string {
	const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
	if (typeof geometry?.userData?.text === 'string') return `text "${geometry.userData.text}"`;
	if (geometry?.type) return `${geometry.type.replace(/Geometry$/, '').toLowerCase()} #${index + 1}`;
	if (object.children.length) return `group of ${object.children.length} #${index + 1}`;
	return `${object.type.toLowerCase()} #${index + 1}`;
}

/**
 * Nhãn bị vật khác che: hộp nhãn trên màn hình chồng lên hộp của một vật GẦN
 * camera hơn ("90 ▮GES" — nhãn đặt sau chồng giấy, 01/10).
 */
function hiddenLabels(stage: Stage): string[] {
	const out: string[] = [];
	const camera = stage.camera;
	const depth = (object: THREE.Object3D) => new THREE.Box3().setFromObject(object, true).getCenter(new THREE.Vector3()).applyMatrix4(camera.matrixWorldInverse).z;
	const labels = stage.root.children.filter((child) => child.visible && typeof child.userData.label === 'string');
	// So với TỪNG mesh, không với hộp của cả nhóm: nhãn trên cột thấp nằm trong hộp
	// của nhóm cột (vì có cột cao bên cạnh) nhưng không bị cột nào che.
	const meshes: { mesh: THREE.Mesh; owner: THREE.Object3D }[] = [];
	for (const child of stage.root.children) {
		if (!child.visible || typeof child.userData.label === 'string') continue;
		child.traverseVisible((object) => {
			if ((object as THREE.Mesh).isMesh) meshes.push({ mesh: object as THREE.Mesh, owner: child });
		});
	}
	for (const label of labels) {
		const box = projected(label, camera);
		if (!box || typeof box === 'string') continue;
		const area = (box.max.x - box.min.x) * (box.max.y - box.min.y);
		if (area <= 0) continue;
		const near = depth(label);
		const blocker = meshes.find(({ mesh }) => {
			const shape = projected(mesh, camera);
			if (!shape || typeof shape === 'string') return false;
			const overlap = Math.max(0, Math.min(box.max.x, shape.max.x) - Math.max(box.min.x, shape.min.x)) * Math.max(0, Math.min(box.max.y, shape.max.y) - Math.max(box.min.y, shape.min.y));
			// Toạ độ camera nhìn về −z: z lớn hơn là GẦN camera hơn.
			return overlap > area * 0.2 && depth(mesh) > near;
		});
		if (blocker) out.push(`label "${label.userData.label}" is partly hidden behind ${blocker.owner.name || 'another object'}: move it in front of or above it`);
	}
	return out;
}

export function frameReport(stage: Stage, t: number, final = false): FrameReport {
	stage.root.updateMatrixWorld(true);
	stage.camera.updateMatrixWorld(true);
	const issues: string[] = [];
	const all = { min: new THREE.Vector2(Infinity, Infinity), max: new THREE.Vector2(-Infinity, -Infinity) };
	stage.root.children.forEach((child, index) => {
		if (!child.visible) return;
		const box = projected(child, stage.camera);
		const name = child.name || describe(child, index);
		if (!box) return;
		if (box === 'behind') {
			issues.push(`${name} is behind the camera`);
			return;
		}
		if (box === 'beyond') {
			issues.push(`${name} is too far from the camera to be drawn (the scene is very large — make objects or labels smaller)`);
			return;
		}
		all.min.min(box.min);
		all.max.max(box.max);
		const sides = side(box.min, box.max);
		if (!sides.length) return;
		const outside = box.max.x < -1 || box.min.x > 1 || box.max.y < -1 || box.min.y > 1;
		issues.push(`${name} ${outside ? 'is outside the frame' : 'is cut off'} (${sides.join(', ')})`);
	});
	const width = Math.max(0, Math.min(1, all.max.x) - Math.max(-1, all.min.x)) / 2;
	const height = Math.max(0, Math.min(1, all.max.y) - Math.max(-1, all.min.y)) / 2;
	const coverage = Number.isFinite(width * height) ? Math.round(width * height * 100) / 100 : 0;
	if (coverage < 0.04) issues.push('the frame is nearly empty: frame the scene with kit.frame()');
	// Trạng thái cuối là thứ đứng lâu nhất trên màn hình: nhỏ quá là người xem trên
	// điện thoại không thấy gì (bản "sạch" đầu tiên của Gemini: cảnh ~5% khung).
	else if (final && coverage < 0.2) issues.push(`the scene fills only ${Math.round(coverage * 100)}% of the frame: make the subject bigger or use a smaller kit.frame padding`);
	issues.push(...hiddenLabels(stage));
	return { t, issues, coverage };
}
