/**
 * Xuất phụ đề SRT/VTT (học Palmier §C8). Không tự nhóm lại từ transcript: đọc
 * đúng chữ renderer đang hiện ở từng frame của bản xuất (`LayoutBox.caption`),
 * nên file khớp clip sau mọi lần cắt chữ, `maxWords`/`holdGap`, voiceover —
 * cùng một luật với preview và MP4, không có bản sao thứ hai để lệch.
 */

import type { Renderer } from '@opencmo/clip-render';

export type Cue = { start: number; end: number; text: string };

const FPS = 30;

/** Cue theo giây của BẢN XUẤT (0 = đầu workarea). Chữ đổi là cue mới; khoảng không ai nói thì trống. */
export function subtitleCues(renderer: Renderer): Cue[] {
  const { start, frames } = renderer.range;
  const cues: Cue[] = [];
  let open: { from: number; text: string } | null = null;
  const close = (at: number) => {
    if (open && at > open.from) cues.push({ start: open.from / FPS, end: at / FPS, text: open.text });
    open = null;
  };
  for (let index = 0; index < frames; index++) {
    const texts = renderer
      .layout(start + index)
      .filter((box) => box.visible && box.caption && box.values.opacity > 0)
      .map((box) => box.caption!.trim())
      .filter(Boolean);
    const text = [...new Set(texts)].join('\n');
    if (open && open.text === text) continue;
    close(index);
    if (text) open = { from: index, text };
  }
  close(frames);
  return cues;
}

function stamp(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

/** Dòng trống trong chữ sẽ cắt cue làm đôi ở cả hai định dạng — gộp lại. */
const clean = (text: string) => text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();

export function toSrt(cues: Cue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${clean(cue.text)}\n`).join('\n');
}

export function toVtt(cues: Cue[]): string {
  // "-->" trong chữ làm hỏng VTT; `&`/`<` phải escape (VTT đọc thẻ như HTML).
  const escape = (text: string) => clean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '→');
  return `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${escape(cue.text)}\n`).join('\n')}`;
}
