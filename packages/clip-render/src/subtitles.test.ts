import { describe, expect, it } from 'vitest';

import { parseSubtitles, readTranscriptText, subtitleMime } from './subtitles.ts';

describe('file phụ đề (CAP-10)', () => {
  it('SRT: mỗi cue một đoạn, mốc từ chia theo số ký tự, bỏ thẻ', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Hi</i> there\r\n\r\n2\r\n00:00:04,500 --> 00:00:05,500\r\n{\\an8}Bye\r\n';
    const out = parseSubtitles(srt);
    expect(out.map((s) => s.text)).toEqual(['Hi there', 'Bye']);
    const [hi, there] = out[0]!.words;
    expect(hi).toEqual({ text: 'Hi', start: 1, end: 1 + (2 / 7) * 2 });
    expect(there!.end).toBe(3);
    expect(out[1]!.words[0]).toEqual({ text: 'Bye', start: 4.5, end: 5.5 });
  });

  it('VTT: bỏ header, NOTE, cài đặt cue, mốc karaoke; cue ngược hay rỗng bị bỏ; xếp theo giờ', () => {
    const vtt = [
      'WEBVTT', '', 'NOTE ghi chú', '',
      '00:10.000 --> 00:12.000 align:start position:0%', 'late <00:10.500><c>word</c>', '',
      '00:02.000 --> 00:01.000', 'backwards', '',
      '00:03.000 --> 00:04.000', '   ', '',
      '1:00:00.5 --> 1:00:01.5', 'hour', '',
      '00:01.000 --> 00:02.000', 'first', 'two lines',
    ].join('\n');
    const out = parseSubtitles(vtt);
    expect(out.map((s) => s.text)).toEqual(['first two lines', 'late word', 'hour']);
    expect(out[2]!.words[0]!.start).toBe(3600.5);
  });

  it('nhận loại theo đuôi file trước MIME; JSON sai dạng bị từ chối', () => {
    expect(subtitleMime('a.SRT', '')).toBe('application/x-subrip');
    expect(subtitleMime('a.vtt', 'text/plain')).toBe('text/vtt');
    expect(subtitleMime('a.json')).toBe('application/json');
    expect(subtitleMime('a.txt', 'text/plain')).toBeNull();
    const ok = [{ words: [{ text: 'a', start: 0, end: 1 }] }];
    expect(readTranscriptText(JSON.stringify(ok), 'application/json')).toEqual(ok);
    expect(() => readTranscriptText('{"a":1}', 'application/json')).toThrow('not a transcript');
  });
});
