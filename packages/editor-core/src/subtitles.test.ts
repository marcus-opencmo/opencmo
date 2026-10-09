import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';
import { createRenderer, type MediaHost } from '@opencmo/clip-render';

import { subtitleCues, toSrt, toVtt } from './subtitles';

const words = 'Most freelancers chase late invoices every month'.split(' ').map((text, i) => ({ text, start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.4 }));
const media: MediaHost = { image: () => null, video: () => null, duration: () => 20, transcript: () => [{ start: 1, end: 5, text: '', words }] as never };
const doc = (captions: Record<string, unknown>, workarea: [number, number] = [0, 6]) =>
  ({
    version: 1,
    stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, workarea, children: [{ kind: 'captions', id: 'c', src: 't.json', start: 0, ...captions }] }] },
  }) as unknown as ClipDocument;

describe('subtitleCues', () => {
  it('cue theo đúng nhóm renderer hiện: maxWords 3 → 3 cue, mốc theo frame', () => {
    const cues = subtitleCues(createRenderer(doc({ preset: 'classic', maxWords: 3 }), media));
    // groupPhrases chia đều (2 + 2 + 3), không cắt tham 3 + 3 + 1.
    expect(cues.map((cue) => cue.text)).toEqual(['Most freelancers', 'chase late', 'invoices every month']);
    expect(cues[0]!.start).toBeCloseTo(1, 1);
    for (let index = 1; index < cues.length; index++) expect(cues[index]!.start).toBeGreaterThanOrEqual(cues[index - 1]!.end);
  });

  it('mốc tính từ đầu workarea, không từ đầu scene', () => {
    const cues = subtitleCues(createRenderer(doc({ preset: 'classic', maxWords: 3 }, [2, 6]), media));
    // Giây 2 của scene là đầu bản xuất: nhóm đang nói lúc đó là cue đầu, ở mốc 0.
    expect(cues[0]!).toMatchObject({ start: 0, text: 'chase late' });
  });

  it('SRT và VTT: đánh số, dấu phẩy/chấm, escape', () => {
    const cues = [
      { start: 0.5, end: 1.25, text: 'Tom & Jerry <3' },
      { start: 3661.001, end: 3662, text: 'a\n\nb' },
    ];
    expect(toSrt(cues)).toBe('1\n00:00:00,500 --> 00:00:01,250\nTom & Jerry <3\n\n2\n01:01:01,001 --> 01:01:02,000\na\nb\n');
    expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:00.500 --> 00:00:01.250\nTom &amp; Jerry &lt;3\n\n01:01:01.001 --> 01:01:02.000\na\nb\n');
  });
});
