import { describe, expect, it } from 'vitest';

import { censorTranscript, censorWord } from './profanity.ts';

describe('censor (E4-e)', () => {
  it('giữ chữ đầu, đủ số sao, dấu câu nguyên; từ thường không đổi', () => {
    expect(censorWord('Fucking!')).toBe('F******!');
    expect(censorWord('"shit,"')).toBe('"s***,"');
    expect(censorWord('class')).toBe('class');
    expect(censorWord('assess')).toBe('assess');
  });

  it('độ dài từ không đổi — khoảng ký tự của từ đang nói vẫn khớp', () => {
    const out = censorTranscript([{ text: 'oh shit really', words: [{ text: 'oh', start: 0, end: 1 }, { text: 'shit', start: 1, end: 2 }, { text: 'really', start: 2, end: 3 }] }]);
    expect(out[0]!.words.map((word) => word.text)).toEqual(['oh', 's***', 'really']);
    expect(out[0]!.text).toBe('oh s*** really');
  });
});
