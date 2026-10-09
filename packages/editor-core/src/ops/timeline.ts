/**
 * Op của timeline (spec editor-rewrite B3): dời, cắt đầu/cuối, tách ở một
 * mốc, đổi chỗ lớp, dời keyframe, vùng làm việc.
 *
 * Luật lấy từ hành vi của fork DS, không từ mã của nó:
 * - Mọi mốc là frame của scene (30 fps); document ghi giây.
 * - Cắt đầu: chưa có `end` thì ghim `end` trước (không thì đuôi chạy theo
 *   đầu), rồi `start` dời và `sourceIn` tiến đúng bằng phần đầu bị mất.
 * - Cắt cuối: `end` dời; cửa sổ nguồn (`sourceOut`) chỉ theo khi node có nó.
 * - Dời: `start` và `end` (nếu có) cùng dời — dời chỉ `start` là kéo dãn.
 * - Trong sequence, clip vừa thả THẮNG: anh em bị nó phủ thì cắt ở mép bị
 *   phủ, phủ hết thì xoá, thả vào giữa thì tách đôi (ghi đè, không đẩy).
 * - Tách: nhân bản tại chỗ, bản gốc cắt cuối ở mốc, bản sao cắt đầu ở mốc.
 *   Tách một clip nằm thẳng dưới scene thì bọc hai nửa vào một sequence mới
 *   ("Sequence N") để chúng vẫn đọc là một clip.
 *
 * Assistant gọi thẳng được mọi op ở đây (spec agent-editor §4) — cùng luật
 * với kéo thả, và server có độ dài media (`serverMedia`) để giải thời gian
 * đúng như trình duyệt.
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode, SceneNode } from '@opencmo/clip-doc';
import { resolveTimes, type TimeNode } from '@opencmo/clip-render';

import { byId, clone, walk, type Entity } from '../doc';
import { OpFailure, type OpContext } from './context';

const FPS = 30;
const CONTAINERS = new Set(['scene', 'group', 'sequence']);

/** Giây ghi vào document: bốn chữ số lẻ đủ để mọi frame 30 fps khứ hồi đúng. */
const seconds = (frames: number): number => Math.round((frames / FPS) * 1e4) / 1e4;
const framesOf = (value: unknown): number | undefined =>
  typeof value === 'number' ? Math.round(value * FPS) : undefined;

export function activeScene(document: ClipDocument): SceneNode {
  const scenes = document.stage.children.filter((node): node is SceneNode => node.kind === 'scene');
  const scene = scenes.find((candidate) => candidate.active) ?? scenes[0];
  if (!scene) throw new OpFailure('This project has no scene.');
  return scene;
}

/** Thời gian đã giải của mọi node trong scene, theo chính object node. */
export function timesOf(document: ClipDocument, ctx: Pick<OpContext, 'media'>): Map<ClipNode, TimeNode> {
  const root = resolveTimes(activeScene(document), {
    duration: (src) => ctx.media?.duration(src) ?? null,
    transcript: (src) => ctx.media?.transcript?.(src) ?? null,
  });
  const map = new Map<ClipNode, TimeNode>();
  const visit = (t: TimeNode) => {
    map.set(t.node, t);
    t.children.forEach(visit);
    t.masks.forEach(visit);
  };
  visit(root);
  return map;
}

function timeOf(times: Map<ClipNode, TimeNode>, entity: Entity): TimeNode {
  const found = times.get(entity as unknown as ClipNode);
  if (!found) throw new OpFailure('That element is not in the active scene.');
  return found;
}

/** Frame của scene ứng với giây 0 của CHA — mốc mà `start`/`end` của node đo từ đó. */
export const parentOrigin = (t: TimeNode): number => (t.parent && t.parent.node.kind !== 'scene' ? t.parent.origin : 0);

/** Ghi một mốc thời gian; `start`/`sourceIn` bằng 0 là vắng mặt, như fork viết. */
function editTime(entity: Entity, name: 'start' | 'end' | 'sourceIn' | 'sourceOut', frames: number | null): void {
  if (frames === null || (frames === 0 && (name === 'start' || name === 'sourceIn'))) delete entity[name];
  else entity[name] = seconds(frames);
}

/** Có trường thời gian riêng không (sequence thì không: nó luôn bao các con). */
const timed = (entity: Entity): boolean => entity.kind !== 'sequence' && entity.kind !== 'scene';

export function trimIn(entity: Entity, t: TimeNode, frame: number): void {
  if (framesOf(entity.end) === undefined) editTime(entity, 'end', t.end - parentOrigin(t));
  editTime(entity, 'start', frame - parentOrigin(t));
  editTime(entity, 'sourceIn', Math.round((frame - t.origin) * t.rate));
}

export function trimOut(entity: Entity, t: TimeNode, frame: number): void {
  if (framesOf(entity.sourceOut) !== undefined) editTime(entity, 'sourceOut', Math.round((frame - t.origin) * t.rate));
  editTime(entity, 'end', frame - parentOrigin(t));
}

function moveTo(entity: Entity, t: TimeNode, frame: number): void {
  const start = frame - parentOrigin(t);
  const delta = start - (framesOf(entity.start) ?? 0);
  if (delta === 0) return;
  const end = framesOf(entity.end);
  if (end !== undefined) editTime(entity, 'end', end + delta);
  editTime(entity, 'start', start);
}

/** Bản sao sâu không mang id: `applyOps` đặt id mới ở cuối lượt. */
export function copyOf(entity: Entity): Entity {
  const copy = structuredClone(entity);
  const strip = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(strip);
    else if (value && typeof value === 'object') {
      delete (value as Entity).id;
      delete (value as Entity).selected;
      Object.values(value).forEach(strip);
    }
  };
  strip(copy);
  return copy;
}

/** Cha (node) và mảng đang chứa một node. */
export function placeOf(document: ClipDocument, entity: Entity): { parent: Entity; list: Entity[] } {
  let found: { parent: Entity; list: Entity[] } | null = null;
  walk(document, (item) => {
    if (item.entity === entity && item.parent && item.list) found = { parent: item.parent, list: item.list };
  });
  if (!found) throw new OpFailure('That element is not in this project.');
  return found;
}

export function nodeById(document: ClipDocument, id: string): Entity {
  const found = byId(document, id);
  if (!found || found.entity.kind !== found.tag) throw new OpFailure(`There is no clip "${id}" in this project.`);
  if (found.tag === 'scene' || found.tag === 'stage') throw new OpFailure('The scene itself cannot be moved on the timeline.');
  return found.entity;
}

/** Tên kế tiếp dạng "Sequence 3": lớn hơn số lớn nhất đang có. */
export function nextName(document: ClipDocument, prefix: string): string {
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  let max = 0;
  walk(document, ({ entity }) => {
    const match = typeof entity.name === 'string' ? pattern.exec(entity.name) : null;
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `${prefix} ${max + 1}`;
}

// ------------------------------------------------------------------ ghi đè trong sequence

/** Một anh em nhường khoảng `[from, to)` mà clip vừa thả chiếm. */
function yieldSpan(
  document: ClipDocument,
  times: Map<ClipNode, TimeNode>,
  entity: Entity,
  list: Entity[],
  from: number,
  to: number,
  keep: Set<Entity>,
): void {
  const t = times.get(entity as unknown as ClipNode);
  if (!t || t.end <= from || t.start >= to) return;
  const remove = () => list.splice(list.indexOf(entity), 1);

  if (entity.kind === 'group' || entity.kind === 'sequence') {
    if (t.start >= from && t.end <= to) return void remove();
    const children = (entity.children as Entity[] | undefined) ?? [];
    for (const child of [...children]) {
      if (!keep.has(child)) yieldSpan(document, times, child, children, from, to, keep);
    }
    if (children.length === 0) remove();
    return;
  }

  const headCovered = t.start >= from;
  const tailCovered = t.end <= to;
  if (headCovered && tailCovered) remove();
  else if (tailCovered) trimOut(entity, t, from);
  else if (headCovered) trimIn(entity, t, to);
  else {
    // Thả vào giữa: còn lại một đầu và một đuôi. Sao chép TRƯỚC khi cắt, để
    // bản sao vẫn chạy tới đúng chỗ clip cũ chạy tới.
    const copy = copyOf(entity);
    list.splice(list.indexOf(entity) + 1, 0, copy);
    trimOut(entity, t, from);
    trimIn(copy, t, to);
  }
}

/** Mọi sequence mà các clip vừa thả nằm trong được dàn lại quanh chúng. */
export function settle(document: ClipDocument, ctx: OpContext, dropped: Entity[]): void {
  const keep = new Set(dropped);
  for (const entity of dropped) {
    const { parent, list } = placeOf(document, entity);
    if (parent.kind !== 'sequence') continue;
    const times = timesOf(document, ctx);
    const t = times.get(entity as unknown as ClipNode);
    if (!t || t.end <= t.start) continue;
    for (const sibling of [...list]) {
      if (!keep.has(sibling)) yieldSpan(document, times, sibling, list, t.start, t.end, keep);
    }
  }
}

// ------------------------------------------------------------------ op

const elementId = z.string().min(1).max(64);
const sceneSeconds = z.number().finite().min(0).max(24 * 3600);

type MoveElements = { element_ids: string[]; by: number };

export const moveElements = {
  name: 'move_elements',
  input: z.object({
    op: z.literal('move_elements'),
    element_ids: z.array(elementId).min(1).max(200),
    by: z.number().finite().min(-24 * 3600).max(24 * 3600),
  }),
  describe: (input: MoveElements) => `Move ${input.element_ids.length === 1 ? 'a clip' : `${input.element_ids.length} clips`}`,
  async apply(document: ClipDocument, input: MoveElements, ctx: OpContext) {
    const next = clone(document);
    const picked = input.element_ids.map((id) => nodeById(next, id));
    // Sequence không có thời gian riêng: dời nó là dời mọi con của nó.
    const moving = picked.flatMap((entity) => (entity.kind === 'sequence' ? ((entity.children as Entity[]) ?? []) : [entity]));
    const times = timesOf(next, ctx);
    const spans = moving.map((entity) => ({ entity, t: timeOf(times, entity) }));
    if (!spans.length) return document;
    // Không clip nào ra trước đầu scene: cả nhóm dừng khi clip sớm nhất chạm 0.
    const floor = -Math.min(...spans.map(({ t }) => t.start));
    const delta = Math.max(Math.round(input.by * FPS), floor);
    if (delta === 0) return document;
    for (const { entity, t } of spans) {
      if (!timed(entity)) throw new OpFailure('That element has no time of its own to move.');
      moveTo(entity, t, t.start + delta);
    }
    settle(next, ctx, moving);
    return next;
  },
};

type TrimElement = { element_id: string; edge: 'in' | 'out'; at: number };

/** Độ dài nguồn có thời gian của node (video/âm thanh, hoặc paint video), giây. */
function sourceSeconds(entity: Entity, ctx: OpContext): number | null {
  if ((entity.kind === 'video' || entity.kind === 'audio') && entity.src !== undefined) {
    return ctx.media?.duration(entity.src as never) ?? null;
  }
  for (const paint of (entity.paints as Entity[] | undefined) ?? []) {
    if (paint.type === 'video' && paint.src !== undefined) return ctx.media?.duration(paint.src as never) ?? null;
  }
  return null;
}

export const trimElement = {
  name: 'trim_element',
  input: z.object({
    op: z.literal('trim_element'),
    element_id: elementId,
    edge: z.enum(['in', 'out']),
    at: sceneSeconds,
  }),
  describe: (input: TrimElement) => (input.edge === 'in' ? 'Trim the start of a clip' : 'Trim the end of a clip'),
  async apply(document: ClipDocument, input: TrimElement, ctx: OpContext) {
    const next = clone(document);
    const entity = nodeById(next, input.element_id);
    if (!timed(entity)) throw new OpFailure('Trim the clips inside a sequence instead.');
    const t = timeOf(timesOf(next, ctx), entity);
    // Mép chỉ bị chặn bởi mép kia của chính nó và phần nguồn còn lại — hàng
    // bên cạnh không phải ràng buộc.
    let min = input.edge === 'in' ? 0 : t.start + 1;
    let max = input.edge === 'in' ? t.end - 1 : Infinity;
    const duration = sourceSeconds(entity, ctx);
    if (duration !== null) {
      if (input.edge === 'in') min = Math.max(min, Math.ceil(t.origin));
      else max = Math.min(max, Math.floor(t.origin + (duration * FPS) / t.rate));
    }
    if (min > max) return document;
    const frame = Math.min(max, Math.max(min, Math.round(input.at * FPS)));
    if (frame === (input.edge === 'in' ? t.start : t.end)) return document;
    if (input.edge === 'in') trimIn(entity, t, frame);
    else trimOut(entity, t, frame);
    settle(next, ctx, [entity]);
    return next;
  },
};

type SplitElements = { element_ids?: string[]; at: number };

export const splitElements = {
  name: 'split_elements',
  input: z.object({
    op: z.literal('split_elements'),
    element_ids: z.array(elementId).max(200).optional(),
    at: sceneSeconds,
  }),
  describe: () => 'Split at the playhead',
  async apply(document: ClipDocument, input: SplitElements, ctx: OpContext) {
    const next = clone(document);
    const frame = Math.round(input.at * FPS);
    const scene = activeScene(next) as unknown as Entity;
    const targets = input.element_ids?.length
      ? input.element_ids.map((id) => nodeById(next, id))
      : ((scene.children as Entity[] | undefined) ?? []);
    const times = timesOf(next, ctx);
    // Sequence không phải một clip: vết cắt rơi vào con mà mốc đang nằm trong.
    const units = targets
      .flatMap((entity) => (entity.kind === 'sequence' ? ((entity.children as Entity[]) ?? []) : [entity]))
      .filter((entity) => {
        const t = times.get(entity as unknown as ClipNode);
        return t && timed(entity) && t.start < frame && frame < t.end;
      });
    if (!units.length) return document;

    // Sao chép hết trước khi cắt: mỗi bản sao viết từ clip nguyên vẹn.
    const pairs = units.map((entity) => {
      const { parent, list } = placeOf(next, entity);
      const copy = copyOf(entity);
      list.splice(list.indexOf(entity) + 1, 0, copy);
      return { entity, copy, parent, list, t: timeOf(times, entity) };
    });
    for (const { entity, copy, t } of pairs) {
      trimOut(entity, t, frame);
      trimIn(copy, t, frame);
    }
    // Hai clip cạnh nhau thẳng dưới scene là hai lớp; bọc chúng lại để clip
    // vừa cắt vẫn đọc là một. Group/sequence đã gom con của nó sẵn.
    for (const { entity, copy, parent, list } of pairs) {
      if (CONTAINERS.has(parent.kind as string) && parent.kind !== 'scene') continue;
      const at = list.indexOf(entity);
      list.splice(list.indexOf(copy), 1);
      list.splice(at, 1, { kind: 'sequence', name: nextName(next, 'Sequence'), children: [entity, copy] });
    }
    return next;
  },
};

type MoveLayer = { element_id: string; parent_id: string; before_id?: string | null };

export const moveLayer = {
  name: 'move_layer',
  input: z.object({
    op: z.literal('move_layer'),
    element_id: elementId,
    parent_id: elementId,
    before_id: elementId.nullable().optional(),
  }),
  describe: () => 'Move a layer',
  async apply(document: ClipDocument, input: MoveLayer, ctx: OpContext) {
    const next = clone(document);
    const entity = nodeById(next, input.element_id);
    const target = byId(next, input.parent_id);
    if (!target || !CONTAINERS.has(target.tag) || target.entity.kind !== target.tag) {
      throw new OpFailure('Layers can only be moved into the scene, a group or a sequence.');
    }
    const parent = target.entity;
    // Không thả vào chính nó hay vào cây con của nó.
    let inside = false;
    walk({ version: 1, stage: { children: [entity] } } as unknown as ClipDocument, (item) => {
      if (item.entity === parent) inside = true;
    });
    if (inside) throw new OpFailure('A layer cannot be moved inside itself.');

    const from = placeOf(next, entity);
    const children = ((parent.children as Entity[] | undefined) ??= []);
    const anchor = input.before_id ? children.find((child) => child.id === input.before_id) : undefined;
    if (input.before_id && !anchor) throw new OpFailure('That position is not in the chosen layer.');
    if (anchor === entity) return document;
    if (from.list === children && !anchor && children[children.length - 1] === entity) return document;
    from.list.splice(from.list.indexOf(entity), 1);
    children.splice(anchor ? children.indexOf(anchor) : children.length, 0, entity);
    if (from.list.length === 0 && from.parent.kind === 'sequence') {
      // Sequence rỗng không còn là gì: gỡ nó khỏi cha của nó.
      const outer = placeOf(next, from.parent);
      outer.list.splice(outer.list.indexOf(from.parent), 1);
    }
    settle(next, ctx, [entity]);
    return next;
  },
};

type MoveKeyframe = { keyframe_id: string; time: number };

export const moveKeyframe = {
  name: 'move_keyframe',
  input: z.object({
    op: z.literal('move_keyframe'),
    keyframe_id: elementId,
    time: z.number().finite().min(-24 * 3600).max(24 * 3600),
  }),
  describe: () => 'Move a keyframe',
  async apply(document: ClipDocument, input: MoveKeyframe) {
    const next = clone(document);
    const found = byId(next, input.keyframe_id);
    if (!found || found.tag !== 'keyframe' || !found.list) throw new OpFailure('There is no such keyframe.');
    const time = seconds(Math.round(input.time * FPS));
    if (found.entity.time === time) return document;
    found.entity.time = time;
    // Giữ keyframe theo thứ tự thời gian trong file, như lúc được thêm vào.
    found.list.sort((a, b) => (a.time as number) - (b.time as number));
    return next;
  },
};

type SetWorkarea = { start?: number; end?: number; clear?: boolean };

export const setWorkarea = {
  name: 'set_workarea',
  input: z
    .object({ op: z.literal('set_workarea'), start: sceneSeconds.optional(), end: sceneSeconds.optional(), clear: z.boolean().optional() })
    .refine((input) => input.clear || (input.start !== undefined && input.end !== undefined), 'Give a start and an end.'),
  describe: (input: SetWorkarea) => (input.clear ? 'Clear the work area' : 'Set the work area'),
  async apply(document: ClipDocument, input: SetWorkarea) {
    const next = clone(document);
    const scene = activeScene(next) as unknown as Entity;
    if (input.clear) {
      if (scene.workarea == null) return document;
      delete scene.workarea;
      return next;
    }
    const start = Math.round(input.start! * FPS);
    const end = Math.round(input.end! * FPS);
    if (end <= start) throw new OpFailure('The work area must end after it starts.');
    scene.workarea = [seconds(start), seconds(end)];
    return next;
  },
};
