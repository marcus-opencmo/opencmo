import * as THREE from "three";

import type { SocialKey } from "./icons";

/**
 * Cảnh 3D của hero: trời sao + đồ thị AI CMO → ba department → các nền tảng. Cuộn tới
 * đâu, các cạnh của đồ thị nối tới đó (`progress` 0 → 1), camera lùi dần về giữa.
 *
 * Không React ở đây: hero gọi `frame(progress)` mỗi khung hình và nhận lại toạ độ màn
 * hình của từng nút để đặt nhãn HTML (nhãn là chữ thật, sắc ở mọi DPI).
 */

export type NodeKey = "cmo" | "video" | "post" | "sales" | SocialKey;

export const KIDS: Record<"video" | "post" | "sales", SocialKey[]> = {
  video: ["tiktok", "instagram", "youtubeshorts"],
  post: ["x", "linkedin", "threads", "facebook"],
  sales: ["reddit", "ycombinator", "quora", "youtube", "indiehackers"],
};

const NODES: Partial<Record<NodeKey, [number, number, number]>> = {
  cmo: [0, 3.4, 0], video: [-4.4, 0.2, 0], post: [0, -0.8, 0.6], sales: [4.4, 0.2, 0],
  tiktok: [-7.6, -1.2, 0.4], instagram: [-7.0, 1.9, 0.6], youtubeshorts: [-5.6, -3.2, 0.2],
  x: [-2.2, -3.4, 0.9], linkedin: [-0.7, -4.4, 0.5], threads: [0.9, -3.6, 0.9], facebook: [2.3, -4.4, 0.3],
  reddit: [7.6, -1.0, 0.3], ycombinator: [6.9, 2.1, 0.2], quora: [5.4, -3.4, 0.6], youtube: [8.0, 0.6, 0.5], indiehackers: [3.9, -3.0, 0.4],
};

const SEGS: [NodeKey, NodeKey][] = [
  ["cmo", "video"], ["cmo", "post"], ["cmo", "sales"], ["video", "post"], ["post", "sales"],
  ...Object.entries(KIDS).flatMap(([d, ks]) => ks.map((k) => [d as NodeKey, k] as [NodeKey, NodeKey])),
];

export type LabelDef = { key: NodeKey; kind: "cmo" | "dept" | "plat"; from: number; dy: number };

/** Lúc mỗi nhãn hiện (theo progress) và độ lệch xuống dưới nút sáng. */
export const LABELS: LabelDef[] = [
  { key: "cmo", kind: "cmo", from: 0.06, dy: 38 },
  { key: "video", kind: "dept", from: 0.18, dy: 30 },
  { key: "post", kind: "dept", from: 0.22, dy: 30 },
  { key: "sales", kind: "dept", from: 0.26, dy: 30 },
  ...Object.values(KIDS).flat().map((k, i): LabelDef => ({ key: k, kind: "plat", from: 0.32 + i * 0.022, dy: 22 })),
];

export const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function dotTexture(soft: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(soft ? 0.15 : 0.25, "rgba(255,255,255,.8)");
  gr.addColorStop(0.5, "rgba(255,255,255,.12)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type HeroGraph = {
  resize(): void;
  /** Vẽ một khung; trả toạ độ màn hình (px) của từng nút đã chiếu, `null` nếu nút sau camera. */
  frame(progress: number, pointer: { x: number; y: number }, t: number): Map<NodeKey, { x: number; y: number } | null>;
  dispose(): void;
};

export function createHeroGraph(canvas: HTMLCanvasElement): HeroGraph | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    // Không có WebGL: hero vẫn còn chữ, nền và nhãn tĩnh; chỉ mất đồ thị.
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x070b1c, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070b1c, 0.006);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1200);
  const dot = dotTexture(false);
  const soft = dotTexture(true);
  const disposables: { dispose(): void }[] = [dot, soft];

  const stars = (n: number, fn: () => [number, number, number], size: number, opacity: number) => {
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const pal = [0xf6efda, 0xffffff, 0xb7c3ff, 0xf2946f, 0xffd9b8];
    for (let i = 0; i < n; i++) {
      pos.set(fn(), i * 3);
      c.setHex(pal[Math.random() < 0.7 ? (Math.random() < 0.5 ? 0 : 1) : 2 + Math.floor(Math.random() * 3)]);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size, map: dot, vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false });
    disposables.push(geo, m);
    return new THREE.Points(geo, m);
  };
  const shell = (): [number, number, number] => {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, rr = 160 + Math.random() * 220, s = Math.sqrt(1 - u * u);
    return [rr * s * Math.cos(th), Math.abs(rr * u) * 0.9 - 20, rr * s * Math.sin(th)];
  };
  const sky = new THREE.Group();
  sky.add(stars(5200, shell, 1.6, 0.95));
  const band = stars(6500, () => {
    const a = Math.random() * Math.PI * 2, rr = 200 + Math.random() * 120, h = (Math.random() + Math.random() + Math.random() - 1.5) * 26;
    return [rr * Math.cos(a), rr * Math.sin(a) * 0.55 + h + 60, -Math.abs(rr * Math.sin(a)) * 0.8 - 40 + h];
  }, 1.2, 0.55);
  band.rotation.z = 0.5;
  sky.add(band);
  for (const [col, x, y, z, s, o] of [[0x2a3a9a, -120, 110, -260, 260, 0.35], [0xb4512f, 140, 70, -240, 220, 0.22], [0x3a2a6a, 30, 170, -300, 300, 0.3], [0x7088ff, -40, 40, -200, 160, 0.12]]) {
    const m = new THREE.SpriteMaterial({ map: soft, color: col, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    disposables.push(m);
    const sp = new THREE.Sprite(m);
    sp.position.set(x, y, z);
    sp.scale.set(s, s, 1);
    sky.add(sp);
  }
  scene.add(sky);

  const graph = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEGS.length * 6), 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0xf2c9a6, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  disposables.push(lineGeo, lineMat);
  graph.add(new THREE.LineSegments(lineGeo, lineMat));
  const sprites = new Map<NodeKey, { sp: THREE.Sprite; big: number }>();
  for (const [k, v] of Object.entries(NODES) as [NodeKey, [number, number, number]][]) {
    const big = k === "cmo" ? 2.6 : k === "video" || k === "post" || k === "sales" ? 1.5 : 0.9;
    const m = new THREE.SpriteMaterial({ map: dot, color: k === "cmo" ? 0xf2946f : 0xf6efda, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    disposables.push(m);
    const sp = new THREE.Sprite(m);
    sp.position.set(...v);
    sp.scale.set(big, big, 1);
    graph.add(sp);
    sprites.set(k, { sp, big });
  }
  scene.add(graph);

  let vw = 1, vh = 1;
  const v3 = new THREE.Vector3();
  const out = new Map<NodeKey, { x: number; y: number } | null>();

  return {
    resize() {
      vw = canvas.clientWidth || 1;
      vh = canvas.clientHeight || 1;
      renderer.setSize(vw, vh, false);
      camera.aspect = vw / vh;
      camera.updateProjectionMatrix();
    },
    frame(p, ptr, t) {
      const e = ease(ss(0, 1, p));
      const k = ss(0.05, 0.62, p);
      camera.position.set(lerp(-3, 2.2, e) + ptr.x * 0.9, lerp(2.5, -0.5, e) - ptr.y * 0.5, lerp(30, 16.5, e));
      camera.lookAt(ptr.x * 0.3, lerp(1.2, -0.2, e), 0);
      sky.rotation.y = t * 0.006 + p * 0.25;

      const a = lineGeo.attributes.position as THREE.BufferAttribute;
      const S = SEGS.length;
      SEGS.forEach(([f, to], i) => {
        const tt = Math.min(1, Math.max(0, k * S - i)), A = NODES[f]!, B = NODES[to]!;
        a.setXYZ(i * 2, ...A);
        a.setXYZ(i * 2 + 1, lerp(A[0], B[0], tt), lerp(A[1], B[1], tt), lerp(A[2], B[2], tt));
      });
      a.needsUpdate = true;

      let i = 0;
      for (const [key, { sp, big }] of sprites) {
        const tw = 0.85 + 0.15 * Math.sin(t * 2.2 + i * 1.7);
        const on = key === "cmo" ? ss(0, 0.08, k + 0.04) : Math.min(1, k * 1.6 + 0.25);
        const s = big * tw * (0.4 + 0.6 * on) * (key === "cmo" ? 1 + 0.12 * Math.sin(t * 1.4) : 1);
        sp.scale.set(s, s, 1);
        sp.material.opacity = 0.3 + 0.7 * on;
        i++;
      }
      renderer.render(scene, camera);

      for (const [key, pos] of Object.entries(NODES) as [NodeKey, [number, number, number]][]) {
        const v = v3.set(...pos).project(camera);
        out.set(key, v.z > 1 ? null : { x: (v.x * 0.5 + 0.5) * vw, y: (-v.y * 0.5 + 0.5) * vh });
      }
      return out;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    },
  };
}
