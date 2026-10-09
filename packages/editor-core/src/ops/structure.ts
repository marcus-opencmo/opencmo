/**
 * Op sửa CẤU TRÚC cây (spec editor-rewrite B7): nhân bản, dán, nhóm / bọc vào
 * sequence / bọc vào scene, bỏ nhóm. Phím tắt, menu và menu chuột phải của
 * shell đều đi qua đây.
 *
 * Luật lấy từ hành vi của fork DS, không từ mã của nó:
 * - Chỉ đỉnh của các cây con được chọn tham gia (con của một node khác cũng
 *   được chọn đi theo cha nó).
 * - Nhân bản: bản sao cùng prop (cùng chỗ), đặt ngay TRÊN bản gốc trong cùng
 *   cha — trừ khi bản gốc nằm trong sequence: hai clip cùng lúc xung đột ở
 *   đó, nên bản sao ra cha gần nhất không phải sequence, ngay trên sequence.
 * - Dán: vào vật chứa đang chọn (trên cùng), ngay trên lá đang chọn trong cha
 *   của lá, hay vào scene đang mở. Dán trở lại đúng sequence đã copy ra thì ra
 *   cha của sequence, như nhân bản.
 * - Nhóm/bọc: chỉ các node chung cha với node đầu tiên; vật chứa mới đứng ở chỗ
 *   node đầu tiên, các node giữ thứ tự. Group và sequence không có không gian
 *   riêng nên không gì dời. Sequence mới dàn lại chỗ chồng: clip sớm hơn giữ
 *   nguyên, clip sau nhường (cắt đầu, hay bị bỏ nếu nằm gọn trong clip trước).
 *   Scene có chỗ và cỡ riêng: bao hộp của các node (làm tròn ra ngoài), và các
 *   node dời đúng bằng góc của scene — trên canvas không gì nhúc nhích.
 * - Bỏ nhóm: con ra cha của vật chứa, đứng ở chỗ vật chứa, giữ thứ tự; transform
 *   của vật chứa (ở khung đang xem) "nướng" vào từng con, và vật chứa trượt
 *   trên timeline thì con nhận phần trượt đó vào `start`/`end`.
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';
import { createRenderer, multiply, type LayoutBox, type Mat } from '@opencmo/clip-render';

import { byId, clone, walk, type Entity } from '../doc';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';
import {
  activeScene,
  copyOf,
  nextName,
  nodeById,
  parentOrigin,
  placeOf,
  timesOf,
  trimIn,
} from './timeline';

const FPS = 30;
const CONTAINERS = new Set(['scene', 'group', 'sequence']);
const elementId = z.string().min(1).max(64);
const ids = z.array(elementId).min(1).max(500);
const frame = z.number().int().min(0).max(24 * 3600 * FPS);

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const seconds = (frames: number) => Math.round((frames / FPS) * 1e4) / 1e4;

/** Đỉnh các cây con: bỏ node nằm dưới một node khác cũng được chọn; giữ thứ tự cho sẵn. */
function roots(document: ClipDocument, elementIds: string[]): Entity[] {
  const parents = new Map<Entity, Entity | null>();
  walk(document, ({ entity, parent }) => parents.set(entity, parent ?? null));
  const wanted = [...new Set(elementIds.map((id) => nodeById(document, id)))];
  const set = new Set(wanted);
  return wanted.filter((entity) => {
    for (let at = parents.get(entity) ?? null; at; at = parents.get(at) ?? null) {
      if (set.has(at)) return false;
    }
    return true;
  });
}

function placeOfOrNull(document: ClipDocument, entity: Entity) {
  try {
    return placeOf(document, entity);
  } catch {
    return null;
  }
}

/** Hộp đã tính ở `frame`, theo object node của đúng document này. */
function layoutOf(document: ClipDocument, ctx: OpContext, at: number): Map<ClipNode, LayoutBox> {
  const renderer = createRenderer(document, {
    image: () => null,
    video: () => null,
    duration: (src) => ctx.media?.duration(src) ?? null,
    transcript: (src) => ctx.media?.transcript?.(src) ?? null,
  });
  return new Map(renderer.layout(at).map((box) => [box.node, box]));
}

/** Node trong khung của cha có vị trí riêng: chính nó, hay — với sequence — các con của nó. */
function spatialLeaves(entity: Entity): Entity[] {
  if (entity.kind !== 'sequence') return [entity];
  return ((entity.children as Entity[] | undefined) ?? []).flatMap(spatialLeaves);
}

/** Dời x/y của node (prop và mọi keyframe x/y) — "không gì nhúc nhích" khi đổi khung toạ độ. */
function shiftPosition(entity: Entity, dx: number, dy: number): void {
  // Bốn chữ số lẻ, không làm tròn về số nguyên: bọc rồi gỡ phải trả đúng
  // toạ độ cũ, kể cả toạ độ lẻ mà bộ sinh viết (video master x = -688.8).
  if (dx) entity.x = round(((entity.x as number | undefined) ?? 0) + dx, 4);
  if (dy) entity.y = round(((entity.y as number | undefined) ?? 0) + dy, 4);
  if (entity.x === 0) delete entity.x;
  if (entity.y === 0) delete entity.y;
  for (const track of (entity.tracks as Entity[] | undefined) ?? []) {
    const delta = track.property === 'x' ? dx : track.property === 'y' ? dy : 0;
    if (!delta) continue;
    for (const key of track.keyframes as Entity[]) key.value = round((key.value as number) + delta, 4);
  }
}

// ------------------------------------------------------------------ nhân bản, dán

type Duplicate = { element_ids: string[] };

export const duplicateElements = {
  name: 'duplicate_elements',
  input: z.object({ op: z.literal('duplicate_elements'), element_ids: ids }),
  describe: () => 'Duplicate',
  async apply(document: ClipDocument, input: Duplicate) {
    const next = clone(document);
    for (const source of roots(next, input.element_ids)) {
      // Ra khỏi mọi sequence, ngay trên chỗ nó rời đi.
      let below = source;
      let place = placeOf(next, below);
      while (place.parent.kind === 'sequence') {
        below = place.parent;
        place = placeOf(next, below);
      }
      place.list.splice(place.list.indexOf(below) + 1, 0, copyOf(source));
    }
    return checked(next, 'That selection cannot be duplicated');
  },
};

type Paste = { parent_id?: string; before_id?: string | null; nodes: Record<string, unknown>[]; copied_from?: string | null };

export const pasteNodes = {
  name: 'paste_nodes',
  input: z.object({
    op: z.literal('paste_nodes'),
    parent_id: elementId.optional(),
    before_id: elementId.nullable().optional(),
    nodes: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    /** Id của cha nơi đã copy — dán lại vào đúng sequence đó thì ra ngoài nó. */
    copied_from: elementId.nullable().optional(),
  }),
  describe: () => 'Paste',
  async apply(document: ClipDocument, input: Paste) {
    const next = clone(document);
    let parent: Entity = input.parent_id ? nodeOrScene(next, input.parent_id) : (activeScene(next) as unknown as Entity);
    if (!CONTAINERS.has(parent.kind as string)) throw new OpFailure('Paste into the scene, a group or a sequence.');
    let list = ((parent.children as Entity[] | undefined) ??= []);
    let anchor = input.before_id ? list.find((child) => child.id === input.before_id) : undefined;
    if (parent.kind === 'sequence' && input.copied_from && parent.id === input.copied_from) {
      const place = placeOf(next, parent);
      anchor = place.list[place.list.indexOf(parent) + 1];
      parent = place.parent;
      list = place.list;
    }
    const at = anchor ? list.indexOf(anchor) : list.length;
    list.splice(at, 0, ...input.nodes.map((node) => copyOf(node as Entity)));
    return checked(next, 'Those layers cannot be pasted here');
  },
};

function nodeOrScene(document: ClipDocument, id: string): Entity {
  const found = byId(document, id);
  if (!found || found.entity.kind !== found.tag) throw new OpFailure(`There is no layer "${id}" in this project.`);
  return found.entity;
}

// ------------------------------------------------------------------ nhóm, bọc

type Wrap = { element_ids: string[]; into: 'group' | 'sequence' | 'scene'; frame: number };

export const groupElements = {
  name: 'group_elements',
  input: z.object({
    op: z.literal('group_elements'),
    element_ids: ids,
    into: z.enum(['group', 'sequence', 'scene']),
    /** Khung đang xem — hộp của các node ở khung này quyết định scene bao chỗ nào. */
    frame,
  }),
  describe: (input: Wrap) => (input.into === 'group' ? 'Group' : input.into === 'sequence' ? 'Wrap in a sequence' : 'Wrap in a scene'),
  async apply(document: ClipDocument, input: Wrap, ctx: OpContext) {
    const next = clone(document);
    const chosen = roots(next, input.element_ids).filter((entity) => entity.kind !== 'scene');
    const first = chosen[0];
    if (!first) throw new OpFailure('Select the layers to put together first.');
    const { list } = placeOf(next, first);
    const members = list.filter((entity) => chosen.includes(entity));
    const prefix = input.into === 'group' ? 'Group' : input.into === 'sequence' ? 'Sequence' : 'Scene';
    const wrapper: Entity = { kind: input.into, name: nextName(next, prefix) };

    if (input.into === 'scene') {
      const boxes = layoutOf(next, ctx, input.frame);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const leaves = members.flatMap(spatialLeaves);
      for (const leaf of leaves) {
        const box = boxes.get(leaf as unknown as ClipNode);
        if (!box) continue;
        const [ox, oy, w, h] = box.box;
        const m = multiply(box.local, [1, 0, 0, 1, ox, oy]);
        for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
          const px = m[0] * x + m[2] * y + m[4];
          const py = m[1] * x + m[3] * y + m[5];
          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);
        }
      }
      if (!Number.isFinite(minX)) throw new OpFailure('Those layers have no size to wrap in a scene.');
      const x = Math.floor(minX);
      const y = Math.floor(minY);
      Object.assign(wrapper, { x, y, width: Math.max(1, Math.ceil(maxX) - x), height: Math.max(1, Math.ceil(maxY) - y) });
      if (!x) delete wrapper.x;
      if (!y) delete wrapper.y;
      for (const leaf of leaves) shiftPosition(leaf, -x, -y);
    }

    list.splice(list.indexOf(members[0]!), 0, wrapper);
    for (const member of members) list.splice(list.indexOf(member), 1);
    wrapper.children = members;

    if (input.into === 'sequence') {
      // Clip sớm hơn giữ nguyên; clip sau nhường phần bị chồng.
      const times = timesOf(next, ctx);
      const timeOf = (entity: Entity) => times.get(entity as unknown as ClipNode);
      const order = [...members].sort((a, b) => (timeOf(a)?.start ?? 0) - (timeOf(b)?.start ?? 0));
      const kept: Entity[] = [];
      let reach = -Infinity;
      for (const entity of order) {
        const t = timeOf(entity);
        if (!t) continue;
        if (t.end <= reach) {
          (wrapper.children as Entity[]).splice((wrapper.children as Entity[]).indexOf(entity), 1);
          continue;
        }
        if (t.start < reach) trimIn(entity, t, reach);
        kept.push(entity);
        reach = Math.max(reach, t.end);
      }
    }
    return checked(next, `Those layers cannot be put in a ${input.into}`);
  },
};

// ------------------------------------------------------------------ bỏ nhóm

/** Ma trận → x, y, xoay (độ), phóng hai trục; phần xiên (không có chữ để ghi) bị bỏ. */
function decompose(m: Mat) {
  const [a, b, c, d, e, f] = m;
  const scaleX = Math.hypot(a, b);
  const rotation = (Math.atan2(b, a) * 180) / Math.PI;
  const scaleY = scaleX ? (a * d - b * c) / scaleX : 0;
  return { x: e, y: f, rotation, scaleX, scaleY };
}

const IDENTITY_EPS = 1e-6;
const isIdentity = (m: Mat) =>
  Math.abs(m[0] - 1) < IDENTITY_EPS && Math.abs(m[1]) < IDENTITY_EPS && Math.abs(m[2]) < IDENTITY_EPS &&
  Math.abs(m[3] - 1) < IDENTITY_EPS && Math.abs(m[4]) < IDENTITY_EPS && Math.abs(m[5]) < IDENTITY_EPS;

/** Ghi transform mới của một con sau khi vật chứa (ma trận `outer`) biến mất. */
function bake(entity: Entity, box: LayoutBox, outer: Mat): void {
  const v = box.values;
  const px = v.width / 2;
  const py = v.height / 2;
  const composed = decompose(multiply(multiply(outer, box.local), [1, 0, 0, 1, px, py]));
  const x = composed.x - px - v.offsetX;
  const y = composed.y - py - v.offsetY;
  // Dời/xoay/phóng tính trên giá trị ĐANG VẼ; áp phần chênh lên prop và keyframe
  // để node có chuyển động vẫn chạy như cũ, chỉ trong khung mới.
  shiftPosition(entity, round(x - v.x, 4), round(y - v.y, 4));
  const turn = round(composed.rotation - v.rotation, 2);
  if (turn) {
    entity.rotation = round(((entity.rotation as number | undefined) ?? 0) + turn, 2);
    if (!entity.rotation) delete entity.rotation;
    for (const track of (entity.tracks as Entity[] | undefined) ?? []) {
      if (track.property !== 'rotation') continue;
      for (const key of track.keyframes as Entity[]) key.value = round((key.value as number) + turn, 2);
    }
  }
  const sx = v.scaleX ? round(composed.scaleX / v.scaleX, 4) : 1;
  const sy = v.scaleY ? round(composed.scaleY / v.scaleY, 4) : 1;
  if (sx === 1 && sy === 1) return;
  const baseX = typeof entity.scaleX === 'number' ? entity.scaleX : typeof entity.scale === 'number' ? entity.scale : 1;
  const baseY = typeof entity.scaleY === 'number' ? entity.scaleY : typeof entity.scale === 'number' ? entity.scale : 1;
  const nextX = round(baseX * sx, 4);
  const nextY = round(baseY * sy, 4);
  delete entity.scale;
  delete entity.scaleX;
  delete entity.scaleY;
  // Như ô Scale của fork: một `scale` khi hai trục bằng nhau, không thì hai trục.
  if (Math.abs(nextX - nextY) < 1e-6) {
    if (nextX !== 1) entity.scale = nextX;
  } else {
    entity.scaleX = nextX;
    entity.scaleY = nextY;
  }
  for (const track of (entity.tracks as Entity[] | undefined) ?? []) {
    const factor = track.property === 'scale' ? sx : track.property === 'scaleX' ? sx : track.property === 'scaleY' ? sy : 1;
    if (factor === 1) continue;
    for (const key of track.keyframes as Entity[]) key.value = round((key.value as number) * factor, 4);
  }
}

type Ungroup = { element_ids: string[]; only?: 'sequence'; frame: number };

export const ungroupElements = {
  name: 'ungroup_elements',
  input: z.object({
    op: z.literal('ungroup_elements'),
    element_ids: ids,
    /** `sequence`: chỉ gỡ sequence (⇧⌥⌘↵); không có: gỡ group và scene lồng (⇧⌘G). */
    only: z.literal('sequence').optional(),
    frame,
  }),
  describe: (input: Ungroup) => (input.only ? 'Unwrap the sequence' : 'Ungroup'),
  async apply(document: ClipDocument, input: Ungroup, ctx: OpContext) {
    const next = clone(document);
    const boxes = layoutOf(next, ctx, input.frame);
    const times = timesOf(next, ctx);
    const kinds = input.only ? ['sequence'] : ['group', 'scene'];
    const containers = input.element_ids
      .map((id) => nodeOrScene(next, id))
      .filter((entity) => kinds.includes(entity.kind as string) && entity !== (activeScene(next) as unknown as Entity));
    if (!containers.length) {
      throw new OpFailure(input.only ? 'Select a sequence to unwrap.' : 'Select a group to ungroup.');
    }
    for (const container of containers) {
      const place = placeOfOrNull(next, container);
      if (!place) continue;
      const own = boxes.get(container as unknown as ClipNode);
      const outer = own && container.kind !== 'sequence' ? own.local : null;
      const t = times.get(container as unknown as ClipNode);
      const shift = t ? Math.round(t.origin - parentOrigin(t)) : 0;
      const children = ((container.children as Entity[] | undefined) ?? []).filter((child) => child.kind !== undefined);
      for (const child of children) {
        for (const leaf of spatialLeaves(child)) {
          const box = boxes.get(leaf as unknown as ClipNode);
          if (outer && box && !isIdentity(outer)) bake(leaf, box, outer);
        }
        if (shift) {
          // Vật chứa trượt trên timeline: con nhận phần trượt để phát đúng lúc cũ.
          const start = Math.round(((child.start as number | undefined) ?? 0) * FPS) + shift;
          if (start) child.start = seconds(start);
          else delete child.start;
          if (typeof child.end === 'number') child.end = seconds(Math.round(child.end * FPS) + shift);
        }
      }
      place.list.splice(place.list.indexOf(container), 1, ...children);
    }
    return checked(next, 'That layer cannot be ungrouped');
  },
};

// ------------------------------------------------------------------ scene cấp stage

type InsertScene = { node: Record<string, unknown> };

/** Công cụ Scene (F): scene mới ở cấp stage và thành scene đang mở, như fork. */
export const insertScene = {
  name: 'insert_scene',
  input: z.object({
    op: z.literal('insert_scene'),
    node: z.record(z.string(), z.unknown()).refine((node) => node.kind === 'scene', 'The new layer must be a scene.'),
  }),
  describe: () => 'Add a scene',
  async apply(document: ClipDocument, input: InsertScene) {
    const next = clone(document);
    for (const scene of next.stage.children) delete (scene as unknown as Entity).active;
    const node = copyOf(input.node as Entity);
    node.active = true;
    (next.stage.children as unknown as Entity[]).push(node);
    return checked(next, 'That scene cannot be added');
  },
};

type ActivateScene = { scene_id: string };

/** Bấm tên một scene trên canvas: nó thành scene đang mở (timeline, export đi theo). */
export const activateScene = {
  name: 'activate_scene',
  input: z.object({ op: z.literal('activate_scene'), scene_id: elementId }),
  describe: () => 'Open a scene',
  async apply(document: ClipDocument, input: ActivateScene) {
    const target = document.stage.children.find((node) => node.id === input.scene_id && node.kind === 'scene');
    if (!target) throw new OpFailure('That scene is not in this project.');
    if (activeScene(document) === target) return document;
    const next = clone(document);
    for (const scene of next.stage.children) {
      if (scene.id === input.scene_id) (scene as unknown as Entity).active = true;
      else delete (scene as unknown as Entity).active;
    }
    return next;
  },
};
