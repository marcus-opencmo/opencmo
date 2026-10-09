/**
 * Op của inspector (spec editor-rewrite B4): ghi prop, keyframe, và thêm/xếp
 * lại thành phần phụ (fill, stroke, shadow, effect, animation, stop, mask).
 *
 * Khác `update_element` (của Assistant) ở chỗ không giữ rào của agent: người
 * dùng được sửa thời gian của video master bằng tay trong inspector, như fork
 * cho phép. Rào còn lại là rào của DOCUMENT: không đổi danh tính phần tử, không
 * ghi cấu trúc (mảng con) qua đường prop, cỡ scene đi qua `set_frame`, và mọi
 * kết quả phải qua schema (`checked`).
 *
 * Xoá thành phần phụ dùng `delete_element` — mọi phần tử đều có id.
 */

import { z } from 'zod';

import { TRACK_PROPERTIES, type ClipDocument } from '@opencmo/clip-doc';

import { assign, byId, clone, type Entity } from '../doc';
import { OpFailure } from './context';
import { checked } from './project';

const FPS = 30;
const elementId = z.string().min(1).max(64);

/**
 * Khoá không ghi được qua prop: danh tính và cấu trúc có op riêng. `type` thì
 * ghi được (đổi loại effect/animation/chuyển cảnh); đổi loại fill mà để lại
 * khoá của loại cũ thì schema từ chối.
 */
const STRUCTURE = new Set([
  'id', 'kind', 'children', 'masks', 'marks', 'tracks', 'keyframes',
  'paints', 'strokes', 'shadows', 'effects', 'animations', 'stops', 'ranges',
]);

/** Bốn chữ số lẻ: đủ cho mọi frame 30 fps và mọi giá trị kéo từ thanh trượt. */
const tidy = (value: unknown): unknown =>
  typeof value === 'number'
    ? Math.round(value * 1e4) / 1e4
    : Array.isArray(value)
      ? value.map(tidy)
      : value;

function found(document: ClipDocument, id: string) {
  const hit = byId(document, id);
  if (!hit) throw new OpFailure(`There is no element "${id}" in this project.`);
  return hit;
}

type SetProps = { element_id: string; props: Record<string, unknown> };

export const setProps = {
  name: 'set_props',
  input: z.object({
    op: z.literal('set_props'),
    element_id: elementId,
    props: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), z.unknown())
      .refine((props) => Object.keys(props).length > 0, 'Nothing to change.'),
  }),
  describe: (input: SetProps) => `Change ${Object.keys(input.props).join(', ')}`,
  async apply(document: ClipDocument, input: SetProps) {
    const next = clone(document);
    const { entity, tag } = found(next, input.element_id);
    for (const key of Object.keys(input.props)) {
      if (STRUCTURE.has(key)) throw new OpFailure(`The "${key}" property cannot be changed here.`);
      if (tag === 'scene' && (key === 'width' || key === 'height')) {
        throw new OpFailure('Use the frame buttons to change the frame size.');
      }
    }
    for (const [key, value] of Object.entries(input.props)) {
      // `null` và `false` là vắng mặt: boolean vắng đọc là false, và document
      // không giữ null nào ngoài `transition`/`workarea` (vắng cũng như null).
      assign(entity, key, value === null || value === false ? undefined : tidy(value));
    }
    return checked(next, 'That value is not accepted');
  },
};

type SetKeyframe = {
  element_id: string;
  property: (typeof TRACK_PROPERTIES)[number];
  time: number;
  value?: number | string;
  easing?: string;
  remove?: boolean;
};

export const setKeyframe = {
  name: 'set_keyframe',
  input: z
    .object({
      op: z.literal('set_keyframe'),
      element_id: elementId,
      property: z.enum(TRACK_PROPERTIES),
      /** Giây CỤC BỘ của phần tử (thời gian nguồn), như `keyframe.time`. */
      time: z.number().finite().min(-24 * 3600).max(24 * 3600),
      value: z.union([z.number().finite(), z.string().min(1).max(64)]).optional(),
      easing: z.string().min(1).max(64).optional(),
      remove: z.boolean().optional(),
    })
    .refine((input) => input.remove || input.value !== undefined, 'Give a value for the keyframe.'),
  describe: (input: SetKeyframe) => (input.remove ? `Remove a ${input.property} keyframe` : `Set a ${input.property} keyframe`),
  async apply(document: ClipDocument, input: SetKeyframe) {
    const next = clone(document);
    const { entity } = found(next, input.element_id);
    const frame = Math.round(input.time * FPS);
    const tracks = (entity.tracks as Entity[] | undefined) ?? [];
    let track = tracks.find((item) => item.property === input.property);
    const keyframes = () => track!.keyframes as Entity[];
    const at = () => keyframes().findIndex((key) => Math.round((key.time as number) * FPS) === frame);

    if (input.remove) {
      if (!track || at() < 0) return document;
      keyframes().splice(at(), 1);
      if (!keyframes().length) tracks.splice(tracks.indexOf(track), 1);
      if (!tracks.length) delete entity.tracks;
      return checked(next, 'That keyframe could not be removed');
    }

    if (!track) {
      track = { property: input.property, keyframes: [] };
      tracks.push(track);
      entity.tracks = tracks;
    }
    const value = tidy(input.value);
    const index = at();
    if (index >= 0) {
      const key = keyframes()[index]!;
      key.value = value;
      if (input.easing !== undefined) key.easing = input.easing;
    } else {
      keyframes().push({ time: Math.round((frame / FPS) * 1e4) / 1e4, value, ...(input.easing ? { easing: input.easing } : {}) });
      keyframes().sort((a, b) => (a.time as number) - (b.time as number));
    }
    return checked(next, 'That keyframe is not accepted');
  },
};

const PART_KEYS = ['paints', 'strokes', 'shadows', 'effects', 'animations', 'stops', 'ranges', 'masks'] as const;
type AddPart = { element_id: string; key: (typeof PART_KEYS)[number]; part: Record<string, unknown>; index?: number };

export const addPart = {
  name: 'add_part',
  input: z.object({
    op: z.literal('add_part'),
    element_id: elementId,
    key: z.enum(PART_KEYS),
    part: z.record(z.string(), z.unknown()),
    index: z.number().int().min(0).optional(),
  }),
  describe: (input: AddPart) => `Add ${input.key === 'masks' ? 'a mask' : `a ${input.key.replace(/s$/, '')}`}`,
  async apply(document: ClipDocument, input: AddPart) {
    const next = clone(document);
    const { entity } = found(next, input.element_id);
    const list = ((entity[input.key] as Entity[] | undefined) ??= []);
    // Id do `applyOps` đặt: phần tử đầu vào không được mang id của ai khác.
    const part = structuredClone(input.part) as Entity;
    delete part.id;
    list.splice(Math.min(input.index ?? list.length, list.length), 0, part);
    return checked(next, 'That cannot be added here');
  },
};

type MovePart = { part_id: string; to: number };

export const movePart = {
  name: 'move_part',
  input: z.object({ op: z.literal('move_part'), part_id: elementId, to: z.number().int().min(0) }),
  describe: () => 'Reorder',
  async apply(document: ClipDocument, input: MovePart) {
    const next = clone(document);
    const { entity, list, tag } = found(next, input.part_id);
    if (!list || tag === 'stage') throw new OpFailure('That cannot be reordered.');
    const from = list.indexOf(entity);
    const to = Math.min(input.to, list.length - 1);
    if (from === to) return document;
    list.splice(from, 1);
    list.splice(to, 0, entity);
    return next;
  },
};

// ------------------------------------------------------------------ copy_settings

/**
 * "Làm giống cái kia" (học `copy_clip_settings` của Palmier Pro, spec
 * docs/specs/2026-10-03-hoc-palmier.md §A9): chép một nhóm thiết lập từ một
 * phần tử sang nhiều phần tử. Không bao giờ chép thời gian, vị trí, nội dung
 * chữ hay keyframe — chúng gắn với chỗ của từng phần tử.
 */
export const COPY_GROUPS = {
  /** Độ trong, bo góc, chế độ hoà trộn. */
  look: ['opacity', 'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft', 'blendMode'],
  /** Kiểu chữ: chỉ chữ sang chữ. */
  text: ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textCase', 'textAlign', 'leading', 'paints', 'strokes'],
  /** Hiệu ứng màu/mờ và bóng đổ. */
  effects: ['effects', 'shadows'],
  /** Animation vào/ra và chuyển cảnh. */
  motion: ['animations', 'transition'],
  /** Âm lượng (dB) và tắt tiếng. */
  audio: ['volume', 'muted'],
} as const;

type CopyGroup = keyof typeof COPY_GROUPS;
const VISUAL = new Set(['text', 'rect', 'path', 'image', 'video', 'lottie', 'group', 'scene3d', 'sequence']);
const AUDIBLE = new Set(['video', 'audio']);

/** Nhóm nào áp được từ loại `from` sang loại `to`. */
function fits(group: CopyGroup, from: string, to: string): boolean {
  if (group === 'text') return from === 'text' && to === 'text';
  if (group === 'audio') return AUDIBLE.has(from) && AUDIBLE.has(to);
  return VISUAL.has(from) && VISUAL.has(to);
}

/** Bản sao không còn id: thành phần phụ chép sang được stamp id mới. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (key !== 'id') out[key] = withoutIds(item);
  return out;
}

type CopySettings = { from_id: string; to_ids: string[]; groups?: CopyGroup[] };

export const copySettings = {
  name: 'copy_settings',
  input: z.object({
    op: z.literal('copy_settings'),
    from_id: elementId.describe('The element whose settings to copy.'),
    to_ids: z.array(elementId).min(1).max(50).describe('Elements to change.'),
    groups: z
      .array(z.enum(Object.keys(COPY_GROUPS) as [CopyGroup, ...CopyGroup[]]))
      .min(1)
      .optional()
      .describe('Which settings: look (opacity, corners, blend), text (font, size, color, stroke), effects, motion (animations, transition), audio (volume, mute). Default: every group that fits.'),
  }),
  describe: (input: CopySettings) => `Copy settings to ${input.to_ids.length} ${input.to_ids.length === 1 ? 'element' : 'elements'}`,
  async apply(document: ClipDocument, input: CopySettings) {
    const next = clone(document);
    const source = found(next, input.from_id);
    const groups = input.groups ?? (Object.keys(COPY_GROUPS) as CopyGroup[]);
    let applied = 0;
    for (const id of new Set(input.to_ids)) {
      if (id === input.from_id) continue;
      const target = found(next, id);
      const usable = groups.filter((group) => fits(group, source.tag, target.tag));
      if (!usable.length) {
        if (input.groups) throw new OpFailure(`"${id}" (${target.tag}) cannot take ${input.groups.join('/')} settings from a ${source.tag}.`);
        continue;
      }
      for (const group of usable) {
        for (const key of COPY_GROUPS[group]) assign(target.entity, key, structuredClone(withoutIds(source.entity[key])));
      }
      applied += 1;
    }
    if (!applied) throw new OpFailure('None of these elements can take settings from that one.');
    return checked(next, 'Those settings do not fit');
  },
};
