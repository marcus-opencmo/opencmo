"use client";

/**
 * Tương tác trên canvas (checklist CNV-01/02/03/05/07): lớp SVG phủ lên canvas
 * vẽ preview, toạ độ màn hình.
 *
 * Luật lấy từ hành vi của fork, không từ mã của nó:
 * - Bấm chọn node trên cùng dưới con trỏ, trong "tầng" đang mở: ban đầu là con
 *   của scene (sequence thì nhìn xuyên qua); nhấp đúp vào group/scene lồng thì
 *   mở tầng của nó. Shift thêm/bớt. Bấm chỗ trống bỏ chọn và ra tầng ngoài.
 * - Kéo trên chỗ trống là marquee: chọn mọi node của tầng có hộp chạm vùng kéo.
 * - Kéo node là dời cả lựa chọn, dính vào mép/tâm scene và node khác (đường
 *   gióng); nhích tính từ chỗ node đang vẽ, có track x/y thì ghi keyframe.
 * - Tay nắm 8 hướng đổi cỡ một node (mép đối diện đứng yên; góc + Shift, hay
 *   node giữ tỉ lệ, thì giữ tỉ lệ); ngay ngoài góc là xoay quanh tâm (Shift nấc 15°).
 * - Chọn nhiều node: tay nắm trên hộp bao cả nhóm, co giãn mọi node quanh tay
 *   nắm đối diện (Alt: quanh tâm); giữ tỉ lệ khi Shift hoặc mọi node giữ tỉ lệ.
 * - Kéo node vào một scene lồng và đứng yên 250 ms: thả là node chuyển vào
 *   scene đó (ra chỗ trống thì về scene đang mở), đứng yên trên màn hình.
 * - Rect (R) / Text (T): kéo để vẽ, bấm để đặt cỡ mặc định; xong về Move. Text
 *   đặt xong thì ô chữ của inspector nhận focus để gõ luôn.
 * - Tên scene trên đầu khung; nhấp đúp để đổi tên tại chỗ (HUD).
 * - Phụ đề: hộp là vùng chữ đang hiện (đo bằng canvas), kéo là đổi
 *   `offsetX`/`offsetY` (phụ đề không có x/y), kéo góc là đổi `fontScale`.
 * Kéo/đổi cỡ/xoay là bản xem trước; thả tay mới ghi — một bước Undo.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ClipDocument } from "@opencmo/clip-doc";
import { CAPTION_SCALE_MAX, CAPTION_SCALE_MIN } from "@opencmo/clip-doc";
import { multiply, type LayoutBox, type Measurer, type Renderer } from "@opencmo/clip-render";
import { activeScene, walk, type Entity } from "@opencmo/editor-core";

import type { Tool } from "../actions";
import type { Camera } from "../camera";

const FPS = 30;
const SNAP = 6;
const HANDLE = 8;
const ROTATE_ZONE = 18;
const CLICK = 4;
const DROP_DWELL_MS = 250;
const PICKABLE = new Set(["rect", "path", "scene3d", "lottie", "text", "video", "image", "group", "captions", "scene", "adjustmentLayer"]);
const RESIZABLE = new Set(["rect", "path", "scene3d", "lottie", "text", "video", "image", "scene", "adjustmentLayer", "group", "captions"]);
/** Phụ đề chỉ đổi cỡ theo tỉ lệ (`fontScale`): tay nắm góc, không có tay nắm cạnh. */
const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];

let measurer: Measurer | null | undefined;
/**
 * Canvas đo chữ cho `layout()`: không có nó thì hộp phụ đề là hộp preset cố
 * định (chữ thật tràn ra ngoài, bấm vào chữ không trúng) và chữ không ghi cỡ
 * thì hộp 0×0. Font đã nạp vào document nên đo khớp với preview.
 */
function textMeasurer(): Measurer | undefined {
  if (measurer === undefined) measurer = (document.createElement("canvas").getContext("2d") as unknown as Measurer | null) ?? null;
  return measurer ?? undefined;
}

type Point = { x: number; y: number };
type Mat = [number, number, number, number, number, number];
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Record<Handle, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};

const apply = (m: Mat, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const corners = (box: LayoutBox): Point[] => {
  const [ox, oy, w, h] = box.box;
  return [
    { x: ox, y: oy },
    { x: ox + w, y: oy },
    { x: ox + w, y: oy + h },
    { x: ox, y: oy + h },
  ].map((p) => apply(box.matrix as Mat, p));
};
const aabb = (points: Point[]) => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});
type Box = ReturnType<typeof aabb>;
const inside = (box: LayoutBox, p: Point) => {
  const [ox, oy, w, h] = box.box;
  const local = apply(invert(box.matrix as Mat), p);
  return local.x >= ox && local.x <= ox + w && local.y >= oy && local.y <= oy + h;
};

/** Ghi x/y/… của một node: có track thì keyframe ở playhead, không thì prop. */
function writes(entity: Entity, box: LayoutBox, props: Record<string, number>): unknown[] {
  const tracks = new Set(((entity.tracks as Entity[] | undefined) ?? []).map((track) => track.property as string));
  const plain: Record<string, number | null> = {};
  const ops: unknown[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (tracks.has(key)) ops.push({ op: "set_keyframe", element_id: entity.id, property: key, time: box.localFrame / FPS, value });
    else plain[key] = value === 0 && (key === "x" || key === "y" || key === "rotation") ? null : value;
  }
  if (Object.keys(plain).length) ops.unshift({ op: "set_props", element_id: entity.id, props: plain });
  return ops;
}

function nextName(document: ClipDocument, prefix: string): string {
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  walk(document, ({ entity }) => {
    const match = typeof entity.name === "string" ? pattern.exec(entity.name) : null;
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `${prefix} ${max + 1}`;
}

type Gesture =
  | { kind: "move"; start: Point; ids: string[]; from: Map<string, LayoutBox>; union: Box; moved: boolean }
  | { kind: "resize"; id: string; handle: Handle; box: LayoutBox; ratio: boolean; fontScale: number }
  | { kind: "resize-many"; handle: Handle; start: Point; ids: string[]; from: Map<string, LayoutBox>; union: Box; ratio: boolean }
  | { kind: "rotate"; id: string; box: LayoutBox; center: Point; angle: number }
  | { kind: "marquee"; start: Point; now: Point; extend: string[] }
  | { kind: "draw"; tool: "rect" | "text" | "scene"; start: Point; now: Point };

export function CanvasOverlay({
  doc,
  renderer,
  frame,
  camera,
  tool,
  selection,
  onSelect,
  onTool,
  edit,
  run,
  spaceHeld,
  others = [],
  pending,
}: {
  doc: ClipDocument;
  renderer: Renderer | null;
  frame: number;
  camera: Camera;
  tool: Tool;
  selection: string[];
  onSelect: (ids: string[]) => void;
  onTool: (tool: Tool) => void;
  /** `preview`: chỉ vẽ thử, chưa ghi. */
  edit: (ops: unknown[], options?: { preview?: boolean }) => void;
  run: (ops: unknown[]) => Promise<ClipDocument | null>;
  spaceHeld: () => boolean;
  /** Scene cấp stage khác: tên của chúng trên canvas, bấm để mở. */
  others?: { id: string; name: string; dx: number; dy: number }[];
  /** Node đang chờ media sinh ra → nhãn hiện trên hộp của nó (chỉ preview, không vào export). */
  pending?: (entity: Entity) => string | null;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [entered, setEntered] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [renaming, setRenaming] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  // Scene đích khi kéo: ứng viên dưới con trỏ + lúc bắt đầu đứng trên nó.
  const drop = useRef<{ id: string | null; since: number }>({ id: null, since: 0 });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (dwell.current && clearTimeout(dwell.current)), []);

  const scene = activeScene(doc) as unknown as Entity;
  const boxes = useMemo(() => {
    const map = new Map<string, LayoutBox>();
    for (const box of renderer?.layout(frame, textMeasurer()) ?? []) if (typeof box.node.id === "string") map.set(box.node.id, box);
    return map;
    // `doc` đổi mà renderer chưa dựng lại thì hộp vẫn của cây cũ — renderer đi theo doc.
  }, [renderer, frame]);
  const { entities, parents } = useMemo(() => {
    const map = new Map<string, Entity>();
    const up = new Map<string, Entity>();
    walk(doc, ({ entity, tag, parent }) => {
      if (typeof entity.id === "string" && entity.kind === tag) {
        map.set(entity.id, entity);
        if (parent) up.set(entity.id, parent);
      }
    });
    return { entities: map, parents: up };
  }, [doc]);
  /** Scene gần nhất chứa node (bỏ qua group/sequence). */
  const sceneOf = (id: string): string | null => {
    for (let at = parents.get(id); at; at = typeof at.id === "string" ? parents.get(at.id) : undefined) {
      if (at.kind === "scene") return (at.id as string | undefined) ?? null;
    }
    return null;
  };

  // Tầng đang mở: con của nó (xuyên qua sequence) là thứ bấm trúng được.
  const level = (entered && entities.get(entered)) || scene;
  const pickable = useMemo(() => {
    const out: Entity[] = [];
    const visit = (entity: Entity) => {
      for (const child of (entity.children as Entity[] | undefined) ?? []) {
        if (child.hidden) continue;
        if (child.kind === "sequence") visit(child);
        else if (PICKABLE.has(child.kind as string) && typeof child.id === "string" && boxes.get(child.id)?.visible) out.push(child);
      }
    };
    visit(level);
    return out;
  }, [level, boxes]);

  const toScene = (event: { clientX: number; clientY: number }): Point => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left - camera.x) / camera.scale, y: (event.clientY - rect.top - camera.y) / camera.scale };
  };
  const toScreen = (p: Point): Point => ({ x: camera.x + p.x * camera.scale, y: camera.y + p.y * camera.scale });

  const hit = (p: Point): Entity | null => {
    for (let index = pickable.length - 1; index >= 0; index--) {
      const box = boxes.get(pickable[index]!.id as string);
      if (box && inside(box, p)) return pickable[index]!;
    }
    return null;
  };

  const selected = selection.filter((id) => boxes.has(id) && id !== scene.id);
  const single = selected.length === 1 ? selected[0]! : null;
  const singleBox = single ? boxes.get(single) : undefined;
  const singleEntity = single ? entities.get(single) : undefined;

  /** Hướng tay nắm (hoặc vùng xoay) dưới con trỏ, với một node đang chọn. */
  const many = selected.length > 1 ? aabb(selected.flatMap((id) => corners(boxes.get(id)!))) : null;

  const handleAt = (p: Point): { resize?: Handle; rotate?: boolean } | null => {
    if (many) {
      const tolerance = HANDLE / camera.scale;
      for (const [name, [fx, fy]] of Object.entries(HANDLES) as [Handle, [number, number]][]) {
        const hx = many.minX + ((fx + 1) / 2) * (many.maxX - many.minX);
        const hy = many.minY + ((fy + 1) / 2) * (many.maxY - many.minY);
        if (Math.abs(p.x - hx) <= tolerance && Math.abs(p.y - hy) <= tolerance) return { resize: name };
      }
      return null;
    }
    if (!singleBox || !singleEntity) return null;
    const [ox, oy, w, h] = singleBox.box;
    const local = apply(invert(singleBox.matrix as Mat), p);
    const scale = Math.hypot(singleBox.matrix[0], singleBox.matrix[1]) * camera.scale || 1;
    const tolerance = HANDLE / scale;
    if (RESIZABLE.has(singleEntity.kind as string)) {
      for (const [name, [fx, fy]] of Object.entries(HANDLES) as [Handle, [number, number]][]) {
        if (singleEntity.kind === "captions" && !CORNERS.includes(name)) continue;
        const hx = ox + ((fx + 1) / 2) * w;
        const hy = oy + ((fy + 1) / 2) * h;
        if (Math.abs(local.x - hx) <= tolerance && Math.abs(local.y - hy) <= tolerance) return { resize: name };
      }
    }
    const zone = ROTATE_ZONE / scale;
    const outside = local.x < ox || local.x > ox + w || local.y < oy || local.y > oy + h;
    const nearCorner = [ox, ox + w].some((cx) => Math.abs(local.x - cx) <= zone) && [oy, oy + h].some((cy) => Math.abs(local.y - cy) <= zone);
    if (outside && nearCorner && singleEntity.kind !== "captions") return { rotate: true };
    return null;
  };

  // ------------------------------------------------------------------ cử chỉ

  /** Mép/tâm của scene và node khác (trừ `ids`) để dính vào. */
  const snapTargets = (ids: string[]) => {
    const targetsX = [0, (scene.width as number) / 2, scene.width as number];
    const targetsY = [0, (scene.height as number) / 2, scene.height as number];
    for (const other of pickable) {
      if (ids.includes(other.id as string)) continue;
      const box = boxes.get(other.id as string);
      if (!box) continue;
      const b = aabb(corners(box));
      targetsX.push(b.minX, (b.minX + b.maxX) / 2, b.maxX);
      targetsY.push(b.minY, (b.minY + b.maxY) / 2, b.maxY);
    }
    return { targetsX, targetsY };
  };
  const snap = (edges: number[], targets: number[]) => {
    const threshold = SNAP / camera.scale;
    let best: { diff: number; at: number } | null = null;
    for (const edge of edges) for (const target of targets) {
      const diff = target - edge;
      if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, at: target };
    }
    return best;
  };

  /** Độ dời của cú kéo trên scene, đã dính mép/tâm của khối vào scene và node khác. */
  const dragDelta = (current: Extract<Gesture, { kind: "move" }>, p: Point): Point => {
    let dx = p.x - current.start.x;
    let dy = p.y - current.start.y;
    const { targetsX, targetsY } = snapTargets(current.ids);
    const u = current.union;
    const sx = snap([u.minX + dx, (u.minX + u.maxX) / 2 + dx, u.maxX + dx], targetsX);
    const sy = snap([u.minY + dy, (u.minY + u.maxY) / 2 + dy, u.maxY + dy], targetsY);
    if (sx) dx += sx.diff;
    if (sy) dy += sy.diff;
    setGuides({ x: sx ? [sx.at] : [], y: sy ? [sy.at] : [] });
    return { x: dx, y: dy };
  };

  const ops = (current: Gesture, p: Point, shift: boolean, alt = false): unknown[] => {
    if (current.kind === "move") {
      const { x: dx, y: dy } = dragDelta(current, p);
      return current.ids.flatMap((id) => {
        const box = current.from.get(id)!;
        const entity = entities.get(id)!;
        // Dời trong khung của CHA: đổi véc-tơ trên scene sang khung đó.
        const parent = invert(multiplyLinear(box.matrix as Mat, invert(box.local as Mat)));
        const local = { x: parent[0] * dx + parent[2] * dy, y: parent[1] * dx + parent[3] * dy };
        // Phụ đề đặt theo preset + `verticalAlign`; thứ dời được là offset.
        if (entity.kind === "captions") {
          return writes(entity, box, { offsetX: Math.round(box.values.offsetX + local.x), offsetY: Math.round(box.values.offsetY + local.y) });
        }
        return writes(entity, box, { x: Math.round(box.values.x + local.x), y: Math.round(box.values.y + local.y) });
      });
    }
    if (current.kind === "resize") {
      const { box, handle } = current;
      const entity = entities.get(current.id)!;
      const [ox, oy, w, h] = box.box;
      const [fx, fy] = HANDLES[handle];
      const local = apply(invert(box.matrix as Mat), p);
      let left = ox;
      let top = oy;
      let right = ox + w;
      let bottom = oy + h;
      if (fx < 0) left = Math.min(local.x, right - 1);
      if (fx > 0) right = Math.max(local.x, left + 1);
      if (fy < 0) top = Math.min(local.y, bottom - 1);
      if (fy > 0) bottom = Math.max(local.y, top + 1);
      if (entity.kind === "captions") {
        // Góc kéo xa hay gần tâm chữ → nhân `fontScale`; neo vẫn là `verticalAlign` + offset.
        const center = { x: ox + w / 2, y: oy + h / 2 };
        const from = Math.hypot((fx * w) / 2, (fy * h) / 2) || 1;
        const factor = Math.hypot(local.x - center.x, local.y - center.y) / from;
        // Cỡ lúc BẮT ĐẦU kéo: mỗi khung xem trước đã ghi cỡ mới vào document,
        // đọc lại từ đó là nhân chồng hệ số (một cú kéo ngắn nhảy thẳng lên 300%).
        const fontScale = Math.round(Math.min(CAPTION_SCALE_MAX, Math.max(CAPTION_SCALE_MIN, current.fontScale * factor)) * 100) / 100;
        setGuides({ x: [], y: [] });
        return [{ op: "set_props", element_id: entity.id, props: { fontScale: fontScale === 1 ? null : fontScale } }];
      }
      if (entity.kind === "group") {
        // Group không có width/height (hộp tính từ con): đổi cỡ = `scale`, luôn
        // giữ tỉ lệ. Scale xoay quanh TÂM hộp, nên dời x/y để góc đối diện đứng yên.
        const factor = Math.max(0.05, fx && fy ? Math.max((right - left) / w, (bottom - top) / h) : fx ? (right - left) / w : (bottom - top) / h);
        const [a, b, c, d] = box.local;
        const center = { x: ox + w / 2, y: oy + h / 2 };
        const fixed = { x: fx > 0 ? ox : fx < 0 ? ox + w : center.x, y: fy > 0 ? oy : fy < 0 ? oy + h : center.y };
        const rel = { x: fixed.x - center.x, y: fixed.y - center.y };
        const lin = { x: a * rel.x + c * rel.y, y: b * rel.x + d * rel.y };
        const shiftX = lin.x - lin.x * factor;
        const shiftY = lin.y - lin.y * factor;
        const v = box.values;
        setGuides({ x: [], y: [] });
        const next = Math.round(v.scaleX * factor * 1000) / 1000;
        return writes(entity, box, { x: Math.round(v.x + shiftX), y: Math.round(v.y + shiftY), scale: next });
      }
      if ((current.ratio || shift) && fx && fy && w && h) {
        // Giữ tỉ lệ: theo trục kéo xa hơn, góc đối diện đứng yên.
        const scale = Math.max((right - left) / w, (bottom - top) / h);
        if (fx < 0) left = right - w * scale;
        else right = left + w * scale;
        if (fy < 0) top = bottom - h * scale;
        else bottom = top + h * scale;
      }
      const width = Math.round(right - left);
      const height = Math.round(bottom - top);
      // Góc trên-trái mới (trong khung cha) phải là nơi hộp mới bắt đầu.
      const origin = apply(box.local as Mat, { x: left, y: top });
      const [a, b, c, d] = box.local;
      const v = box.values;
      const x = origin.x - v.offsetX - width / 2 + (a * width) / 2 + (c * height) / 2;
      const y = origin.y - v.offsetY - height / 2 + (b * width) / 2 + (d * height) / 2;
      setGuides({ x: [], y: [] });
      const size: Record<string, number> = entity.kind === "text" && !("height" in entity) ? { width } : { width, height };
      return writes(entity, box, { x: Math.round(x), y: Math.round(y), ...size });
    }
    if (current.kind === "resize-many") {
      const u = current.union;
      const [fx, fy] = HANDLES[current.handle];
      const w0 = u.maxX - u.minX || 1;
      const h0 = u.maxY - u.minY || 1;
      const mid = { x: (u.minX + u.maxX) / 2, y: (u.minY + u.maxY) / 2 };
      let dx = p.x - current.start.x;
      let dy = p.y - current.start.y;
      // Tay nắm đang kéo dính vào mép/tâm như khi dời.
      const { targetsX, targetsY } = snapTargets(current.ids);
      const sx0 = fx ? snap([(fx < 0 ? u.minX : u.maxX) + dx], targetsX) : null;
      const sy0 = fy ? snap([(fy < 0 ? u.minY : u.maxY) + dy], targetsY) : null;
      if (sx0) dx += sx0.diff;
      if (sy0) dy += sy0.diff;
      setGuides({ x: sx0 ? [sx0.at] : [], y: sy0 ? [sy0.at] : [] });
      // Điểm tựa: tay nắm đối diện; Alt thì tâm (mỗi phía giãn một nửa).
      const k = alt ? 2 : 1;
      const pivot = { x: alt || !fx ? mid.x : fx < 0 ? u.maxX : u.minX, y: alt || !fy ? mid.y : fy < 0 ? u.maxY : u.minY };
      let sx = fx ? (w0 + k * fx * dx) / w0 : 1;
      let sy = fy ? (h0 + k * fy * dy) / h0 : 1;
      if (current.ratio || shift) {
        // Tay góc: chiếu độ dời lên đường chéo; tay cạnh: trục còn lại theo cùng hệ số.
        if (fx && fy) sx = sy = 1 + (k * (dx * fx * w0 + dy * fy * h0)) / (w0 * w0 + h0 * h0);
        else if (fx) sy = sx;
        else sx = sy;
      }
      sx = Math.max(0.01, sx);
      sy = Math.max(0.01, sy);
      return current.ids.flatMap((id) => {
        const box = current.from.get(id)!;
        const entity = entities.get(id)!;
        const [ox, oy, w, h] = box.box;
        const centerLocal = { x: ox + w / 2, y: oy + h / 2 };
        const center = apply(box.matrix as Mat, centerLocal);
        const moved = { x: pivot.x + (center.x - pivot.x) * sx - center.x, y: pivot.y + (center.y - pivot.y) * sy - center.y };
        const parent = invert(multiplyLinear(box.matrix as Mat, invert(box.local as Mat)));
        const shift = { x: parent[0] * moved.x + parent[2] * moved.y, y: parent[1] * moved.x + parent[3] * moved.y };
        const v = box.values;
        if (!RESIZABLE.has(entity.kind as string)) {
          return writes(entity, box, { x: Math.round(v.x + shift.x), y: Math.round(v.y + shift.y) });
        }
        // Tâm mới trong khung cha = x + offsetX + width/2 (công thức của localMatrix).
        const inParent = apply(box.local as Mat, centerLocal);
        const width = Math.max(1, Math.round(w * sx));
        const height = Math.max(1, Math.round(h * sy));
        const x = inParent.x + shift.x - v.offsetX - width / 2;
        const y = inParent.y + shift.y - v.offsetY - height / 2;
        const size: Record<string, number> = entity.kind === "text" && !("height" in entity) ? { width } : { width, height };
        return writes(entity, box, { x: Math.round(x), y: Math.round(y), ...size });
      });
    }
    if (current.kind === "rotate") {
      const angle = (Math.atan2(p.y - current.center.y, p.x - current.center.x) * 180) / Math.PI;
      let rotation = current.box.values.rotation + (angle - current.angle);
      if (shift) rotation = Math.round(rotation / 15) * 15;
      rotation = Math.round(rotation * 100) / 100;
      return writes(entities.get(current.id)!, current.box, { rotation });
    }
    return [];
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || spaceHeld() || tool === "hand") return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = toScene(event);
    if (tool === "rect" || tool === "text" || tool === "scene") return setGesture({ kind: "draw", tool, start: p, now: p });

    const handle = handleAt(p);
    if (handle?.resize && many) {
      const from = new Map(selected.map((id) => [id, boxes.get(id)!] as const));
      const ratio = selected.every((id) => !!entities.get(id)?.keepAspectRatio);
      return setGesture({ kind: "resize-many", handle: handle.resize, start: p, ids: selected, from, union: many, ratio });
    }
    if (handle?.resize && singleBox) {
      const fontScale = typeof singleEntity?.fontScale === "number" ? singleEntity.fontScale : 1;
      return setGesture({ kind: "resize", id: single!, handle: handle.resize, box: singleBox, ratio: !!singleEntity?.keepAspectRatio, fontScale });
    }
    if (handle?.rotate && singleBox) {
      const center = aabb(corners(singleBox));
      const c = { x: (center.minX + center.maxX) / 2, y: (center.minY + center.maxY) / 2 };
      return setGesture({ kind: "rotate", id: single!, box: singleBox, center: c, angle: (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI });
    }

    const target = hit(p);
    if (!target) {
      return setGesture({ kind: "marquee", start: p, now: p, extend: event.shiftKey ? selected : [] });
    }
    const id = target.id as string;
    let ids = selected;
    if (event.shiftKey) ids = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
    else if (!selected.includes(id)) ids = [id];
    onSelect(ids);
    const from = new Map(ids.flatMap((item) => (boxes.get(item) ? [[item, boxes.get(item)!] as const] : [])));
    const union = aabb([...from.values()].flatMap(corners));
    setGesture({ kind: "move", start: p, ids: [...from.keys()], from, union, moved: false });
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const p = toScene(event);
    const current = gestureRef.current;
    if (!current) {
      const target = hit(p);
      setHover((target?.id as string | undefined) ?? null);
      const handle = handleAt(p);
      svg.current!.style.cursor =
        tool === "rect" || tool === "text" || tool === "scene" ? "crosshair"
        : handle?.resize ? (["n", "s"].includes(handle.resize) ? "ns-resize" : ["e", "w"].includes(handle.resize) ? "ew-resize" : ["nw", "se"].includes(handle.resize) ? "nwse-resize" : "nesw-resize")
        : handle?.rotate ? "alias"
        : "default";
      return;
    }
    if (current.kind === "marquee" || current.kind === "draw") return setGesture({ ...current, now: p });
    if (current.kind === "move") {
      const distance = Math.hypot(p.x - current.start.x, p.y - current.start.y) * camera.scale;
      if (!current.moved && distance < CLICK) return;
      if (!current.moved) {
        // Ghi thẳng vào ref: thả tay có thể tới trước lần render kế tiếp.
        gestureRef.current = { ...current, moved: true };
        setGesture(gestureRef.current);
      }
      settle(dropAt(p, current.ids));
    }
    edit(ops(current, p, event.shiftKey, event.altKey), { preview: true });
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = gestureRef.current;
    setGesture(null);
    setGuides({ x: [], y: [] });
    if (!current) return;
    const p = toScene(event);
    if (current.kind === "marquee") {
      const distance = Math.hypot(p.x - current.start.x, p.y - current.start.y) * camera.scale;
      if (distance < CLICK) {
        onSelect([]);
        setEntered(null);
        return;
      }
      const area = aabb([current.start, p]);
      const caught = pickable.filter((entity) => {
        const box = boxes.get(entity.id as string);
        if (!box) return false;
        const b = aabb(corners(box));
        return b.maxX >= area.minX && b.minX <= area.maxX && b.maxY >= area.minY && b.minY <= area.maxY;
      });
      onSelect([...new Set([...current.extend, ...caught.map((entity) => entity.id as string)])]);
      return;
    }
    if (current.kind === "draw") return void draw(current, p);
    if (current.kind === "move" && !current.moved) return;
    const moves = ops(current, p, event.shiftKey, event.altKey);
    if (current.kind === "move") {
      // Chỉ đổi cha khi đã đứng yên trên đích đủ lâu — lướt qua thì không.
      const into = drop.current.id !== null && Date.now() - drop.current.since >= DROP_DWELL_MS ? drop.current.id : null;
      settle(null);
      const leaving = into ? current.ids.filter((id) => sceneOf(id) !== into) : [];
      if (into && leaving.length) return void run(reparent(current, p, into, leaving, moves));
    }
    edit(moves);
  };

  /** Scene lồng sâu nhất dưới con trỏ, không thuộc thứ đang kéo; không có thì scene đang mở. */
  const dropAt = (p: Point, ids: string[]): string => {
    const dragged = (id: string) => {
      for (let at: string | undefined = id; at; at = parents.get(at)?.id as string | undefined) if (ids.includes(at)) return true;
      return false;
    };
    let best: { id: string; depth: number } | null = null;
    for (const [id, entity] of entities) {
      if (entity.kind !== "scene" || id === scene.id || dragged(id)) continue;
      const box = boxes.get(id);
      if (!box?.visible || !inside(box, p)) continue;
      let depth = 0;
      for (let at = parents.get(id); at; at = typeof at.id === "string" ? parents.get(at.id) : undefined) depth++;
      if (!best || depth > best.depth) best = { id, depth };
    }
    return best?.id ?? (scene.id as string);
  };
  /** Đổi ứng viên thì đếm lại 250 ms; đủ thì viền scene đích sáng lên (scene đang mở không có viền). */
  const settle = (id: string | null) => {
    if (drop.current.id === id) return;
    drop.current = { id, since: Date.now() };
    if (dwell.current) clearTimeout(dwell.current);
    setDropTarget(null);
    if (id) dwell.current = setTimeout(() => setDropTarget(id), DROP_DWELL_MS);
  };

  /**
   * Chuyển node vào scene `into` rồi đặt lại x/y trong khung mới để node đứng
   * đúng chỗ vừa thả: ma trận thế giới giữ nguyên, chỉ phần dời đổi.
   */
  const reparent = (current: Extract<Gesture, { kind: "move" }>, p: Point, into: string, leaving: string[], moves: unknown[]): unknown[] => {
    // Scene đang mở vẽ ở gốc; scene lồng: con của nó sống trong ma trận của nó.
    const target: Mat = into === scene.id ? [1, 0, 0, 1, 0, 0] : (boxes.get(into)!.matrix as Mat);
    const back = invert(target);
    const kept = moves.filter((op) => !leaving.includes((op as { element_id?: string }).element_id ?? ""));
    const delta = dragDelta(current, p);
    const out: unknown[] = leaving.map((id) => ({ op: "move_layer", element_id: id, parent_id: into }));
    for (const id of leaving) {
      const box = current.from.get(id)!;
      const world = multiply([1, 0, 0, 1, delta.x, delta.y], box.matrix as Mat);
      const local = multiply(back, world);
      out.push(...writes(entities.get(id)!, box, { x: Math.round(box.values.x + local[4] - box.local[4]), y: Math.round(box.values.y + local[5] - box.local[5]) }));
    }
    return [...out, ...kept];
  };

  const draw = async (current: Extract<Gesture, { kind: "draw" }>, p: Point) => {
    const area = aabb([current.start, p]);
    const click = (area.maxX - area.minX) * camera.scale < 10 || (area.maxY - area.minY) * camera.scale < 10;
    const sceneHeight = scene.height as number;
    if (current.tool === "scene") {
      // Scene mới ở cấp stage (toạ độ stage = toạ độ scene đang mở + góc của nó),
      // nền đen, và thành scene đang mở — như fork.
      const width = click ? 1920 : Math.round(area.maxX - area.minX);
      const height = click ? 1080 : Math.round(area.maxY - area.minY);
      const originX = (scene.x as number | undefined) ?? 0;
      const originY = (scene.y as number | undefined) ?? 0;
      onTool("move");
      onSelect([]);
      await run([
        {
          op: "insert_scene",
          node: {
            kind: "scene",
            name: nextName(doc, "Scene"),
            x: Math.round(originX + (click ? current.start.x - width / 2 : area.minX)),
            y: Math.round(originY + (click ? current.start.y - height / 2 : area.minY)),
            width,
            height,
            paints: [{ type: "solid", color: "#000000" }],
          },
        },
      ]);
      return;
    }
    let node: Record<string, unknown>;
    if (current.tool === "rect") {
      const width = click ? 300 : Math.round(area.maxX - area.minX);
      const height = click ? 300 : Math.round(area.maxY - area.minY);
      node = {
        kind: "rect",
        name: nextName(doc, "Rect"),
        x: Math.round(click ? current.start.x - width / 2 : area.minX),
        y: Math.round(click ? current.start.y - height / 2 : area.minY),
        width,
        height,
        paints: [{ type: "solid", color: "#E0E0E0" }],
      };
    } else {
      // Cỡ chữ theo chiều cao scene, như fork; bấm thì chữ tự lấy cỡ theo nét.
      const fontSize = Math.max(8, Math.round(sceneHeight / 22.5));
      const width = Math.round(fontSize * 0.6 * 4);
      const height = Math.round(fontSize * 1.2);
      node = {
        kind: "text",
        name: nextName(doc, "Text"),
        x: Math.round(click ? current.start.x - width / 2 : area.minX),
        y: Math.round(click ? current.start.y - height / 2 : area.minY),
        ...(click ? {} : { width: Math.round(area.maxX - area.minX), height: Math.round(area.maxY - area.minY) }),
        fontSize,
        color: "#FFFFFF",
        text: "Text",
      };
    }
    const before = new Set(((scene.children as Entity[] | undefined) ?? []).map((child) => child.id));
    onTool("move");
    const after = await run([{ op: "insert_node", parent_id: scene.id, node }]);
    if (!after) return;
    const added = ((activeScene(after) as unknown as Entity).children as Entity[]).find((child) => !before.has(child.id));
    if (!added) return;
    onSelect([added.id as string]);
    // Như fork: chữ mới đặt thì gõ luôn — ô Text của inspector nhận focus khi nó hiện ra.
    if (current.tool === "text") focusWhenReady(`[data-testid="ins-text-content"][data-node="${String(added.id)}"]`);
  };

  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const p = toScene(event);
    const target = hit(p);
    if (!target || !["group", "scene"].includes(target.kind as string)) return;
    // Mở tầng của vật chứa: con dưới con trỏ nhận lựa chọn.
    setEntered(target.id as string);
    const inner = ((target.children as Entity[] | undefined) ?? []).slice().reverse().find((child) => {
      const box = typeof child.id === "string" ? boxes.get(child.id) : undefined;
      return box && !child.hidden && box.visible && inside(box, p);
    });
    onSelect(inner ? [inner.id as string] : [target.id as string]);
  };

  // ------------------------------------------------------------------ vẽ

  const outline = (id: string, className: string) => {
    const box = boxes.get(id);
    if (!box) return null;
    const points = corners(box).map(toScreen);
    return <polygon key={`${className}-${id}`} className={className} points={points.map((p) => `${p.x},${p.y}`).join(" ")} />;
  };
  const sceneLabel = toScreen({ x: 0, y: 0 });

  return (
    <svg
      ref={svg}
      className="ed2-canvas-ov"
      data-testid="canvas-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDoubleClick}
    >
      {pending
        ? pickable.map((entity) => {
            const label = pending(entity);
            const box = label ? boxes.get(entity.id as string) : undefined;
            if (!label || !box) return null;
            const points = corners(box).map(toScreen);
            const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
            const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
            return (
              <g key={`pending-${entity.id as string}`} data-testid="canvas-pending">
                <polygon className="ed2-ov-pending" points={points.map((p) => `${p.x},${p.y}`).join(" ")} />
                <text className="ed2-ov-pending-label" x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                  {label}
                </text>
              </g>
            );
          })
        : null}
      {hover && !selected.includes(hover) && !gesture ? outline(hover, "ed2-ov-hover") : null}
      {selected.map((id) => outline(id, "ed2-ov-selected"))}
      {singleBox && singleEntity && RESIZABLE.has(singleEntity.kind as string) && !gesture
        ? (Object.entries(HANDLES) as [Handle, [number, number]][]).map(([name, [fx, fy]]) => {
            const [ox, oy, w, h] = singleBox.box;
            const at = toScreen(apply(singleBox.matrix as Mat, { x: ox + ((fx + 1) / 2) * w, y: oy + ((fy + 1) / 2) * h }));
            return <rect key={name} className="ed2-ov-handle" data-testid={`handle-${name}`} x={at.x - 4} y={at.y - 4} width={8} height={8} />;
          })
        : null}
      {many && !gesture
        ? (Object.entries(HANDLES) as [Handle, [number, number]][]).map(([name, [fx, fy]]) => {
            const at = toScreen({ x: many.minX + ((fx + 1) / 2) * (many.maxX - many.minX), y: many.minY + ((fy + 1) / 2) * (many.maxY - many.minY) });
            return <rect key={name} className="ed2-ov-handle" data-testid={`handle-${name}`} x={at.x - 4} y={at.y - 4} width={8} height={8} />;
          })
        : null}
      {many && !gesture ? (() => {
        const a = toScreen({ x: many.minX, y: many.minY });
        const b = toScreen({ x: many.maxX, y: many.maxY });
        return <rect className="ed2-ov-group" data-testid="selection-box" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} />;
      })() : null}
      {dropTarget && gesture?.kind === "move" ? outline(dropTarget, "ed2-ov-drop") : null}
      {guides.x.map((x) => {
        const a = toScreen({ x, y: -1e5 });
        return <line key={`gx${x}`} className="ed2-ov-guide" x1={a.x} x2={a.x} y1={0} y2={9999} />;
      })}
      {guides.y.map((y) => {
        const a = toScreen({ x: -1e5, y });
        return <line key={`gy${y}`} className="ed2-ov-guide" x1={0} x2={9999} y1={a.y} y2={a.y} />;
      })}
      {gesture?.kind === "marquee" || gesture?.kind === "draw" ? (() => {
        const area = aabb([toScreen(gesture.start), toScreen(gesture.now)]);
        return (
          <rect
            className={gesture.kind === "marquee" ? "ed2-ov-marquee" : "ed2-ov-draw"}
            data-testid={gesture.kind === "marquee" ? "marquee" : "draw-preview"}
            x={area.minX}
            y={area.minY}
            width={area.maxX - area.minX}
            height={area.maxY - area.minY}
          />
        );
      })() : null}
      {others.map((other) => {
        const at = toScreen({ x: other.dx, y: other.dy });
        return (
          <foreignObject key={other.id} x={at.x} y={at.y - 24} width={240} height={22}>
            <span
              className="ed2-ov-name"
              data-testid={`scene-label-${other.name}`}
              title="Open this scene"
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect([]);
                setEntered(null);
                void run([{ op: "activate_scene", scene_id: other.id }]);
              }}
            >
              {other.name}
            </span>
          </foreignObject>
        );
      })}
      <foreignObject x={sceneLabel.x} y={sceneLabel.y - 24} width={240} height={22}>
        {renaming ? (
          <input
            className="ed2-rename ed2-ov-name-input"
            aria-label="Scene name"
            autoFocus
            defaultValue={String(scene.name ?? "Scene")}
            onFocus={(event) => event.target.select()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenaming(false);
            }}
            onBlur={(event) => {
              setRenaming(false);
              const name = event.target.value.trim();
              if (name && name !== scene.name) void run([{ op: "set_props", element_id: scene.id, props: { name } }]);
            }}
          />
        ) : (
          <span
            className="ed2-ov-name"
            data-testid="scene-label"
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect([]);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setRenaming(true);
            }}
          >
            {String(scene.name ?? "Scene")}
          </span>
        )}
      </foreignObject>
    </svg>
  );
}

/** Focus phần tử khi nó xuất hiện (inspector dựng lại sau khi đổi lựa chọn); bỏ sau ~0,5 s. */
function focusWhenReady(selector: string, tries = 30): void {
  const element = document.querySelector<HTMLTextAreaElement>(selector);
  if (element) {
    element.focus();
    element.select();
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusWhenReady(selector, tries - 1));
}

/** Phần tuyến tính của `m · n` (bỏ dời) — đủ để đổi véc-tơ giữa hai khung. */
function multiplyLinear(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    0,
    0,
  ];
}
