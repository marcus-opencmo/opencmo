import { describe, expect, it } from 'vitest';

import { fold, searchSpoken } from './search';
import type { Transcript } from './transcript';

const line = (start: number, text: string, prefix: string) => ({
  text,
  words: text.split(' ').map((word, i) => ({ id: `${prefix}${i}`, text: word, start: start + i * 0.5, end: start + i * 0.5 + 0.4 })),
});

const transcript: Transcript = [
  line(10, 'Most freelancers chase late invoices,', 'a'),
  line(14, 'and Café owners hate it.', 'b'),
  line(18, 'Late payments kill small studios.', 'c'),
];
const window = { start: 10, end: 22 };

describe('searchSpoken', () => {
  it('gấp chữ: bỏ dấu, dấu câu, hoa thường', () => {
    expect(fold('Café, owners!')).toBe('cafe owners');
  });

  it('cụm liên tiếp: id từ, giây nguồn, giây clip', () => {
    const hits = searchSpoken(transcript, { window, removed: [] }, 'late invoices');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ text: 'late invoices,', word_ids: ['a3', 'a4'], source: { start: 11.5, end: 12.4 }, clip: { start: 1.5, end: 2.4 }, match: 'phrase' });
    expect(hits[0]!.line).toBe('Most freelancers chase late invoices,');
  });

  it('một từ: mọi chỗ xuất hiện, từ cuối khớp tiền tố', () => {
    expect(searchSpoken(transcript, { window, removed: [] }, 'late').map((hit) => hit.word_ids)).toEqual([['a3'], ['c0']]);
    expect(searchSpoken(transcript, { window, removed: [] }, 'invoic')[0]!.word_ids).toEqual(['a4']);
    expect(searchSpoken(transcript, { window, removed: [] }, 'cafe')[0]!.word_ids).toEqual(['b1']);
  });

  it('đoạn đã cắt: clip null, removed true; mốc sau cắt dời lên', () => {
    const removed = [{ start: 10, end: 13 }];
    const cut = searchSpoken(transcript, { window, removed }, 'late invoices')[0]!;
    expect(cut).toMatchObject({ removed: true, clip: null });
    const later = searchSpoken(transcript, { window, removed }, 'late payments')[0]!;
    expect(later.clip).toEqual({ start: 5, end: 5.9 });
  });

  it('không có cụm: dòng có đủ mọi từ', () => {
    const hits = searchSpoken(transcript, { window, removed: [] }, 'studios late');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ match: 'words', word_ids: ['c0', 'c4'] });
  });

  it('câu hỏi rỗng hoặc không thấy: mảng rỗng', () => {
    expect(searchSpoken(transcript, { window, removed: [] }, '  ,, ')).toEqual([]);
    expect(searchSpoken(transcript, { window, removed: [] }, 'pricing')).toEqual([]);
  });
});
