/**
 * Đổi khung của clip (9:16, 1:1, 16:9 …) mà người nói vẫn ở đúng chỗ.
 *
 * Đổi `width`/`height` của scene là chưa đủ: hộp video, `x` và từng keyframe
 * bám mặt đều tính từ một "tâm quan tâm" (`focus`, chuẩn hoá theo bề ngang
 * NGUỒN) theo khung cũ — cùng công thức `xForFocus` của bộ sinh project
 * (`apps/web/lib/editor/generate-project.ts`). Ở đây tính lại cho khung mới.
 *
 * ## Mark để đổi đi đổi lại không mất gì
 *
 * Ở 16:9 với nguồn 16:9, hộp video bằng khung và `x` luôn là 0 — suy ngược
 * `focus` từ `x` lúc đó ra 0.5, tức track bám mặt biến mất sau một lượt
 * 9:16 → 16:9 → 9:16. Nên `focus` và track sống trong mark `reframe` của scene
 * (`{ focus, track: [[giây, focus]…], mode }`). Bộ sinh ghi nó từ dữ liệu bám
 * mặt; project cũ không có thì lần đổi khung đầu tiên suy nó rồi ghi vào.
 */

import type { ClipDocument, ClipNode, ReframeMark as StoredReframe, SceneNode, VideoNode } from '@opencmo/clip-doc';

import { rebuildLayout } from './layout';
import { activeView, assign, clone, isMaster, nodes, sceneOf, walk, type Entity } from './doc';
import { round } from './transcript';

export type FrameMode = 'fill' | 'fit';
export type Frame = { width: number; height: number; mode: FrameMode };
type Size = { width: number; height: number };
/** Mark đã đọc: `mode` luôn có (document cũ thiếu thì là `fill`). */
type ReframeMark = Required<StoredReframe>;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Cùng công thức với `xForFocus` của bộ sinh — hai công thức là hai khung khác nhau. */
export function xForFocus(focus: number, width: number, frame: number): number {
  return round(width >= frame ? clamp(frame / 2 - focus * width, frame - width, 0) : (frame - width) / 2);
}

/** Ngược của `xForFocus`, chỉ có nghĩa khi hộp rộng hơn khung. */
const focusForX = (x: number, width: number, frame: number): number =>
  width > frame ? clamp((frame / 2 - x) / width, 0, 1) : 0.5;

/** Vùng canvas thật (CSS px), để camera đặt khung vào giữa. */
export type Viewport = { width: number; height: number };

/** Chừa chỗ cho thanh khung ở trên và toolbar ở dưới, như editor bày. */
const VIEW_TOP = 72;
const VIEW_BOTTOM = 84;
const VIEW_SIDE = 40;

/**
 * Camera `[scale, 0, 0, scale, tx, ty]` đặt khung vừa khít vùng canvas; null là
 * camera mặc định (khung 1920×1080). Không biết vùng canvas thì theo công thức
 * `camera()` của bộ sinh.
 */
export function cameraFor(width: number, height: number, viewport?: Viewport): number[] | null {
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const areaW = Math.max(1, viewport.width - VIEW_SIDE * 2);
    const areaH = Math.max(1, viewport.height - VIEW_TOP - VIEW_BOTTOM);
    const scale = Math.round(Math.min(areaW / width, areaH / height) * 10000) / 10000;
    return [scale, 0, 0, scale, round((viewport.width - width * scale) / 2), round(VIEW_TOP + (areaH - height * scale) / 2)];
  }
  if (width === 1920 && height === 1080) return null;
  if (width === 1080 && height === 1920) return [0.25, 0, 0, 0.25, 235, 70];
  const scale = round(Math.min(580 / width, 330 / height));
  return [scale, 0, 0, scale, round((580 - width * scale) / 2), round((330 - height * scale) / 2)];
}

function reframeMark(scene: SceneNode): ReframeMark | null {
  const mark = scene.marks?.reframe;
  return mark ? { ...mark, mode: mark.mode ?? 'fill' } : null;
}

const masterVideos = (document: ClipDocument): VideoNode[] => nodes(document).filter(isMaster) as VideoNode[];

const num = (entity: object, key: string): number | undefined => {
  const value = (entity as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
};

/** Keyframe `x` của một video, theo thời gian tăng dần. */
function xKeyframes(video: VideoNode): Entity[] {
  const out: Entity[] = [];
  for (const track of video.tracks ?? []) {
    if (track.property !== 'x') continue;
    for (const keyframe of track.keyframes) {
      if (typeof keyframe.time === 'number' && typeof keyframe.value === 'number') out.push(keyframe as unknown as Entity);
    }
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

/** Khung hiện tại; null khi không có scene với kích thước số. */
export function readFrame(full: ClipDocument): Frame | null {
  const document = activeView(full);
  const scene = sceneOf(document);
  if (!scene || !scene.width || !scene.height) return null;
  const mark = reframeMark(scene);
  let mode: FrameMode = mark?.mode ?? 'fill';
  if (!mark) {
    // Không mark: hộp video lọt trong khung ở cả hai chiều là `fit`.
    const video = masterVideos(document)[0];
    const boxW = video ? num(video, 'width') : undefined;
    const boxH = video ? num(video, 'height') : undefined;
    if (boxW !== undefined && boxH !== undefined && boxW < scene.width - 0.5 && boxH <= scene.height + 0.5) mode = 'fit';
  }
  return { width: scene.width, height: scene.height, mode };
}

/** Node co giãn theo khung: mọi thứ trừ khung chứa, phụ đề và video master. */
const FIXED = new Set<ClipNode['kind']>(['scene', 'sequence', 'captions']);

/**
 * Đặt khung mới. `master` là kích thước THẬT của file nguồn — hộp video giữ
 * đúng tỉ lệ đó, không méo.
 */
export function writeFrame(input: ClipDocument, next: Frame, master: Size, viewport?: Viewport): ClipDocument {
  const document = clone(input);
  const scene = sceneOf(document);
  if (!scene || !scene.width || !scene.height) throw new Error('This project has no frame to resize.');
  const oldWidth = scene.width;
  const oldHeight = scene.height;
  const videos = masterVideos(document);

  let mark = reframeMark(scene);
  if (!mark) {
    // Suy từ video đầu tiên: `x` tĩnh và từng keyframe là focus theo khung cũ.
    const first = videos[0];
    const boxWidth = (first && num(first, 'width')) ?? oldWidth;
    const x = (first && num(first, 'x')) ?? 0;
    mark = {
      focus: round(focusForX(x, boxWidth, oldWidth)),
      track: (first ? xKeyframes(first) : []).map(
        (keyframe) => [keyframe.time as number, round(focusForX(keyframe.value as number, boxWidth, oldWidth))] as [number, number],
      ),
      mode: readFrame(input)?.mode ?? 'fill',
    };
  }
  mark = { ...mark, mode: next.mode };

  const ratioW = next.width / oldWidth;
  const ratioH = next.height / oldHeight;
  const media = Math.min(ratioW, ratioH);

  // Chữ, B-roll, hình: co giãn theo khung để không rơi ra ngoài. Chữ co theo
  // từng chiều (hộp chữ của bộ sinh lấy trọn bề ngang); media một hệ số cho cả
  // hai chiều để hình không méo. Viền co như media.
  walk(document, ({ entity, tag }) => {
    if (tag === 'stroke') {
      const width = num(entity, 'width');
      if (width !== undefined) entity.width = round(width * media);
      return;
    }
    if (entity.kind !== tag || FIXED.has(tag as ClipNode['kind']) || isMaster(entity as unknown as ClipNode)) return;
    const x = num(entity, 'x');
    const y = num(entity, 'y');
    if (x !== undefined) entity.x = round(x * ratioW);
    if (y !== undefined) entity.y = round(y * ratioH);
    const width = num(entity, 'width');
    const height = num(entity, 'height');
    if (tag === 'text') {
      if (width !== undefined) entity.width = round(width * ratioW);
      if (height !== undefined) entity.height = round(height * ratioH);
      const size = num(entity, 'fontSize');
      if (size !== undefined) entity.fontSize = Math.max(8, Math.round(size * Math.min(ratioW, ratioH)));
    } else {
      if (width !== undefined) entity.width = round(width * media);
      if (height !== undefined) entity.height = round(height * media);
    }
  });

  // Hộp video: cover cho `fill`, contain cho `fit` — đúng `videoBox` của bộ sinh.
  const scale =
    next.mode === 'fit'
      ? Math.min(next.width / master.width, next.height / master.height)
      : Math.max(next.width / master.width, next.height / master.height);
  const boxWidth = round(master.width * scale);
  const boxHeight = round(master.height * scale);
  const slides = next.mode === 'fill' && boxWidth > next.width;

  for (const video of videos) {
    const entity = video as unknown as Entity;
    entity.x = xForFocus(slides ? mark.focus : 0.5, boxWidth, next.width);
    entity.y = round((next.height - boxHeight) / 2);
    entity.width = boxWidth;
    entity.height = boxHeight;
    const frames = xKeyframes(video);
    const values = frames.map((keyframe, index) => {
      const focus =
        mark.track.find(([time]) => Math.abs(time - (keyframe.time as number)) < 1e-3)?.[1] ??
        mark.track[index]?.[1] ??
        mark.focus;
      keyframe.value = xForFocus(slides ? focus : 0.5, boxWidth, next.width);
      return keyframe.value as number;
    });
    // `x` tĩnh khớp keyframe đầu: DS đọc nó tới lúc playhead chạm mốc đầu, và
    // một giá trị khác ở đó là một cú giật khi bắt đầu phát.
    const first =
      values[0] ?? (slides && mark.track.length >= 2 ? xForFocus(mark.track[0]![1], boxWidth, next.width) : undefined);
    if (first !== undefined) entity.x = first;
    // Clip sinh ở khung ngang không có keyframe (hộp bằng khung, không có gì để
    // trượt) nhưng mark vẫn mang track bám mặt. Sang khung dọc thì dựng track đó.
    if (!frames.length && slides && mark.track.length >= 2) {
      video.tracks = [
        ...(video.tracks ?? []),
        {
          property: 'x',
          keyframes: mark.track.map(([time, focus]) => ({
            time: round(time),
            value: xForFocus(focus, boxWidth, next.width),
            easing: 'easeInOut',
          })),
        },
      ];
    }
  }

  scene.width = next.width;
  scene.height = next.height;
  assign(document.stage as unknown as Entity, 'camera', cameraFor(next.width, next.height, viewport) ?? undefined);
  scene.marks = { ...scene.marks, reframe: mark };
  // Dải người nói và panel tính theo khung: dựng lại từ mark `layout`.
  return rebuildLayout(document);
}

/**
 * Đặt lại camera cho khung hiện tại theo vùng canvas thật, không đổi gì khác.
 * Trả NGUYÊN document (cùng tham chiếu) khi camera đã đúng.
 */
export function fitCamera(input: ClipDocument, viewport: Viewport): ClipDocument {
  const frame = readFrame(input);
  if (!frame) return input;
  const camera = cameraFor(frame.width, frame.height, viewport) ?? undefined;
  const current = (input.stage as { camera?: number[] }).camera;
  if (JSON.stringify(current) === JSON.stringify(camera)) return input;
  const document = clone(input);
  assign(document.stage as unknown as Entity, 'camera', camera);
  return document;
}
