/**
 * Transcript từ file phụ đề người dùng nhập (checklist CAP-10): `.json` (đúng
 * dạng `Transcript`), `.srt` và `.vtt`.
 *
 * Hành vi đọc từ fork: mỗi cue là một đoạn (ranh giới câu khi nhóm chữ); cue
 * không có mốc từng từ nên chia khoảng của cue cho các từ theo số ký tự. Thẻ
 * định dạng (`<i>`, `<c.x>`, mốc karaoke `<00:01.000>`) và lệnh kiểu SSA
 * (`{\an8}`) bị bỏ; cue rỗng hay có mốc ngược bị bỏ qua; kết quả xếp theo giờ.
 */

import type { Transcript, TranscriptWord } from './captions.ts';

export const SUBTITLE_TYPES = ['application/json', 'application/x-subrip', 'text/vtt'] as const;

/** Loại file phụ đề theo tên trước (hệ điều hành hiếm khi biết `.srt`), rồi theo MIME. */
export function subtitleMime(name: string, mime = ''): (typeof SUBTITLE_TYPES)[number] | null {
  const ext = name.toLowerCase().split('.').at(-1);
  if (ext === 'srt' || mime === 'application/x-subrip') return 'application/x-subrip';
  if (ext === 'vtt' || mime === 'text/vtt') return 'text/vtt';
  if (ext === 'json' || mime === 'application/json') return 'application/json';
  return null;
}

/** "01:02:03,450", "02:03.450" hay "2:03.4" → giây. */
function seconds(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(stamp.trim());
  if (!match) return null;
  const [, h, m, s, frac] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(frac) / 10 ** frac!.length;
}

const clean = (line: string) => line.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '');

function cueWords(text: string, start: number, end: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const chars = tokens.reduce((sum, token) => sum + token.length, 0);
  const span = end - start;
  let used = 0;
  return tokens.map((token) => {
    const from = start + (used / chars) * span;
    used += token.length;
    return { text: token, start: from, end: start + (used / chars) * span };
  });
}

export function parseSubtitles(text: string): Transcript {
  const out: Transcript = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let index = 0;
  while (index < lines.length) {
    const arrow = lines[index]!.indexOf('-->');
    if (arrow < 0) {
      index++;
      continue;
    }
    // Dòng mốc: "start --> end [cài đặt cue của VTT]".
    const start = seconds(lines[index]!.slice(0, arrow));
    const end = seconds(lines[index]!.slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
    index++;
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== '') body.push(clean(lines[index++]!));
    if (start === null || end === null || end <= start) continue;
    const words = cueWords(body.join(' '), start, end);
    if (words.length) out.push({ text: words.map((word) => word.text).join(' '), words });
  }
  return out.sort((a, b) => a.words[0]!.start - b.words[0]!.start);
}

/** Đọc file transcript theo loại; JSON phải đúng dạng `[{ words: [{ text, start, end }] }]`. */
export function readTranscriptText(text: string, mime: string): Transcript {
  if (mime === 'application/x-subrip' || mime === 'text/vtt') return parseSubtitles(text);
  const data = JSON.parse(text) as unknown;
  if (
    !Array.isArray(data) ||
    !data.every(
      (segment) =>
        segment &&
        Array.isArray((segment as { words?: unknown }).words) &&
        (segment as { words: unknown[] }).words.every(
          (word) =>
            word &&
            typeof (word as TranscriptWord).text === 'string' &&
            Number.isFinite((word as TranscriptWord).start) &&
            Number.isFinite((word as TranscriptWord).end),
        ),
    )
  ) {
    throw new Error('This file is not a transcript.');
  }
  return data as Transcript;
}
