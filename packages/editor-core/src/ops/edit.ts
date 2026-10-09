/**
 * Op sửa clip học từ Palmier Pro (spec docs/specs/2026-10-03-hoc-palmier.md §B3–B5),
 * viết lại theo document của mình:
 *
 * - `set_fade`: fade vào/ra của một clip — hình đi bằng animation `fade`, tiếng
 *   bằng `gain` (cả hai renderer đã có, nên preview, export và ảnh vàng không đổi).
 *   Không cho fade dài quá nửa clip mỗi phía: hai fade chồng nhau là clip không
 *   bao giờ hiện rõ.
 * - `slip_element`: dời cửa sổ nguồn, giữ chỗ của clip trên timeline. Kẹp theo
 *   phần nguồn còn lại hai đầu; ảnh/chữ không có nguồn để slip.
 * - `ripple_delete`: xoá một clip và kéo các clip đứng SAU nó trong cùng cha lên
 *   lấp chỗ. Kiểm trước, đổi sau: video chính của clip không xoá kiểu này
 *   (cắt bằng transcript).
 * - `set_audio_roll`: J/L-cut ở một chỗ cắt của video chính (Palmier
 *   `manage_clip_links`) — dời điểm cắt tiếng, hình giữ nguyên (`captions.ts`).
 */

import { z } from 'zod';

import type { ClipDocument, ClipNode } from '@opencmo/clip-doc';

import { activeRoll, readCaptionState, readCutRoll, rollKey, segmentStarts, writeCaptionState } from '../captions';
import { clone, isMasterSound, sceneOf, type Entity } from '../doc';
import { keptRanges } from '../transcript';
import { OpFailure, type OpContext } from './context';
import { nodeById, parentOrigin, placeOf, timesOf } from './timeline';

const FPS = 30;
const elementId = z.string().min(1).max(64);
const seconds = (frames: number): number => Math.round((frames / FPS) * 1e4) / 1e4;
const AUDIBLE = new Set(['video', 'audio']);
const VISUAL = new Set(['text', 'rect', 'path', 'image', 'video', 'lottie', 'group', 'scene3d', 'sequence', 'captions']);

function timeOf(document: ClipDocument, ctx: OpContext, entity: Entity) {
  const t = timesOf(document, ctx).get(entity as unknown as ClipNode);
  if (!t) throw new OpFailure('That element is not in the active scene.');
  return t;
}

// ------------------------------------------------------------------ set_fade

type SetFade = { element_ids: string[]; in?: number; out?: number };

export const setFade = {
  name: 'set_fade',
  input: z
    .object({
      op: z.literal('set_fade'),
      element_ids: z.array(elementId).min(1).max(50),
      in: z.number().min(0).max(10).optional().describe('Seconds of fade-in at the start. 0 removes it; omit to keep.'),
      out: z.number().min(0).max(10).optional().describe('Seconds of fade-out at the end. 0 removes it; omit to keep.'),
    })
    .refine((input) => input.in !== undefined || input.out !== undefined, 'Give in, out, or both.'),
  describe: (input: SetFade) =>
    input.in === 0 && input.out === 0 ? 'Remove fades' : `Fade ${[input.in ? 'in' : '', input.out ? 'out' : ''].filter(Boolean).join(' and ') || 'off'}`,
  async apply(document: ClipDocument, input: SetFade, ctx: OpContext) {
    const next = clone(document);
    for (const id of new Set(input.element_ids)) {
      const entity = nodeById(next, id);
      const kind = entity.kind as string;
      if (!VISUAL.has(kind) && !AUDIBLE.has(kind)) throw new OpFailure(`A ${kind} cannot fade.`);
      const t = timeOf(next, ctx, entity);
      const half = Math.max(1, Math.floor((t.end - t.start) / 2));
      const animations = [...((entity.animations as Entity[] | undefined) ?? [])];
      for (const phase of ['in', 'out'] as const) {
        const value = input[phase];
        if (value === undefined) continue;
        // Mỗi phía một fade: bỏ fade/gain cũ của phía đó rồi ghi lại.
        for (let index = animations.length - 1; index >= 0; index--) {
          const animation = animations[index]!;
          if ((animation.type === 'fade' || animation.type === 'gain') && (animation.phase ?? 'in') === phase) animations.splice(index, 1);
        }
        if (value === 0) continue;
        const duration = seconds(Math.min(half, Math.round(value * FPS)));
        if (VISUAL.has(kind) && kind !== 'audio') animations.push({ type: 'fade', phase, duration });
        if (AUDIBLE.has(kind)) animations.push({ type: 'gain', phase, duration });
      }
      if (animations.length) entity.animations = animations;
      else delete entity.animations;
    }
    return next;
  },
};

// ------------------------------------------------------------------ slip_element

type SlipElement = { element_id: string; by: number };

export const slipElement = {
  name: 'slip_element',
  input: z.object({
    op: z.literal('slip_element'),
    element_id: elementId,
    by: z.number().min(-3600).max(3600).describe('Seconds to move the source window: positive shows later footage in the same slot.'),
  }),
  describe: () => 'Slip the footage inside a clip',
  async apply(document: ClipDocument, input: SlipElement, ctx: OpContext) {
    const next = clone(document);
    const entity = nodeById(next, input.element_id);
    if (entity.kind !== 'video' && entity.kind !== 'audio') throw new OpFailure('Only video and audio clips have footage to slip.');
    if (isMasterSound(entity as unknown as ClipNode)) throw new OpFailure("Cut the clip's own video from the transcript instead of slipping it.");
    const duration = ctx.media?.duration(entity.src as never) ?? null;
    if (duration === null) throw new OpFailure('The length of this media is not known yet. Try again in a moment.');
    const t = timeOf(next, ctx, entity);
    const rate = t.rate || 1;
    // Cửa sổ nguồn hiện tại (giây của file) và phần còn dư hai đầu.
    const span = ((t.end - t.start) * rate) / FPS;
    const inSec = typeof entity.sourceIn === 'number' ? entity.sourceIn : ((t.start - t.origin) * rate) / FPS;
    const room = { back: inSec, ahead: Math.max(0, duration - (inSec + span)) };
    const by = Math.max(-room.back, Math.min(room.ahead, input.by));
    if (Math.abs(by) < 1 / FPS) return document;
    const nextIn = Math.round((inSec + by) * 1e4) / 1e4;
    if (nextIn > 0) entity.sourceIn = nextIn;
    else delete entity.sourceIn;
    if (typeof entity.sourceOut === 'number') entity.sourceOut = Math.round((entity.sourceOut + by) * 1e4) / 1e4;
    // Giữ chỗ trên timeline: node chưa có end thì ghim end trước (không thì đuôi chạy theo).
    if (typeof entity.end !== 'number') entity.end = seconds(t.end - parentOrigin(t));
    if (typeof entity.start !== 'number' && t.start - parentOrigin(t) > 0) entity.start = seconds(t.start - parentOrigin(t));
    return next;
  },
};

// ------------------------------------------------------------------ ripple_delete

type RippleDelete = { element_id: string };

export const rippleDelete = {
  name: 'ripple_delete',
  input: z.object({ op: z.literal('ripple_delete'), element_id: elementId }),
  describe: () => 'Delete a clip and close the gap',
  async apply(document: ClipDocument, input: RippleDelete, ctx: OpContext) {
    const next = clone(document);
    const entity = nodeById(next, input.element_id);
    if (isMasterSound(entity as unknown as ClipNode)) throw new OpFailure("The clip's own video cannot be deleted. Cut it from the transcript instead.");
    if (entity.kind === 'captions') throw new OpFailure('Captions follow the video; cut the video instead.');
    const times = timesOf(next, ctx);
    const t = times.get(entity as unknown as ClipNode);
    if (!t) throw new OpFailure('That element is not in the active scene.');
    const gap = t.end - t.start;
    const { list } = placeOf(next, entity);
    // Anh em bắt đầu từ mép cuối trở đi dời lên đúng độ dài đã xoá — chỉ trong cùng cha.
    const followers = list.filter((sibling) => {
      if (sibling === entity) return false;
      const st = times.get(sibling as unknown as ClipNode);
      return st !== undefined && st.start >= t.end;
    });
    if (followers.some((sibling) => isMasterSound(sibling as unknown as ClipNode) || sibling.kind === 'captions')) {
      throw new OpFailure("Closing this gap would move the clip's own video or captions. Delete it without closing the gap.");
    }
    list.splice(list.indexOf(entity), 1);
    for (const sibling of followers) {
      if (typeof sibling.start === 'number') sibling.start = Math.max(0, seconds(Math.round(sibling.start * FPS) - gap));
      else continue;
      if (typeof sibling.end === 'number') sibling.end = seconds(Math.round(sibling.end * FPS) - gap);
    }
    return next;
  },
};

// ------------------------------------------------------------------ make_room

type MakeRoom = { at: number; seconds: number };

/**
 * Ripple insert (học Palmier insert_clips mode ripple): mở một khoảng trống ở `at` bằng cách
 * dời mọi lớp của timeline đang mở bắt đầu từ `at` trở đi lên sau `seconds` giây; rồi thêm
 * media vào khoảng đó. Lớp đang chiếu qua `at` giữ nguyên. Không dời video người nói/phụ đề
 * của clip (cắt chúng bằng transcript).
 */
export const makeRoom = {
  name: 'make_room',
  input: z.object({
    op: z.literal('make_room'),
    at: z.number().min(0).describe('Seconds on the timeline where the gap opens.'),
    seconds: z.number().positive().max(600).describe('Length of the gap.'),
  }),
  describe: (input: MakeRoom) => `Make ${input.seconds}s of room at ${input.at}s`,
  async apply(document: ClipDocument, input: MakeRoom, ctx: OpContext) {
    const next = clone(document);
    const scene = (sceneOf(next) as unknown as Entity | null);
    if (!scene) throw new OpFailure('This project has no timeline.');
    const times = timesOf(next, ctx);
    const at = Math.round(input.at * FPS);
    const gap = Math.round(input.seconds * FPS);
    const followers = ((scene.children as Entity[] | undefined) ?? []).filter((child) => {
      const t = times.get(child as unknown as ClipNode);
      // `timesOf` đếm bằng FRAME (như ripple_delete).
      return t !== undefined && t.start >= at;
    });
    if (!followers.length) return document;
    if (followers.some((child) => isMasterSound(child as unknown as ClipNode) || child.kind === 'captions')) {
      throw new OpFailure("Making room here would move the clip's own video or captions. Add the media on top instead, or make room after them.");
    }
    for (const child of followers) {
      const t = times.get(child as unknown as ClipNode)!;
      child.start = seconds(t.start + gap);
      if (typeof child.end === 'number') child.end = seconds(t.end + gap);
    }
    return next;
  },
};

// ------------------------------------------------------------------ set_caption_breaks

type CaptionBreaks = { max_words?: number | null; max_chars?: number | null; hold_gap?: number | null };

/**
 * Nhịp dòng phụ đề (học Palmier §C1) cho MỌI lớp phụ đề: trần chữ / ký tự mỗi
 * dòng (ngắt câu → mệnh đề → giữa) và giữ dòng qua khoảng lặng ngắn. null trả về
 * luật của preset.
 */
export const setCaptionBreaks = {
  name: 'set_caption_breaks',
  input: z
    .object({
      op: z.literal('set_caption_breaks'),
      max_words: z.number().int().min(1).max(20).nullable().optional().describe('Most words on screen at once. null = the preset rule.'),
      max_chars: z.number().int().min(4).max(80).nullable().optional().describe('Most characters on screen at once. null = the preset rule.'),
      hold_gap: z.number().min(0).max(2).nullable().optional().describe('Keep a line on screen through pauses shorter than this (seconds), so captions do not blink off between sentences. null = off.'),
    })
    .refine((input) => input.max_words !== undefined || input.max_chars !== undefined || input.hold_gap !== undefined, 'Nothing to change.'),
  describe: () => 'Change how captions break into lines',
  async apply(document: ClipDocument, input: CaptionBreaks) {
    const next = clone(document);
    let found = 0;
    const visit = (entity: Entity) => {
      if (entity.kind === 'captions') {
        found += 1;
        const set = (key: string, value: number | null | undefined) => {
          if (value === undefined) return;
          if (value === null || value === 0) delete entity[key];
          else entity[key] = value;
        };
        set('maxWords', input.max_words);
        set('maxChars', input.max_chars);
        set('holdGap', input.hold_gap);
      }
      for (const key of ['children', 'masks']) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
    };
    for (const node of next.stage.children) visit(node as unknown as Entity);
    if (!found) throw new OpFailure('This clip has no captions.');
    return next;
  },
};

// ---------------------------------------------------------------------------
// Khử ồn giọng nói (học Palmier §C7)

type CleanAudio = { op: 'clean_audio'; amount: number; element_id?: string };

/**
 * Đặt `denoise` cho video/audio. Không có `element_id`: mọi mảnh của video MASTER (cắt
 * chữ nhân video mẫu thành nhiều mảnh — thiếu một mảnh là ồn chỗ đó). Áp lúc export.
 */
export const cleanAudio = {
  name: 'clean_audio',
  input: z.object({
    op: z.literal('clean_audio'),
    amount: z.number().min(0).max(1).describe('0 = off; 0.4 = light; 0.6 = recommended for voice; 1 = strongest.'),
    element_id: z.string().optional().describe('A video or audio element; omit for the clip\'s own video (every cut piece).'),
  }),
  describe: (input: CleanAudio) => (input.amount > 0 ? `Clean up background noise (${Math.round(input.amount * 100)}%)` : 'Turn off noise cleanup'),
  async apply(document: ClipDocument, input: CleanAudio) {
    const next = clone(document);
    let found = 0;
    const visit = (entity: Entity) => {
      const hit = input.element_id
        ? entity.id === input.element_id
        : isMasterSound(entity as unknown as ClipNode);
      if (hit) {
        if (entity.kind !== 'video' && entity.kind !== 'audio') throw new OpFailure('Noise cleanup works on video and audio elements.');
        found += 1;
        if (input.amount > 0) entity.denoise = Math.round(input.amount * 100) / 100;
        else delete entity.denoise;
      }
      for (const key of ['children', 'masks']) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
    };
    for (const node of next.stage.children) visit(node as unknown as Entity);
    if (!found) throw new OpFailure(input.element_id ? `No element ${input.element_id}.` : 'This clip has no video of its own to clean.');
    return next;
  },
};

type SetAudioRoll = { at?: number; seconds: number };

/** Chỗ cắt gần `at` nhất (giây CLIP), trong nửa giây. */
const CUT_SNAP = 0.5;

export const setAudioRoll = {
  name: 'set_audio_roll',
  input: z.object({
    op: z.literal('set_audio_roll'),
    at: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe('Clip second of the cut (from get_project_state cuts or the timeline). Omit with seconds 0 to reset every cut.'),
    seconds: z
      .number()
      .min(-3)
      .max(3)
      .describe('Positive = L-cut: the sound of the shot before keeps playing over the next shot. Negative = J-cut: the next sound starts early, under the shot before. 0 = straight cut.'),
  }),
  describe: (input: SetAudioRoll) =>
    input.seconds === 0 ? 'Make the cut straight again' : `${input.seconds > 0 ? 'L-cut' : 'J-cut'} of ${Math.abs(input.seconds)}s`,
  async apply(document: ClipDocument, input: SetAudioRoll) {
    const state = readCaptionState(document);
    if (!state?.window || !state.removed.length) throw new OpFailure('This clip has no cuts yet: cut words or pauses first, then shape the cut.');
    const kept = keptRanges(state.window, state.removed);
    const starts = segmentStarts(kept);
    const roll = { ...readCutRoll(document) };
    if (input.at === undefined) {
      if (input.seconds !== 0) throw new OpFailure('Give the clip second of the cut.');
      return writeCaptionState(document, { base: state.base, removed: state.removed, roll: null });
    }
    let best = -1;
    for (let index = 1; index < kept.length; index++) {
      if (Math.abs(starts[index]! - input.at) <= CUT_SNAP && (best < 0 || Math.abs(starts[index]! - input.at) < Math.abs(starts[best]! - input.at))) best = index;
    }
    if (best < 0) throw new OpFailure(`There is no cut near ${input.at}s. Cuts are at ${starts.slice(1).map((value) => `${value}s`).join(', ') || 'no points yet'}.`);
    const key = rollKey(kept[best]!.start);
    if (input.seconds === 0) delete roll[key];
    else roll[key] = input.seconds;
    const applied = activeRoll(kept, state.window, roll).get(best) ?? 0;
    if (input.seconds !== 0 && applied === 0) throw new OpFailure('The shots around this cut are too short to overlap their sound.');
    return writeCaptionState(document, { base: state.base, removed: state.removed, roll });
  },
};
