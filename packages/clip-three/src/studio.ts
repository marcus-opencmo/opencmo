/**
 * Phông "studio" chung của mọi template: môi trường phản chiếu (RoomEnvironment),
 * đèn key + rim, bóng đổ mềm, sàn mờ dần vào nền gradient, ACES tone mapping,
 * bloom nhẹ cho phần phát sáng. Template chỉ đặt vật và viết hàm `update(t)`.
 *
 * Mọi thứ là hàm của (spec, t): không đồng hồ, không Math.random — render lại
 * một khung bất kỳ ra đúng hình đó (khoá cache là hash spec).
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { FontLoader, type Font } from 'three/examples/jsm/loaders/FontLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import inter from './fonts/inter-600.json';
import montserrat from './fonts/montserrat-800.json';
import type { SceneSpec, Theme } from './spec.ts';

export type Palette = { top: string; bottom: string; floor: string; text: string; muted: string; colors: string[]; accent: string };

export const THEME_PALETTES: Record<Theme, Palette> = {
	midnight: { top: '#070B18', bottom: '#1A2447', floor: '#0D1430', text: '#F8FAFC', muted: '#94A3B8', colors: ['#38BDF8', '#818CF8', '#F472B6', '#34D399', '#FBBF24', '#FB7185'], accent: '#38BDF8' },
	aurora: { top: '#03110F', bottom: '#0B3A36', floor: '#06221F', text: '#ECFEFF', muted: '#99F6E4', colors: ['#2DD4BF', '#34D399', '#A3E635', '#22D3EE', '#818CF8', '#F0ABFC'], accent: '#2DD4BF' },
	sunset: { top: '#12040F', bottom: '#4A1733', floor: '#2A0C1E', text: '#FFF7ED', muted: '#FDBA74', colors: ['#FB923C', '#F472B6', '#FACC15', '#F87171', '#C084FC', '#FDE68A'], accent: '#FB923C' },
	mono: { top: '#050505', bottom: '#27272A', floor: '#111113', text: '#FAFAFA', muted: '#A1A1AA', colors: ['#FAFAFA', '#D4D4D8', '#A1A1AA', '#71717A', '#E4E4E7', '#52525B'], accent: '#FAFAFA' },
};

/** Trộn hai màu hex (t = 0 → a, 1 → b). */
function mix(a: string, b: string, t: number): string {
	return `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
}

/**
 * Bảng màu từ Brand Kit: nền gradient tối dần từ màu nền của kit (sàn, trần
 * sâu hơn để vật nổi), chữ của kit, bảng màu = màu kit rồi các sắc nhạt/đậm của
 * chúng (cột thứ 4–6 không lặp màu nhấn của cột nổi bật).
 */
export function brandPalette(brand: NonNullable<SceneSpec['brand']>): Palette {
	const [accent, ...rest] = brand.colors as [string, ...string[]];
	const base = rest.length ? rest : [mix(accent, '#ffffff', 0.35)];
	const colors = [accent, ...base, ...base.map((color) => mix(color, '#ffffff', 0.3)), ...base.map((color) => mix(color, '#000000', 0.25))].slice(0, 6);
	return {
		top: mix(brand.background, '#000000', 0.45),
		bottom: mix(brand.background, '#ffffff', 0.1),
		floor: mix(brand.background, '#000000', 0.2),
		text: brand.text,
		muted: mix(brand.text, brand.background, 0.45),
		colors,
		accent,
	};
}

// ---------- thời gian ----------

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** Tiến độ 0→1 của khoảng [start, start + length]. */
export const phase = (t: number, start: number, length: number): number => clamp01((t - start) / Math.max(1e-6, length));
export const easeOutCubic = (x: number): number => 1 - (1 - x) ** 3;
export const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutExpo = (x: number): number => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export const easeOutBack = (x: number): number => {
	const c1 = 1.4;
	return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

/** PRNG có seed (mulberry32) — hạt, lệch nhỏ đều lặp lại được. */
export function rng(seed: number): () => number {
	let a = seed >>> 0 || 1;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------- chữ ----------

const loader = new FontLoader();
export const FONTS: { display: Font; body: Font } = { display: loader.parse(montserrat as never), body: loader.parse(inter as never) };

const textCache = new Map<string, THREE.BufferGeometry>();

/** Font tiêu đề của Brand Kit (typeface JSON dựng ở Node, `brand-font.ts`); null = Montserrat. */
export function useDisplayFont(typeface: unknown | null): void {
	FONTS.display = loader.parse((typeface ?? montserrat) as never);
	textCache.clear();
}

/** Layer của chữ (không phản chiếu xuống sàn). */
export const TEXT_LAYER = 1;

/** Mesh chữ: ở layer riêng, đổ bóng. */
export function textMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
	const mesh = new THREE.Mesh(geometry, material);
	mesh.layers.set(TEXT_LAYER);
	mesh.castShadow = true;
	return mesh;
}

/**
 * Chữ 3D đùn khối, căn theo `align` (tâm ngang, đáy ở y = 0). Hình học cache
 * theo nội dung: số đếm lên đổi chữ mỗi khung nhưng chỉ có vài chục chuỗi khác nhau.
 */
export function textGeometry(text: string, options: { font?: keyof typeof FONTS; size: number; depth: number; bevel?: number; align?: 'center' | 'left' | 'right' }): THREE.BufferGeometry {
	const key = `${options.font ?? 'display'}|${options.size}|${options.depth}|${options.bevel ?? 0}|${options.align ?? 'center'}|${text}`;
	let geometry = textCache.get(key);
	if (geometry) return geometry;
	const bevel = options.bevel ?? 0;
	geometry = new TextGeometry(text || ' ', {
		font: FONTS[options.font ?? 'display'],
		size: options.size,
		depth: options.depth,
		curveSegments: 10,
		bevelEnabled: bevel > 0,
		bevelThickness: bevel,
		bevelSize: bevel * 0.6,
		bevelSegments: 4,
	});
	geometry.computeBoundingBox();
	const box = geometry.boundingBox!;
	const width = box.max.x - box.min.x;
	const x = options.align === 'left' ? -box.min.x : options.align === 'right' ? -box.max.x : -box.min.x - width / 2;
	geometry.translate(x, -box.min.y, -options.depth / 2);
	// Báo cáo bố cục của cảnh code gọi tên vật theo chữ của nó ("text \"90 PAGES\"").
	geometry.userData.text = text;
	textCache.set(key, geometry);
	return geometry;
}

// ---------- sân khấu ----------

export type Stage = {
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	renderer: THREE.WebGLRenderer;
	palette: Palette;
	accent: THREE.Color;
	random: () => number;
	/** Nhóm chứa nội dung của template (sàn/đèn nằm ngoài). */
	root: THREE.Group;
	key: THREE.DirectionalLight;
	render: (t?: number) => void;
};

/**
 * Canvas 2D cho texture vẽ tay. OffscreenCanvas khi có: cùng code chạy cả trong
 * trang Chromium của server lẫn Web Worker của preview trong editor (worker
 * không có `document`).
 */
export function canvas2d(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function gradientTexture(top: string, bottom: string): THREE.Texture {
	const canvas = canvas2d(4, 512);
	const ctx = canvas.getContext('2d')! as CanvasRenderingContext2D;
	const gradient = ctx.createLinearGradient(0, 0, 0, 512);
	gradient.addColorStop(0, top);
	gradient.addColorStop(1, bottom);
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 4, 512);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

/** Sàn tròn mờ dần: nhận bóng, phản chiếu nhẹ môi trường, không có mép cứng. */
function floor(palette: Palette): THREE.Mesh {
	const canvas = canvas2d(256, 256);
	const ctx = canvas.getContext('2d')! as CanvasRenderingContext2D;
	const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
	gradient.addColorStop(0, '#ffffff');
	gradient.addColorStop(0.55, '#8a8a8a');
	gradient.addColorStop(1, '#000000');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 256, 256);
	const alpha = new THREE.CanvasTexture(canvas);
	const mesh = new THREE.Mesh(
		new THREE.CircleGeometry(14, 96),
		new THREE.MeshStandardMaterial({ color: palette.floor, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.9, alphaMap: alpha, envMapIntensity: 0.08 }),
	);
	mesh.rotation.x = -Math.PI / 2;
	mesh.receiveShadow = true;
	return mesh;
}

/**
 * Bụi sáng lơ lửng phía sau (bokeh): chiều sâu cho nền trống. Cố định theo
 * seed; trôi theo thời gian qua `userData.update(t)`.
 */
function dust(palette: Palette, random: () => number): THREE.Points {
	const count = 140;
	const positions = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		positions[i * 3] = (random() - 0.5) * 26;
		positions[i * 3 + 1] = random() * 10 + 0.5;
		positions[i * 3 + 2] = -4 - random() * 14;
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	const canvas = canvas2d(64, 64);
	const ctx = canvas.getContext('2d')! as CanvasRenderingContext2D;
	const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
	gradient.addColorStop(0, 'rgba(255,255,255,1)');
	gradient.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 64, 64);
	const points = new THREE.Points(
		geometry,
		new THREE.PointsMaterial({ color: palette.muted, size: 0.16, map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
	);
	points.name = 'dust';
	return points;
}

/** Template có đường mảnh trên sàn (rise): phản chiếu nhân đôi đường, rối mắt. */
const NO_MIRROR = new Set(['rise']);

export function createStage(canvas: HTMLCanvasElement | OffscreenCanvas, spec: SceneSpec): Stage {
	const palette = spec.brand ? brandPalette(spec.brand) : THEME_PALETTES[spec.theme ?? 'midnight'];
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(1);
	renderer.setSize(spec.width, spec.height, false);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	// Neutral giữ độ bão hoà màu thương hiệu; ACES làm màu cột bạc thành pastel.
	renderer.toneMapping = THREE.NeutralToneMapping;
	renderer.toneMappingExposure = 1;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.VSMShadowMap;

	const scene = new THREE.Scene();
	scene.background = gradientTexture(palette.top, palette.bottom);
	// Nền là màu thiết kế, không phải vật được chiếu sáng: bỏ qua tone mapping.
	scene.backgroundIntensity = 1;
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
	scene.environmentIntensity = 0.45;

	const camera = new THREE.PerspectiveCamera(30, spec.width / spec.height, 0.1, 200);
	// Chữ ở layer riêng: camera chính thấy, camera ảo của sàn gương thì không —
	// chữ lật ngược dưới sàn làm rối số liệu.
	camera.layers.enable(TEXT_LAYER);

	const key = new THREE.DirectionalLight('#ffffff', 1.25);
	key.position.set(5, 9, 6);
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.radius = 8;
	key.shadow.blurSamples = 16;
	key.shadow.bias = -0.0004;
	const box = key.shadow.camera as THREE.OrthographicCamera;
	box.left = box.bottom = -8;
	box.right = box.top = 8;
	box.near = 1;
	box.far = 30;
	const accent = new THREE.Color(spec.accent ?? palette.accent);
	const rim = new THREE.DirectionalLight(accent, 1.3);
	rim.position.set(-7, 4, -6);
	const fill = new THREE.HemisphereLight('#ffffff', palette.floor, 0.2);
	// Sàn gương dưới lớp sàn mờ: vật in bóng phản chiếu nhạt xuống sàn — dấu hiệu
	// của cảnh "studio" mà Canvas 2D không làm được.
	const mirror = new Reflector(new THREE.CircleGeometry(9, 96), { textureWidth: Math.round(spec.width / 2), textureHeight: Math.round(spec.height / 2), color: 0xffffff });
	mirror.rotation.x = -Math.PI / 2;
	mirror.position.y = 0.002;
	// Shader gốc ghi alpha = 1 và trộn overlay: sửa thành lớp trong suốt mờ dần
	// theo bán kính — phản chiếu chỉ gợi ý dưới chân vật, không có mép cứng.
	const material = mirror.material as THREE.ShaderMaterial;
	material.transparent = true;
	material.depthWrite = false;
	material.vertexShader = material.vertexShader.replace('varying vec4 vUv;', 'varying vec4 vUv;\nvarying vec2 vLocal;').replace('vUv = textureMatrix', 'vLocal = position.xy;\n\t\t\tvUv = textureMatrix');
	material.fragmentShader = material.fragmentShader
		.replace('varying vec4 vUv;', 'varying vec4 vUv;\nvarying vec2 vLocal;')
		.replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );', 'gl_FragColor = vec4( base.rgb, 0.13 * (1.0 - smoothstep(1.5, 6.5, length(vLocal))) );');
	mirror.renderOrder = 1;
	// Camera ảo của gương là bản clone camera chính (kể cả layer): tắt layer chữ trên nó.
	(mirror as unknown as { getReflectionCamera: (c: THREE.Camera) => THREE.Camera }).getReflectionCamera(camera).layers.disable(TEXT_LAYER);
	scene.add(key, rim, fill, floor(palette), dust(palette, rng((spec.seed ?? 7) + 1)));
	if (!NO_MIRROR.has(spec.template)) scene.add(mirror);

	const root = new THREE.Group();
	scene.add(root);

	// MSAA trên render target của composer: bloom cần HDR, canvas thì không khử răng cưa được.
	const target = new THREE.WebGLRenderTarget(spec.width, spec.height, { type: THREE.HalfFloatType, samples: 4 });
	const composer = new EffectComposer(renderer, target);
	composer.addPass(new RenderPass(scene, camera));
	// Ngưỡng cao: chỉ vật phát sáng (emissive) nở; chữ trắng và sàn sáng không được nhoè.
	composer.addPass(new UnrealBloomPass(new THREE.Vector2(spec.width, spec.height), 0.5, 0.45, 1.25));
	composer.addPass(new OutputPass());

	const drift = scene.getObjectByName('dust')!;
	return {
		scene,
		camera,
		renderer,
		palette,
		accent,
		random: rng(spec.seed ?? 7),
		root,
		key,
		render: (t = 0) => {
			drift.position.set(Math.sin(t * 0.3) * 0.4, t * 0.08, 0);
			composer.render();
		},
	};
}

/** Vật liệu bóng kiểu sản phẩm: sơn có lớp clearcoat, phản chiếu môi trường. */
export function glossy(color: THREE.ColorRepresentation, options: { metalness?: number; roughness?: number; emissive?: number } = {}): THREE.MeshPhysicalMaterial {
	const material = new THREE.MeshPhysicalMaterial({
		color,
		metalness: options.metalness ?? 0.15,
		roughness: options.roughness ?? 0.28,
		clearcoat: 1,
		clearcoatRoughness: 0.12,
		envMapIntensity: 0.55,
	});
	if (options.emissive) {
		material.emissive = new THREE.Color(color);
		material.emissiveIntensity = options.emissive;
	}
	return material;
}

/** Kim loại đánh bóng (vàng, chrome). */
export const metal = (color: THREE.ColorRepresentation, roughness = 0.18): THREE.MeshPhysicalMaterial =>
	new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness, clearcoat: 0.6, clearcoatRoughness: 0.1 });

/** Đặt camera nhìn vào `target` từ góc (yaw, pitch độ) ở khoảng cách `distance`. */
export function orbit(camera: THREE.PerspectiveCamera, target: THREE.Vector3, yaw: number, pitch: number, distance: number): void {
	const y = THREE.MathUtils.degToRad(yaw);
	const p = THREE.MathUtils.degToRad(pitch);
	camera.position.set(target.x + Math.sin(y) * Math.cos(p) * distance, target.y + Math.sin(p) * distance, target.z + Math.cos(y) * Math.cos(p) * distance);
	camera.lookAt(target);
}

/**
 * Khoảng cách camera để hộp rộng `width` × cao `height` vừa khung (theo fov dọc
 * và tỉ lệ khung) — cảnh dọc 9:16 và vuông dùng chung template.
 */
export function fitDistance(camera: THREE.PerspectiveCamera, width: number, height: number, margin = 1.15): number {
	const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
	const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
	return Math.max((height * margin) / 2 / Math.tan(vertical), (width * margin) / 2 / Math.tan(horizontal));
}
