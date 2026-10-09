/**
 * Bản tóm tắt có cấu trúc của một project: thứ agent đọc thay cho document thô
 * (spec AI Studio §6). Nhỏ, ổn định, và chỉ nói điều op làm được gì với nó.
 */

import type { ClipDocument } from '@opencmo/clip-doc';

import { readCaptionState, readCaptionStyle } from './captions';
import { activeView, timelineLabel, timelinesOf, walk } from './doc';
import { readFrame, type Frame } from './reframe';
import { keptDuration, keptRanges, round, type Range } from './transcript';

export type ElementSummary = {
  /** `id` của phần tử; null khi document chưa được stamp. */
  id: string | null;
  tag: string;
  start: number | null;
  end: number | null;
  /** Chữ của một `<text>`, tên scene, hoặc `src` của media. */
  label: string | null;
};

export type ProjectSummary = {
  frame: Frame | null;
  /** Độ dài clip sau khi cắt (giây). */
  duration: number | null;
  captions: { preset: string | null; colors: string[] | null; transcript: string | null } | null;
  /** Cửa sổ nguồn và các khoảng đã cắt, theo thang của file master. */
  cut: { window: Range; removed: Range[] } | null;
  elements: ElementSummary[];
  /** Chỉ có khi project có hơn một timeline (E2-a); mọi thứ khác ở trên là của timeline đang mở. */
  timelines?: { id: string | null; name: string; active: boolean; width: number; height: number }[];
};

/** Phần tử cấu trúc: agent không gọi tên chúng, liệt kê ra chỉ là nhiễu. */
const STRUCTURE = new Set(['stage', 'keyframeTrack', 'keyframe', 'effect']);

export function summarizeProject(full: ClipDocument): ProjectSummary {
  const document = activeView(full);
  const scenes = timelinesOf(full);
  const state = readCaptionState(document);
  const style = readCaptionStyle(document);
  const window = state?.window ?? null;
  const duration = window ? keptDuration(keptRanges(window, state?.removed ?? [])) : null;

  const elements: ElementSummary[] = [];
  walk(document, ({ entity, tag }) => {
    if (STRUCTURE.has(tag)) return;
    const value = (key: string) => entity[key];
    const number = (key: string) => (typeof value(key) === 'number' ? (value(key) as number) : null);
    let label = typeof value('src') === 'string' ? (value('src') as string) : null;
    if (tag === 'text') label = typeof value('text') === 'string' ? (value('text') as string).trim() : null;
    if (tag === 'scene') label = typeof value('name') === 'string' ? (value('name') as string) : null;
    elements.push({ id: entity.id ?? null, tag, start: number('start'), end: number('end'), label });
  });

  return {
    frame: readFrame(document),
    duration: duration === null ? null : round(duration),
    captions: style ? { ...style, transcript: state?.base ?? null } : null,
    cut: window ? { window, removed: state?.removed ?? [] } : null,
    elements,
    ...(scenes.length > 1
      ? {
          timelines: scenes.map((scene, index) => ({
            id: scene.id ?? null,
            name: timelineLabel(scene, index),
            active: timelinesOf(document)[0] === scene,
            width: scene.width,
            height: scene.height,
          })),
        }
      : {}),
  };
}
