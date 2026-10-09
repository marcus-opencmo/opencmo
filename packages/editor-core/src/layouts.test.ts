import { validate, type ClipDocument } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { readLayout } from './layout';
import { layoutSlots, layoutsFor, VIDEO_LAYOUTS } from './layouts';
import { applyOps, type OpContext } from './ops';
import { normalize, type Transcript } from './transcript';

const TRANSCRIPT: Transcript = [
  { text: 'so this is the thing', words: [{ text: 'so', start: 2.1, end: 2.3 }, { text: 'this', start: 2.35, end: 2.6 }, { text: 'is', start: 2.65, end: 2.8 }, { text: 'the', start: 3.5, end: 3.7 }, { text: 'thing', start: 3.75, end: 4.2 }] },
];

const ctx = (): OpContext => {
  const files = new Map<string, Transcript>([['assets/transcript.json', TRANSCRIPT]]);
  return {
    master: { width: 1920, height: 1080 },
    readTranscript: async (path) => structuredClone(files.get(path)!),
    saveTranscript: async (transcript) => {
      const path = `assets/transcripts/${String(files.size).padStart(64, '0')}.json`;
      files.set(path, structuredClone(transcript));
      return path;
    },
  };
};

const broll = (id: string, start = 4, end = 10) => ({ kind: 'rect', id, x: 10, y: 20, width: 300, height: 300, start, end, scale: 1.2, paints: [{ type: 'image', src: `${id}.png` }], tracks: [{ property: 'x', keyframes: [{ time: 0, value: 10 }, { time: 1, value: 50 }] }] });

const source = (extra: unknown[]): ClipDocument =>
  ({
    version: 1,
    stage: {
      children: [
        {
          kind: 'scene', id: 'sc', name: 'Clip', width: 1080, height: 1920, fill: '#000000', active: true, workarea: [0, 30],
          children: [
            { kind: 'video', id: 'master', src: 'assets/master.mp4', x: -484, y: 0, width: 3413.33, height: 1920, objectFit: 'cover', start: 0, sourceIn: 2, sourceOut: 32, tracks: [{ property: 'x', keyframes: [{ time: 2, value: -484 }, { time: 16, value: -2020 }] }] },
            ...extra,
            { kind: 'captions', id: 'cap', src: 'assets/transcript.json', preset: 'classic', start: 0, sourceIn: 2, sourceOut: 32 },
          ],
        },
      ],
    },
  }) as unknown as ClipDocument;

type Node = Record<string, unknown> & { id?: string; children?: Node[]; masks?: Node[]; marks?: Record<string, unknown>; paints?: Record<string, unknown>[]; tracks?: { property: string }[] };
const kids = (document: ClipDocument) => (document.stage.children[0] as unknown as Node).children!;
const find = (document: ClipDocument, id: string) => kids(document).find((node) => node.id === id)!;

describe('13 bố cục', () => {
  it('ô nằm trong khung; bố cục không PiP phủ kín đúng một lần', () => {
    expect(VIDEO_LAYOUTS).toHaveLength(13);
    for (const layout of VIDEO_LAYOUTS) {
      const slots = layoutSlots(layout);
      for (const { rect } of slots) {
        expect(rect[0] + rect[2]).toBeLessThanOrEqual(1 + 1e-9);
        expect(rect[1] + rect[3]).toBeLessThanOrEqual(1 + 1e-9);
      }
      const area = slots.filter((slot) => slot.z === 0).reduce((sum, { rect }) => sum + rect[2] * rect[3], 0);
      expect(area).toBeCloseTo(1, 9);
      if (layout.startsWith('pip')) expect(slots.find((slot) => slot.id === 'inset')!.z).toBe(1);
    }
    expect(layoutsFor(3)).toEqual(['three_up', 'three_stack']);
    expect(layoutsFor(4)).toEqual(['grid_2x2']);
  });
});

describe('apply_layout', () => {
  it('grid 2×2: hộp = ô, cover, điểm neo thành objectPosition, bỏ track hình học', async () => {
    const document = source([broll('a'), broll('b'), broll('c'), broll('d')]);
    const { document: out } = await applyOps(document, [
      { op: 'apply_layout', layout: 'grid_2x2', slots: [
        { slot: 'r1c1', element_ids: ['a'], anchor: 'top' },
        { slot: 'r1c2', element_ids: ['b'] },
        { slot: 'r2c1', element_ids: ['c'] },
        { slot: 'r2c2', element_ids: ['d'] },
      ] },
    ], ctx());
    expect(() => validate(out)).not.toThrow();
    expect(find(out, 'a')).toMatchObject({ x: 0, y: 0, width: 540, height: 960 });
    expect(find(out, 'd')).toMatchObject({ x: 540, y: 960, width: 540, height: 960 });
    expect(find(out, 'a').paints![0]).toMatchObject({ objectFit: 'cover', objectPosition: [0.5, 0] });
    expect(find(out, 'b').paints![0]!.objectPosition).toBeUndefined();
    expect(find(out, 'a').scale).toBeUndefined();
    expect(find(out, 'a').tracks).toBeUndefined();
  });

  it('fit: contain trong ô', async () => {
    const { document: out } = await applyOps(source([broll('a'), broll('b')]), [
      { op: 'apply_layout', layout: 'top_bottom', fit: 'fit', slots: [{ slot: 'top', element_ids: ['a'] }, { slot: 'bottom', element_ids: ['b'] }] },
    ], ctx());
    expect(find(out, 'b')).toMatchObject({ x: 0, y: 960, width: 1080, height: 960 });
    expect(find(out, 'b').paints![0]!.objectFit).toBe('contain');
  });

  it('video của clip ở một ô: khoảng cell trong mark, Speaker có mask đúng tỉ lệ ô, bám mặt còn nguyên; gọi lại không đổi', async () => {
    const context = ctx();
    const op = { op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['master'] }, { slot: 'right', element_ids: ['a'] }] };
    const { document: out } = await applyOps(source([broll('a')]), [op], context);
    expect(() => validate(out)).not.toThrow();
    const [range] = readLayout(out);
    expect(range).toMatchObject({ mode: 'cell', rect: [0, 0, 0.5, 1], start: 4, end: 10 });
    const speaker = kids(out).find((node) => node.marks?.layout === 'speaker')!;
    expect(speaker.kind).toBe('rect');
    // Ô 540×1920 (tỉ lệ 0.28) cắt cửa sổ 540×1920 từ khung 1080×1920.
    const mask = speaker.masks![0]!;
    const widths = (mask.tracks as { property: string; keyframes: { value: number }[] }[] | undefined)?.find((track) => track.property === 'width')?.keyframes.map((k) => k.value) ?? [mask.width];
    expect(Math.min(...(widths as number[]))).toBe(540);
    expect(speaker.children![0]!.id).toBe('master');
    expect(speaker.children![0]!.tracks![0]!.property).toBe('x');
    expect(find(out, 'a')).toMatchObject({ x: 540, width: 540, height: 1920 });
    const again = await applyOps(out, [op], context);
    expect(again.results[0]!.changed).toBe(false);
  });

  it('PiP: người nói ở ô nhỏ thì B-roll ô chính dời xuống dưới khung người nói', async () => {
    const { document: out } = await applyOps(source([broll('a')]), [
      { op: 'apply_layout', layout: 'pip_top_left', slots: [{ slot: 'main', element_ids: ['a'] }, { slot: 'inset', element_ids: ['master'] }] },
    ], ctx());
    const order = kids(out).map((node) => (node.marks?.layout as string | undefined) ?? node.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('speaker'));
    expect(readLayout(out)[0]!.rect).toEqual([0.035, 0.035, 0.28, 0.28]);
  });

  it('người nói full = bỏ khoảng cell', async () => {
    const context = ctx();
    const { document: split } = await applyOps(source([broll('a')]), [
      { op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['master'] }, { slot: 'right', element_ids: ['a'] }] },
    ], context);
    const { document: full } = await applyOps(split, [{ op: 'apply_layout', layout: 'full', slots: [{ slot: 'main', element_ids: ['master'] }], start: 0, end: 30 }], context);
    expect(readLayout(full)).toEqual([]);
    expect(kids(full).some((node) => node.marks?.layout === 'speaker')).toBe(false);
  });

  it('sống qua cắt chữ: Speaker bọc sequence đã cắt, khoảng cell giữ nguyên', async () => {
    const context = ctx();
    const { document: laid } = await applyOps(source([broll('a', 0, 30), broll('b', 0, 30)]), [
      { op: 'apply_layout', layout: 'three_up', slots: [{ slot: 'left', element_ids: ['master'] }, { slot: 'center', element_ids: ['a'] }, { slot: 'right', element_ids: ['b'] }] },
    ], context);
    const word = normalize(TRANSCRIPT)[0]!.words[3]!.id!;
    const { document: cut } = await applyOps(laid, [{ op: 'remove_words', word_ids: [word] }], context);
    expect(() => validate(cut)).not.toThrow();
    const speaker = kids(cut).find((node) => node.marks?.layout === 'speaker')!;
    expect(speaker.children![0]!.kind).toBe('sequence');
    expect(readLayout(cut)[0]).toMatchObject({ mode: 'cell', rect: [0, 0, 1 / 3, 1] });
  });

  it('báo lỗi tiếng Anh: thiếu ô, trùng phần tử, không phải media, không cùng lúc', async () => {
    const document = source([broll('a', 0, 3), broll('b', 5, 8), { kind: 'text', id: 't', text: 'Hi', start: 0, end: 3 }]);
    await expect(applyOps(document, [{ op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['a'] }] }], ctx())).rejects.toThrow(/Missing: right/);
    await expect(applyOps(document, [{ op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['a'] }, { slot: 'right', element_ids: ['a'] }] }], ctx())).rejects.toThrow(/more than one slot/);
    await expect(applyOps(document, [{ op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['t'] }, { slot: 'right', element_ids: ['a'] }] }], ctx())).rejects.toThrow(/video and image/);
    await expect(applyOps(document, [{ op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'left', element_ids: ['a'] }, { slot: 'right', element_ids: ['b'] }] }], ctx())).rejects.toThrow(/never play at the same time/);
    await expect(applyOps(document, [{ op: 'apply_layout', layout: 'side_by_side', slots: [{ slot: 'middle', element_ids: ['a'] }, { slot: 'right', element_ids: ['b'] }] }], ctx())).rejects.toThrow(/not a slot/);
  });
});
