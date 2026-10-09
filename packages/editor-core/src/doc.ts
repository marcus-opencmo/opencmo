/**
 * Đi trên document của một clip (`@opencmo/clip-doc`) ở mức "phần tử": node
 * lẫn thành phần phụ (paint, stroke, keyframe…). Mỗi phần tử ở đây là một thẻ
 * trong TSX mà fork đang chạy, nên `id` của chúng là id mà canvas, Assistant và
 * route ops cùng gọi tên.
 */

import type { ClipDocument, ClipNode, SceneNode } from '@opencmo/clip-doc';

export const MASTER_SRC = 'assets/master.mp4';

/** Bất kỳ phần tử nào của cây: node, stage, hay thành phần phụ. */
export type Entity = Record<string, unknown> & { id?: string };

export type Visit = {
  entity: Entity;
  /** Tên thẻ tương ứng trong TSX (`video`, `imagePaint`, `keyframe`…). */
  tag: string;
  /** Mảng đang chứa phần tử (null với stage). */
  list: Entity[] | null;
  /** Phần tử cha gần nhất. */
  parent: Entity | null;
};

const PAINT_TAG: Record<string, string> = {
  solid: 'solidPaint',
  linearGradient: 'linearGradientPaint',
  radialGradient: 'radialGradientPaint',
  image: 'imagePaint',
  video: 'videoPaint',
};

const listOf = (entity: Entity, key: string): Entity[] => (entity[key] as Entity[] | undefined) ?? [];

/**
 * Mọi phần tử theo thứ tự cố định (thứ tự bản TSX cũ, id và fixture vàng dựa
 * vào nó): chữ và thành phần phụ trước, rồi mask, rồi con.
 */
export function walk(document: ClipDocument, visit: (item: Visit) => void): void {
  const each = (holder: Entity, key: string, tag: (entity: Entity) => string, inner?: (entity: Entity) => void) => {
    const list = listOf(holder, key);
    for (const entity of list) {
      visit({ entity, tag: tag(entity), list, parent: holder });
      inner?.(entity);
    }
  };
  const decorations = (holder: Entity): void => {
    each(holder, 'ranges', () => 'textRange', decorations);
    each(
      holder,
      'paints',
      (paint) => PAINT_TAG[paint.type as string] ?? 'paint',
      (paint) => {
        each(paint, 'stops', () => 'colorStop', decorations);
        decorations(paint);
      },
    );
    each(holder, 'strokes', () => 'stroke', decorations);
    each(holder, 'shadows', () => 'shadow', decorations);
    each(holder, 'effects', () => 'effect', decorations);
    each(holder, 'tracks', () => 'keyframeTrack', (track) => each(track, 'keyframes', () => 'keyframe'));
    each(holder, 'animations', () => 'animation');
  };
  const node = (entity: Entity, list: Entity[], parent: Entity) => {
    visit({ entity, tag: entity.kind as string, list, parent });
    decorations(entity);
    for (const key of ['masks', 'children']) {
      const inner = listOf(entity, key);
      for (const child of inner) node(child, inner, entity);
    }
  };
  const stage = document.stage as unknown as Entity;
  visit({ entity: stage, tag: 'stage', list: null, parent: null });
  const top = listOf(stage, 'children');
  for (const child of top) node(child, top, stage);
}

/** Mọi node (không kể thành phần phụ) theo thứ tự file. */
export function nodes(document: ClipDocument): ClipNode[] {
  const out: ClipNode[] = [];
  walk(document, ({ entity, tag }) => {
    if (entity.kind === tag) out.push(entity as unknown as ClipNode);
  });
  return out;
}

export const firstOf = <K extends ClipNode['kind']>(document: ClipDocument, kind: K) =>
  nodes(document).find((node) => node.kind === kind) as Extract<ClipNode, { kind: K }> | undefined;

export const sceneOf = (document: ClipDocument): SceneNode | undefined => firstOf(activeView(document), 'scene');

export const isMaster = (node: ClipNode): boolean =>
  node.kind === 'video' && (node as { src?: unknown }).src === MASTER_SRC;

/**
 * Tiếng của video master: các đoạn video, và đoạn `audio` cùng nguồn mà J/L-cut tách
 * ra (`captions.ts`). Thứ gì chỉnh tiếng gốc (khử ồn, voiceover tắt/hạ tiếng) phải
 * chạm cả hai — chỉ chạm video thì sau J/L-cut tiếng gốc vẫn kêu nguyên.
 */
export const isMasterSound = (node: ClipNode): boolean =>
  isMaster(node) || (node.kind === 'audio' && (node as { src?: unknown }).src === MASTER_SRC);

// ------------------------------------------------------------------ timeline (E2-a)

const isScene = (node: { kind?: unknown }): boolean => node.kind === 'scene';

/** Các scene cấp stage — mỗi scene là một timeline (Palmier `create_timeline`). */
export const timelinesOf = (document: ClipDocument): SceneNode[] =>
  document.stage.children.filter((node): node is SceneNode => isScene(node));

/**
 * Document chỉ còn MỘT timeline. Mọi op và mọi hàm đọc viết cho "scene đầu tiên /
 * video master đầu tiên" chạy đúng trên timeline đang chọn mà không phải sửa từng
 * hàm: chỉ có một scene thì trả nguyên document. Bản xem dùng chung node với
 * document gốc — chỉ để đọc, op luôn `clone` trước khi sửa.
 */
export function viewOf(document: ClipDocument, scene: SceneNode): ClipDocument {
  if (timelinesOf(document).length < 2) return document;
  return { ...document, stage: { ...document.stage, children: document.stage.children.filter((node) => !isScene(node) || node === scene) } };
}

/** Tên hiển thị: scene chưa đặt tên là "Main" nếu đứng đầu, sau đó "Timeline N". */
export function timelineLabel(scene: SceneNode, index: number): string {
  return scene.name?.trim() || (index === 0 ? 'Main' : `Timeline ${index + 1}`);
}

const views = new WeakMap<ClipDocument, ClipDocument>();

/** Timeline đang mở (scene `active`, không có thì scene đầu). */
export function activeView(document: ClipDocument): ClipDocument {
  const scenes = timelinesOf(document);
  if (scenes.length < 2) return document;
  let view = views.get(document);
  if (!view) {
    view = viewOf(document, scenes.find((scene) => scene.active) ?? scenes[0]!);
    views.set(document, view);
  }
  return view;
}

/** Ghép kết quả sửa trên bản xem `view` (của `scene`) trở lại document đủ các timeline. */
export function mergeView(document: ClipDocument, scene: SceneNode, view: ClipDocument, result: ClipDocument): ClipDocument {
  if (result === view) return document;
  if (view === document) return result;
  const children: ClipDocument['stage']['children'] = [];
  for (const node of document.stage.children) {
    if (node === scene) children.push(...result.stage.children);
    else if (isScene(node)) children.push(node);
  }
  return { ...result, stage: { ...result.stage, children } };
}

/** Bản sao sâu: op không bao giờ sửa document của người gọi. */
export const clone = (document: ClipDocument): ClipDocument => structuredClone(document);

/** Hai document như nhau về nội dung (bỏ qua thứ tự khoá). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => same(item, other[index]));
  }
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = Object.entries(b).filter(([, value]) => value !== undefined);
  return left.length === right.length && left.every(([key, value]) => same(value, (b as Record<string, unknown>)[key]));
}

/** Đặt `value` cho khoá, hoặc bỏ khoá khi `undefined`. */
export function assign(entity: Entity, key: string, value: unknown): void {
  if (value === undefined) delete entity[key];
  else entity[key] = value;
}

// ------------------------------------------------------------------ id

const ID_CHARS = 6;
const ID_SPACE = 36 ** ID_CHARS;

/** Một id base36 sáu ký tự, rút đều (bỏ phần dư của 2^32 để không lệch). */
function drawId(): string {
  const ceiling = ID_SPACE * Math.floor(2 ** 32 / ID_SPACE);
  const cell = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(cell);
    if (cell[0]! < ceiling) return (cell[0]! % ID_SPACE).toString(36).padStart(ID_CHARS, '0');
  }
}

/**
 * Đặt `id` cho mọi phần tử chưa có — phần tử mới (chữ vừa thêm, đoạn video vừa
 * cắt) phải gọi tên được ngay ở lượt op kế tiếp. Sửa tại chỗ; trả số id đã đặt.
 */
export function stamp(document: ClipDocument): number {
  const taken = new Set<string>();
  const missing: Entity[] = [];
  walk(document, ({ entity }) => {
    if (typeof entity.id === 'string') taken.add(entity.id);
    else missing.push(entity);
  });
  for (const entity of missing) {
    let id = drawId();
    while (taken.has(id)) id = drawId();
    taken.add(id);
    entity.id = id;
  }
  return missing.length;
}

/** Phần tử theo `id`; không có hoặc trùng thì null. */
export function byId(document: ClipDocument, id: string): Visit | null {
  const found: Visit[] = [];
  walk(document, (item) => {
    if (item.entity.id === id) found.push(item);
  });
  return found.length === 1 ? found[0]! : null;
}
