/**
 * `apply_layout` (E5, học tool cùng tên của Palmier): xếp nhiều phần tử media vào các ô của
 * một trong 13 bố cục (`../layouts.ts`). Phần tử thư viện (B-roll, ảnh) nhận hộp = ô và
 * `objectFit` cover/contain + `objectPosition` theo điểm neo. Video của clip thì KHÔNG ghi
 * hộp trực tiếp (bám mặt, cắt chữ, đổi khung đều viết lại nó): ghi khoảng `cell` vào mark
 * `layout` rồi `rebuildLayout` dựng rect Speaker + mask như pip/side-by-side.
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';

import { byId, clone, isMaster, walk, type Entity } from '../doc';
import { mergeLayout, readLayout, writeLayout, MIN_RANGE } from '../layout';
import { anchorPoint, LAYOUT_ANCHOR_NAMES, LAYOUT_LABEL, layoutSlots, VIDEO_LAYOUTS, slotBox, type AnchorName, type VideoLayout } from '../layouts';
import { summarizeProject } from '../summary';
import { OpFailure, type OpContext } from './context';
import { checked } from './project';
import { timesOf } from './timeline';

const FPS = 30;
const elementId = z.string().min(1).max(64);
/** Track hình học bị bỏ khi xếp vào ô: bố cục là hộp tĩnh, như Palmier bỏ position/scale track. */
const PLACEMENT = new Set(['x', 'y', 'width', 'height', 'scale', 'scaleX', 'scaleY', 'rotation', 'offsetX', 'offsetY']);

type SlotInput = { slot: string; element_ids: string[]; anchor?: AnchorName; anchor_x?: number; anchor_y?: number };
type ApplyLayout = { layout: VideoLayout; slots: SlotInput[]; fit?: 'fill' | 'fit'; start?: number; end?: number };

/** Phần tử này là video của clip: đoạn master, sequence cắt chữ, hay rect Speaker của bố cục. */
function masterLike(entity: Entity): boolean {
  if (isMaster(entity as unknown as ClipNode)) return true;
  const marks = entity.marks as Record<string, unknown> | undefined;
  return (entity.kind === 'sequence' && !!marks?.['text-cut']) || marks?.layout === 'speaker';
}

const mediaPaints = (entity: Entity) =>
  ((entity.paints as Entity[] | undefined) ?? []).filter((paint) => paint.type === 'image' || paint.type === 'video');

/** Danh sách cha + vị trí của một node trong document (để đổi thứ tự lớp). */
function locate(document: ClipDocument, entity: Entity): { list: Entity[]; parent: Entity } | null {
  let found: { list: Entity[]; parent: Entity } | null = null;
  walk(document, (item) => {
    if (item.entity === entity) found = { list: item.list as Entity[], parent: item.parent as Entity };
  });
  return found;
}

/** Cha có biến đổi thì toạ độ ô (theo khung) không còn đúng: chỉ nhận cha "trung tính". */
function neutralParent(parent: Entity): boolean {
  if (parent.kind === 'scene') return true;
  if (parent.kind !== 'group' && parent.kind !== 'sequence') return false;
  return ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'offsetX', 'offsetY'].every((key) => !parent[key]) && !parent.tracks;
}

export const applyLayout = {
  name: 'apply_layout',
  input: z.object({
    op: z.literal('apply_layout'),
    layout: z.enum(VIDEO_LAYOUTS),
    slots: z
      .array(
        z.object({
          slot: z.string().min(1).max(20).describe('Slot id of the layout, e.g. left/right, main/inset, r1c2, main/sidebar, top/middle/bottom.'),
          element_ids: z.array(elementId).min(1).max(20).describe('Elements shown in this slot (several = one after another in time).'),
          anchor: z.enum(LAYOUT_ANCHOR_NAMES).optional().describe('Which part of the media to keep when it is cropped (fill) or where to push it (fit). Default center.'),
          anchor_x: z.number().min(0).max(1).optional(),
          anchor_y: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1)
      .max(16),
    fit: z.enum(['fill', 'fit']).optional().describe('fill crops to cover the slot (default); fit shows the whole media inside it.'),
    start: z.number().finite().min(0).optional().describe("Clip seconds the clip's own video stays in its slot (default: while the other elements play)."),
    end: z.number().finite().min(0).optional(),
  }),
  describe: (input: ApplyLayout) => {
    const count = input.slots.reduce((sum, slot) => sum + slot.element_ids.length, 0);
    return `Arrange ${count} ${count === 1 ? 'element' : 'elements'}: ${LAYOUT_LABEL[input.layout]}`;
  },
  async apply(document: ClipDocument, input: ApplyLayout, ctx?: OpContext) {
    const next = clone(document);
    const slots = layoutSlots(input.layout);
    const byIdSlot = new Map(slots.map((slot) => [slot.id, slot]));
    const seenSlots = new Set<string>();
    const seenElements = new Set<string>();
    for (const entry of input.slots) {
      if (!byIdSlot.has(entry.slot)) {
        throw new OpFailure(`"${entry.slot}" is not a slot of ${input.layout}. Slots: ${slots.map((slot) => slot.id).join(', ')}.`);
      }
      if (seenSlots.has(entry.slot)) throw new OpFailure(`Slot "${entry.slot}" is listed twice.`);
      seenSlots.add(entry.slot);
      for (const id of entry.element_ids) {
        if (seenElements.has(id)) throw new OpFailure(`"${id}" is in more than one slot; each element fills one slot.`);
        seenElements.add(id);
      }
    }
    const missing = slots.filter((slot) => !seenSlots.has(slot.id)).map((slot) => slot.id);
    if (missing.length) throw new OpFailure(`${input.layout} needs every slot filled. Missing: ${missing.join(', ')}.`);

    const scene = next.stage.children.find((node) => node.kind === 'scene' && (node as { active?: boolean }).active) ?? next.stage.children.find((node) => node.kind === 'scene');
    const W = Number((scene as unknown as Entity | undefined)?.width ?? 0);
    const H = Number((scene as unknown as Entity | undefined)?.height ?? 0);
    if (!W || !H) throw new OpFailure('This project has no frame to lay out.');

    // Giải từng phần tử: video của clip hay media thư viện.
    type Placed = { slot: (typeof slots)[number]; entry: SlotInput; entity: Entity; master: boolean };
    const placed: Placed[] = [];
    for (const entry of input.slots) {
      for (const id of entry.element_ids) {
        const hit = byId(next, id);
        if (!hit) throw new OpFailure(`There is no element "${id}" in this project.`);
        const entity = hit.entity;
        const master = masterLike(entity);
        const media = entity.kind === 'video' || entity.kind === 'image' || (entity.kind === 'rect' && mediaPaints(entity).length > 0);
        if (!master && !media) throw new OpFailure(`"${id}" is a ${String(entity.kind)}; layouts take video and image elements.`);
        placed.push({ slot: byIdSlot.get(entry.slot)!, entry, entity, master });
      }
    }
    const masters = placed.filter((item) => item.master);
    if (new Set(masters.map((item) => item.slot.id)).size > 1) throw new OpFailure("The clip's own video can fill only one slot.");

    // Mọi ô phải có lúc cùng chiếu (video của clip chiếu suốt clip).
    const times = timesOf(next, ctx ?? {});
    const spans = new Map<string, [number, number][]>();
    for (const item of placed) {
      if (item.master) continue;
      const t = times.get(item.entity as unknown as ClipNode);
      if (!t) throw new OpFailure(`"${String(item.entity.id)}" is not on the open timeline.`);
      spans.set(item.slot.id, [...(spans.get(item.slot.id) ?? []), [t.start, t.end]]);
    }
    const others = [...spans.values()];
    if (others.length > 1) {
      const candidates = others.flat().map(([start]) => start);
      const together = candidates.some((frame) => others.every((list) => list.some(([start, end]) => start <= frame && frame < end)));
      if (!together) throw new OpFailure('These elements never play at the same time, so no frame shows every slot. Overlap their times first.');
    }

    // Media thư viện: hộp = ô, cover/contain + điểm neo; bỏ track hình học cũ.
    const objectFit = input.fit === 'fit' ? 'contain' : 'cover';
    for (const item of placed) {
      if (item.master) continue;
      const where = locate(next, item.entity);
      if (!where || !neutralParent(where.parent)) {
        throw new OpFailure(`"${String(item.entity.id)}" is inside a moved or scaled group; ungroup it before applying a layout.`);
      }
      const entity = item.entity;
      const position = anchorPoint(item.entry.anchor, item.entry.anchor_x, item.entry.anchor_y);
      const centered = position[0] === 0.5 && position[1] === 0.5;
      for (const key of PLACEMENT) delete entity[key];
      const tracks = ((entity.tracks as { property: string }[] | undefined) ?? []).filter((track) => !PLACEMENT.has(track.property));
      if (tracks.length) entity.tracks = tracks;
      else delete entity.tracks;
      Object.assign(entity, slotBox(item.slot.rect, W, H));
      const targets = entity.kind === 'rect' ? mediaPaints(entity) : [entity];
      for (const target of targets) {
        target.objectFit = objectFit;
        if (centered) delete target.objectPosition;
        else target.objectPosition = position;
      }
    }

    // Thứ tự lớp: ô có z cao (ô PiP) phải vẽ sau ô z thấp nằm cùng danh sách cha.
    for (const high of placed.filter((item) => item.slot.z > 0 && !item.master)) {
      const where = locate(next, high.entity)!;
      const lowers = placed.filter((item) => item.slot.z < high.slot.z && !item.master).map((item) => where.list.indexOf(item.entity)).filter((index) => index >= 0);
      const last = Math.max(-1, ...lowers);
      const index = where.list.indexOf(high.entity);
      if (last > index) {
        where.list.splice(index, 1);
        where.list.splice(last, 0, high.entity);
      }
    }

    let out = next;
    const master = masters[0];
    const ranges = readLayout(next);
    if (master) {
      // Video của clip ở ô nền (z thấp) còn media ở ô PiP: media phải nằm TRÊN người nói — đã vậy
      // (media thêm sau master). Người nói ở ô PiP: media ô nền dời xuống dưới khung người nói.
      if (master.slot.z > 0) {
        const anchor = nodesUnderSpeaker(next);
        if (anchor) {
          for (const item of placed.filter((candidate) => !candidate.master && candidate.slot.z < master.slot.z)) {
            const where = locate(next, item.entity)!;
            if (where.list !== anchor.list) throw new OpFailure(`"${String(item.entity.id)}" must sit next to the clip's video to go under it; move it out of its group first.`);
            where.list.splice(where.list.indexOf(item.entity), 1);
            anchor.list.splice(anchor.list.indexOf(anchor.entity), 0, item.entity);
          }
        }
      }
      const duration = Number(((scene as unknown as Entity).workarea as [number, number] | undefined)?.[1] ?? summarizeProject(next).duration ?? 0);
      const framesOf = [...spans.values()].flat();
      const start = input.start ?? (framesOf.length ? Math.max(0, Math.min(...framesOf.map(([s]) => s)) / FPS) : 0);
      const end = Math.min(input.end ?? (framesOf.length ? Math.max(...framesOf.map(([, e]) => e)) / FPS : duration), duration || Infinity);
      if (!(end - start >= MIN_RANGE)) throw new OpFailure(`The layout needs at least ${MIN_RANGE} seconds inside the clip.`);
      const full = master.slot.rect.every((value, index) => value === [0, 0, 1, 1][index]) && input.fit !== 'fit';
      const entry = master.entry;
      const focus = entry.anchor || entry.anchor_x !== undefined || entry.anchor_y !== undefined ? anchorPoint(entry.anchor, entry.anchor_x, entry.anchor_y) : undefined;
      const merged = full
        ? mergeLayout(ranges, { start, end, mode: 'full', ratio: 0.5 })
        : mergeLayout(ranges, { start, end, mode: 'cell', ratio: 1, rect: master.slot.rect, ...(focus ? { focus } : {}), ...(input.fit === 'fit' ? { fit: 'fit' as const } : {}) });
      out = writeLayout(next, merged);
    }
    return checked(out, 'That layout is not accepted');
  },
};

/** Node đầu tiên của khung người nói (rect Speaker hay video/sequence của clip) và danh sách chứa nó. */
function nodesUnderSpeaker(document: ClipDocument): { list: Entity[]; entity: Entity } | null {
  let found: { list: Entity[]; entity: Entity } | null = null;
  walk(document, (item) => {
    if (found) return;
    const entity = item.entity;
    const marks = entity.marks as Record<string, unknown> | undefined;
    if (marks?.layout === 'backdrop' || marks?.layout === 'speaker' || (entity.kind === 'sequence' && marks?.['text-cut']) || isMaster(entity as unknown as ClipNode)) {
      found = { list: item.list as Entity[], entity };
    }
  });
  return found;
}
