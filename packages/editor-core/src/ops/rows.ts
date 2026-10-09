/**
 * Op của hàng timeline (`../tracks.ts`): chèn vào hàng cùng làn, dời clip sang
 * hàng khác, và chèn phụ đề không đè lên phụ đề đang chạy.
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';

import { byId, clone, sceneOf, walk, type Entity } from '../doc';
import { LANE_NAME, laneOf, placeInRow, rowName } from '../tracks';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';
import { nodeById, placeOf, settle, timesOf } from './timeline';

const elementId = z.string().min(1).max(64);
const node = z.record(z.string(), z.unknown()).refine((value) => typeof value.kind === 'string', 'A node needs a kind.');

const stripId = (input: Record<string, unknown>): ClipNode => {
  const copy = structuredClone(input) as Entity;
  delete copy.id;
  return copy as unknown as ClipNode;
};

type InsertToRow = { node: Record<string, unknown> };

/**
 * Chèn một b-roll/âm thanh vào hàng cùng làn còn trống chỗ (thư viện, thả lên
 * timeline, `insert_asset` của agent). `agent: false`: agent đi qua `insert_asset`.
 */
export const insertToRow = {
  name: 'insert_to_row',
  agent: false,
  input: z.object({ op: z.literal('insert_to_row'), node }),
  describe: () => 'Add media to the clip',
  async apply(document: ClipDocument, input: InsertToRow, ctx: OpContext) {
    if (!sceneOf(document)) throw new OpFailure('This project has no scene to edit.');
    return checked(placeInRow(document, stripId(input.node), ctx), 'That media cannot be added here');
  },
};

type MoveToRow = { element_ids: string[]; target_id: string };

const LANE_RULE: Record<string, string> = {
  visual: 'B-roll can only share a row with other B-roll.',
  captions: 'Captions can only share a row with captions.',
  audio: 'Audio can only share a row with audio.',
  text: 'Text can only share a row with text.',
  graphic: 'Shapes and visuals can only share a row with shapes and visuals.',
};

/** Gỡ một node khỏi chỗ cũ; sequence rỗng sau đó thì gỡ luôn. */
function detach(document: ClipDocument, entity: Entity): void {
  const from = placeOf(document, entity);
  from.list.splice(from.list.indexOf(entity), 1);
  if (from.list.length === 0 && from.parent.kind === 'sequence') {
    const outer = placeOf(document, from.parent);
    outer.list.splice(outer.list.indexOf(from.parent), 1);
  }
}

/** Con trực tiếp của scene chứa `entity` (chính nó nếu nó nằm thẳng dưới scene). */
function topOf(document: ClipDocument, entity: Entity): Entity {
  let current = entity;
  for (;;) {
    const { parent } = placeOf(document, current);
    if (parent.kind === 'scene') return current;
    current = parent;
  }
}

/**
 * Dời clip sang hàng của `target_id` (kéo bar lên/xuống timeline, "Put on one
 * row"). Đích là một hàng (sequence cùng làn) → vào hàng đó; đích là một clip
 * đơn → clip đó thành một hàng mới rồi nhận các clip dời tới; đích là scene →
 * clip ra một hàng riêng, ngay trên hàng cũ. Clip dời tới thắng chỗ chồng giờ
 * (anh em nhường, như ghi đè của NLE — luật `settle`).
 */
export const moveToRow = {
  name: 'move_to_row',
  input: z.object({ op: z.literal('move_to_row'), element_ids: z.array(elementId).min(1).max(200), target_id: elementId }),
  describe: (input: MoveToRow) => (input.element_ids.length === 1 ? 'Move a clip to another row' : `Move ${input.element_ids.length} clips to one row`),
  async apply(document: ClipDocument, input: MoveToRow, ctx: OpContext) {
    const next = clone(document);
    const scene = sceneOf(next) as unknown as Entity | undefined;
    if (!scene) throw new OpFailure('This project has no scene to edit.');
    const found = byId(next, input.target_id);
    if (!found || found.entity.kind !== found.tag) throw new OpFailure(`There is no row "${input.target_id}" in this clip.`);
    const target = found.entity;

    // Dời cả một hàng = dời mọi clip của nó.
    const moving: Entity[] = [];
    for (const id of new Set(input.element_ids)) {
      const entity = nodeById(next, id);
      const lane = laneOf(entity);
      if (!lane) throw new OpFailure('That layer cannot share a row with other clips.');
      if (entity.kind === 'sequence') moving.push(...((entity.children as Entity[] | undefined) ?? []));
      else moving.push(entity);
    }

    if (target === scene) {
      for (const entity of moving) {
        const { parent } = placeOf(next, entity);
        if (parent === scene) continue;
        const list = (scene.children as Entity[]) ?? [];
        const row = topOf(next, entity);
        const at = list.indexOf(row);
        detach(next, entity);
        // Hàng cũ còn thì clip lên ngay trên nó; hàng cũ biến mất thì clip vào đúng chỗ của nó.
        list.splice(list[at] === row ? at + 1 : at, 0, entity);
      }
      return checked(next, 'Those clips cannot be moved');
    }

    const lane = laneOf(target);
    if (!lane) throw new OpFailure('Clips cannot be moved into that row.');
    for (const entity of moving) {
      if (laneOf(entity) !== lane) throw new OpFailure(LANE_RULE[laneOf(entity)!] ?? 'Those clips cannot share a row.');
    }
    let row = target;
    const holder = target.kind === 'sequence' ? null : placeOf(next, target).parent;
    if (holder && holder.kind === 'sequence' && laneOf(holder) === lane) row = holder;
    else if (target.kind !== 'sequence') {
      // Clip đơn thành hàng: bọc tại chỗ, giữ thứ tự lớp.
      const { list } = placeOf(next, target);
      row = { kind: 'sequence', name: rowName(next, lane), children: [target] };
      list.splice(list.indexOf(target), 1, row);
    }
    const children = row.children as Entity[];
    const moved = moving.filter((entity) => !children.includes(entity));
    if (!moved.length) return document;
    for (const entity of moved) {
      detach(next, entity);
      children.push(entity);
    }
    settle(next, ctx, moved);
    return checked(next, `Those clips cannot be put on one ${LANE_NAME[lane]} row`);
  },
};

// ------------------------------------------------------------------ phụ đề không đè nhau

type Half = 'top' | 'bottom';

/** Nửa khung mà một lớp phụ đề đang chiếm (cùng cách `apartFrom` của voiceover). */
function halfOf(entity: Entity, height: number): Half {
  const align = (entity.verticalAlign as string | undefined) ?? 'bottom';
  const base = align === 'top' ? 0.1 : align === 'center' ? 0.5 : 0.9;
  const centre = base + (Number(entity.offsetY) || 0) / height;
  return centre > 0.45 ? 'bottom' : 'top';
}

const visible = (document: ClipDocument, entity: Entity): boolean => {
  let hidden = entity.hidden === true;
  walk(document, ({ entity: holder }) => {
    if (hidden || holder.kind === 'scene') return;
    const kids = (holder.children as Entity[] | undefined) ?? [];
    if (kids.includes(entity) && holder.hidden === true) hidden = true;
  });
  return !hidden;
};

/**
 * Chỗ cho một lớp phụ đề MỚI (`node` đã nằm trong `document`): có phụ đề khác
 * đang hiện cùng lúc ở cùng nửa khung thì đưa sang nửa kia — hai lớp in chồng
 * lên nhau là không đọc được dòng nào (UAT 09/10). Hai nửa đều có thì để nguyên.
 */
export function spreadCaptions(document: ClipDocument, node: Entity, ctx: Pick<OpContext, 'media'>): void {
  const height = Number(sceneOf(document)?.height) || 1920;
  const times = timesOf(document, ctx);
  const own = times.get(node as unknown as ClipNode);
  if (!own) return;
  const taken = new Set<Half>();
  walk(document, ({ entity, tag }) => {
    if (tag !== 'captions' || entity === node || !visible(document, entity)) return;
    const t = times.get(entity as unknown as ClipNode);
    if (t && t.start < own.end && own.start < t.end) taken.add(halfOf(entity, height));
  });
  const mine = halfOf(node, height);
  if (!taken.has(mine)) return;
  const other: Half = mine === 'bottom' ? 'top' : 'bottom';
  if (taken.has(other)) return;
  node.verticalAlign = other;
  node.offsetY = other === 'bottom' ? -Math.round(height * 0.12) : 0;
}

type InsertCaptions = { parent_id: string; node: Record<string, unknown> };

/**
 * Thêm một lớp phụ đề (Generate captions, dịch phụ đề, `add_captions` của
 * agent) — như `insert_node`, rồi tránh chỗ của phụ đề đang chạy cùng lúc.
 */
export const insertCaptions = {
  name: 'insert_captions',
  agent: false,
  input: z.object({ op: z.literal('insert_captions'), parent_id: elementId, node }),
  describe: () => 'Add captions',
  async apply(document: ClipDocument, input: InsertCaptions, ctx: OpContext) {
    if (input.node.kind !== 'captions') throw new OpFailure('insert_captions adds a captions layer.');
    const next = clone(document);
    const parent = byId(next, input.parent_id);
    if (!parent || (parent.tag !== 'scene' && parent.tag !== 'group') || parent.entity.kind !== parent.tag) {
      throw new OpFailure('Captions can only be added to the scene or a group.');
    }
    const entity = stripId(input.node) as unknown as Entity;
    ((parent.entity.children as Entity[] | undefined) ??= []).push(entity);
    spreadCaptions(next, entity, ctx);
    return checked(next, 'Those captions cannot be added');
  },
};
