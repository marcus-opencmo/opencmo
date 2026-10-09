import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { checkDocument } from './check';
import { findSilences } from './silences';
import { summarizeProject } from './summary';
import { applyOps, type OpContext } from './ops';
import type { Transcript } from './transcript';

const doc = (children: unknown[], size = { width: 1080, height: 1920 }): ClipDocument =>
  ({
    version: 1,
    stage: { children: [{ kind: 'scene', id: 'sc', ...size, children }] },
  }) as unknown as ClipDocument;

const media = (durations: Record<string, number>, exists?: string[]) => ({
  duration: (src: unknown) => (typeof src === 'string' ? (durations[src] ?? null) : null),
  exists: exists ? (src: string) => exists.includes(src) : undefined,
});

const codes = (report: ReturnType<typeof checkDocument>) => report.issues.map((issue) => issue.code).sort();

describe('checkDocument', () => {
  it('video phủ kín khung: sạch', () => {
    const report = checkDocument(
      doc([{ kind: 'video', id: 'v', src: 'a.mp4', width: 1080, height: 1920 }]),
      media({ 'a.mp4': 5 }),
    );
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.duration).toBe(5);
  });

  it('khoảng đen giữa hai clip, và mốc giây của nó', () => {
    const report = checkDocument(
      doc([
        { kind: 'video', id: 'a', src: 'a.mp4', width: 1080, height: 1920, end: 2 },
        { kind: 'video', id: 'b', src: 'a.mp4', width: 1080, height: 1920, start: 3, end: 5 },
      ]),
      media({ 'a.mp4': 10 }),
    );
    expect(report.ok).toBe(false);
    const gap = report.issues.find((issue) => issue.code === 'black-gap')!;
    expect(gap.start).toBe(2);
    expect(gap.end).toBe(3);
  });

  it('không có gì để xem, chữ trong suốt, node ra ngoài khung, nguồn thiếu', () => {
    expect(codes(checkDocument(doc([]), media({})))).toContain('no-visuals');
    const report = checkDocument(
      doc([
        { kind: 'video', id: 'v', src: 'gone.mp4', width: 1080, height: 1920 },
        { kind: 'text', id: 't', text: 'Hi', opacity: 0, end: 2 },
        { kind: 'rect', id: 'r', fill: '#fff', x: 5000, y: 5000, width: 100, height: 100, end: 2 },
      ]),
      media({}, ['assets/master.mp4']),
    );
    expect(codes(report)).toEqual(expect.arrayContaining(['missing-source', 'transparent', 'offscreen']));
  });

  it('độ dài 0 và bắt đầu sau khi clip hết', () => {
    const report = checkDocument(
      doc([
        { kind: 'video', id: 'v', src: 'a.mp4', width: 1080, height: 1920 },
        { kind: 'rect', id: 'z', fill: '#fff', start: 1, end: 1 },
        { kind: 'rect', id: 'late', fill: '#fff', start: 9, end: 10 },
      ]),
      media({ 'a.mp4': 4 }),
    );
    expect(codes(report)).toEqual(expect.arrayContaining(['zero-duration']));
  });
});

describe('subject-offscreen', () => {
  // Nguồn 16:9 phóng theo chiều cao lên 1920: hộp 3413.33 px. Mặt ở 0.3 tới
  // giây 4 rồi đổi cảnh sang 0.75 (hai mốc cách nhau một frame).
  const W = 3413.33;
  const xFor = (focus: number) => 540 - focus * W;
  const scene = (video: Record<string, unknown>) =>
    ({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene',
            id: 'sc',
            width: 1080,
            height: 1920,
            marks: { reframe: { focus: 0.3, mode: 'fill', track: [[0, 0.3], [3.967, 0.3], [4, 0.75], [10, 0.75]] } },
            children: [{ kind: 'video', id: 'v', src: 'assets/master.mp4', y: 0, width: W, height: 1920, ...video }],
          },
        ],
      },
    }) as unknown as ClipDocument;
  const master = media({ 'assets/master.mp4': 10 });

  it('x ghim ở tâm cũ: người nói ra khỏi khung từ lúc đổi cảnh', () => {
    const report = checkDocument(scene({ x: xFor(0.3) }), master);
    const lost = report.issues.filter((issue) => issue.code === 'subject-offscreen');
    expect(report.ok).toBe(false);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.start).toBe(4);
    expect(lost[0]!.end).toBe(10);
  });

  it('keyframe x bám theo track: sạch', () => {
    const tracks = [
      {
        property: 'x',
        keyframes: [
          { time: 3.967, value: xFor(0.3) },
          { time: 4, value: xFor(0.75) },
        ],
      },
    ];
    const report = checkDocument(scene({ x: xFor(0.3), tracks }), master);
    expect(report.issues.filter((issue) => issue.code === 'subject-offscreen')).toEqual([]);
  });
});

const transcript: Transcript = [
  {
    text: 'so um we built this',
    words: [
      { id: 'w1', text: 'so', start: 0.2, end: 0.4 },
      { id: 'w2', text: 'um', start: 0.5, end: 0.7 },
      { id: 'w3', text: 'we', start: 2.0, end: 2.2 },
      { id: 'w4', text: 'built', start: 2.3, end: 2.6 },
      { id: 'w5', text: 'this', start: 2.7, end: 3.0 },
    ],
  },
];

describe('findSilences', () => {
  it('khoảng hở giữa hai từ, đầu và đuôi; gợi ý cắt chừa `keep`', () => {
    const silences = findSilences({ transcript, window: { start: 0, end: 4.5 }, removed: [] }, { minGap: 0.5, keep: 0.2 });
    expect(silences.map((item) => [item.start, item.end])).toEqual([
      [0.7, 2],
      [3, 4.5],
    ]);
    expect(silences[0]!.cut).toEqual({ start: 0.8, end: 1.9 });
    expect(silences[0]!.after_word_id).toBe('w2');
    expect(silences[0]!.before_word_id).toBe('w3');
    // Đuôi: không có từ sau, cắt tới hết cửa sổ.
    expect(silences[1]!.cut).toEqual({ start: 3.1, end: 4.5 });
  });

  it('bỏ qua phần đã cắt', () => {
    const silences = findSilences({ transcript, window: { start: 0, end: 3.2 }, removed: [{ start: 0.7, end: 1.9 }] });
    expect(silences).toEqual([]);
  });
});

describe('remove_ranges', () => {
  const golden = JSON.parse(
    gunzipSync(readFileSync(new URL('./golden/ops.json.gz', import.meta.url))).toString('utf8'),
  ) as { transcript: Transcript; bases: Record<string, ClipDocument> };
  const files = new Map<string, Transcript>([['assets/transcript.json', golden.transcript]]);
  const ctx: OpContext = {
    master: { width: 1920, height: 1080 },
    readTranscript: async (path) => files.get(path)!,
    saveTranscript: async (value) => {
      const path = `assets/transcripts/${files.size}.json`;
      files.set(path, value);
      return path;
    },
  };

  it('cắt khoảng thời gian nguồn, kẹp vào cửa sổ, gộp với khoảng cũ', async () => {
    const base = golden.bases.test!;
    const once = (await applyOps(base, [{ op: 'remove_ranges', ranges: [{ start: 4.3, end: 5 }, { start: 31, end: 99 }] }], ctx)).document;
    expect(summarizeProject(once).cut?.removed).toEqual([
      { start: 4.3, end: 5 },
      { start: 31, end: 32 },
    ]);
    await expect(applyOps(base, [{ op: 'remove_ranges', ranges: [{ start: 50, end: 60 }] }], ctx)).rejects.toThrow(/outside this clip/);
  });

  it('các đoạn sau cắt nối liền theo frame: không có chớp đen 1 frame (eval AE0)', async () => {
    // Bốn khoảng này từng để đoạn 3 và 4 hở nhau đúng frame 558.
    const ranges = [
      { start: 4.64, end: 5.9 },
      { start: 10.54, end: 11.7 },
      { start: 21.04, end: 21.4 },
    ];
    const document = (await applyOps(golden.bases.test!, [{ op: 'remove_ranges', ranges }], ctx)).document;
    const media = { duration: (src: unknown) => (src === 'assets/master.mp4' ? 40 : null) };
    expect(checkDocument(document, media).issues.filter((issue) => issue.code === 'black-gap')).toEqual([]);
  });
});
