/**
 * Tìm theo lời nói trong transcript của clip (học `search_media` scope spoken
 * của Palmier Pro, spec docs/specs/2026-10-03-hoc-palmier.md §A5).
 *
 * Khớp cụm từ liên tiếp trước (không phân biệt hoa thường, dấu, dấu câu); không
 * có cụm thì khớp "đủ mọi từ trong cùng một dòng". Mỗi kết quả có id từ (cho
 * remove_words), giây NGUỒN (cho remove_ranges) và giây CLIP (cho visual,
 * insert_asset) — null khi đoạn đó đã bị cắt.
 */

import { isRemoved, keptRanges, round, toOutput, type Range, type Transcript, type Word } from './transcript';

/** Bỏ dấu, dấu câu, hoa thường — "Café," và "cafe" là một. */
export const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();

export type SpokenHit = {
  /** Cả dòng phụ đề chứa kết quả, để model thấy ngữ cảnh. */
  line: string;
  /** Đúng các chữ khớp. */
  text: string;
  word_ids: string[];
  source: Range;
  /** Giây trên clip sau cắt; null khi phần này đã bị cắt khỏi video. */
  clip: Range | null;
  removed: boolean;
  match: 'phrase' | 'words';
};

export function searchSpoken(
  transcript: Transcript,
  cut: { window: Range; removed: Range[] },
  query: string,
  limit = 20,
): SpokenHit[] {
  const needle = fold(query).split(' ').filter(Boolean);
  if (!needle.length) return [];
  const kept = keptRanges(cut.window, cut.removed);
  const hits: SpokenHit[] = [];

  const hit = (words: Word[], lineWords: Word[], match: SpokenHit['match']): SpokenHit => {
    const source = { start: round(words[0]!.start), end: round(words[words.length - 1]!.end) };
    const removed = words.every((word) => isRemoved(word, cut.removed));
    const start = toOutput(source.start, kept);
    const end = toOutput(source.end, kept);
    return {
      line: lineWords.map((word) => word.text).join(' ').trim(),
      text: words.map((word) => word.text).join(' ').trim(),
      word_ids: words.map((word) => word.id).filter((id): id is string => typeof id === 'string'),
      source,
      clip: removed || start === null || end === null ? null : { start, end },
      removed,
      match,
    };
  };

  // Cụm liên tiếp: so trên dãy từ đã gấp của cả transcript (cụm có thể vắt qua hai dòng).
  const flat = transcript.flatMap((segment, s) => segment.words.map((word) => ({ word, s, key: fold(word.text) })));
  for (let i = 0; i < flat.length && hits.length < limit; i++) {
    let j = 0;
    let k = i;
    while (j < needle.length && k < flat.length) {
      const key = flat[k]!.key;
      if (!key) {
        k++;
        continue;
      }
      // Từ cuối của câu hỏi được phép là tiền tố ("invoic" khớp "invoices").
      const ok = j === needle.length - 1 ? key.startsWith(needle[j]!) : key === needle[j];
      if (!ok) break;
      j++;
      k++;
    }
    if (j === needle.length) {
      const words = flat.slice(i, k).map((item) => item.word);
      hits.push(hit(words, transcript[flat[i]!.s]!.words, 'phrase'));
      i = k - 1;
    }
  }
  if (hits.length || needle.length === 1) return hits;

  // Không có cụm: dòng chứa đủ mọi từ (bất kể thứ tự).
  for (const segment of transcript) {
    if (hits.length >= limit) break;
    const matched = segment.words.filter((word) => needle.some((n) => fold(word.text).startsWith(n)));
    const covered = needle.every((n) => matched.some((word) => fold(word.text).startsWith(n)));
    if (covered) hits.push(hit(matched, segment.words, 'words'));
  }
  return hits;
}
