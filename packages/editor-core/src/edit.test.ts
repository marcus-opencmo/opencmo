import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { AGENT_OP_INPUTS, applyOps, type OpContext } from './ops';

const ctx = (durations: Record<string, number> = {}): OpContext => ({
  master: { width: 1920, height: 1080 },
  readTranscript: async () => {
    throw new Error('không dùng');
  },
  saveTranscript: async () => 'x',
  media: { duration: (src) => (typeof src === 'string' ? (durations[src] ?? null) : null) },
});

const doc = (children: unknown[]): ClipDocument =>
  ({ version: 1, stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, children }] } }) as unknown as ClipDocument;
const kids = (document: ClipDocument) => (document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children;
const run = async (document: ClipDocument, ops: unknown[], context = ctx()) => (await applyOps(document, ops, context)).document;

describe('set_fade', () => {
  it('chữ: fade hình; video: fade hình + tiếng; ghi đè fade cũ cùng phía', async () => {
    const out = await run(
      doc([
        { kind: 'text', id: 't', text: 'Hi', start: 0, end: 4, animations: [{ type: 'fade', phase: 'in', duration: 2 }, { type: 'slideUp', phase: 'in', duration: 0.3 }] },
        { kind: 'video', id: 'v', src: 'b.mp4', start: 0, end: 6 },
      ]),
      [{ op: 'set_fade', element_ids: ['t', 'v'], in: 0.5, out: 1 }],
      ctx({ 'b.mp4': 10 }),
    );
    const strip = (list: unknown) => (list as Array<Record<string, unknown>>).map(({ id: _id, ...rest }) => rest);
    expect(strip(kids(out)[0]!.animations)).toEqual([
      { type: 'slideUp', phase: 'in', duration: 0.3 },
      { type: 'fade', phase: 'in', duration: 0.5 },
      { type: 'fade', phase: 'out', duration: 1 },
    ]);
    expect(strip(kids(out)[1]!.animations)).toEqual([
      { type: 'fade', phase: 'in', duration: 0.5 },
      { type: 'gain', phase: 'in', duration: 0.5 },
      { type: 'fade', phase: 'out', duration: 1 },
      { type: 'gain', phase: 'out', duration: 1 },
    ]);
  });

  it('không dài quá nửa clip; 0 thì bỏ fade phía đó', async () => {
    const short = await run(doc([{ kind: 'text', id: 't', text: 'Hi', start: 0, end: 1 }]), [{ op: 'set_fade', element_ids: ['t'], in: 5 }]);
    expect((kids(short)[0]!.animations as Array<{ duration: number }>)[0]!.duration).toBe(0.5);
    const off = await run(short, [{ op: 'set_fade', element_ids: ['t'], in: 0 }]);
    expect(kids(off)[0]!.animations).toBeUndefined();
  });
});

describe('slip_element', () => {
  const broll = { kind: 'video', id: 'b', src: 'b.mp4', start: 2, end: 5, sourceIn: 4 };

  it('dời cửa sổ nguồn, giữ chỗ trên timeline', async () => {
    const out = await run(doc([broll]), [{ op: 'slip_element', element_id: 'b', by: 1.5 }], ctx({ 'b.mp4': 20 }));
    expect(kids(out)[0]).toMatchObject({ start: 2, end: 5, sourceIn: 5.5 });
  });

  it('kẹp hai đầu nguồn', async () => {
    const back = await run(doc([broll]), [{ op: 'slip_element', element_id: 'b', by: -10 }], ctx({ 'b.mp4': 20 }));
    expect(kids(back)[0]).not.toHaveProperty('sourceIn');
    expect(kids(back)[0]).toMatchObject({ start: 2, end: 5 });
    // Nguồn 20 s, khung 3 s: sourceIn tối đa 17.
    const ahead = await run(doc([broll]), [{ op: 'slip_element', element_id: 'b', by: 100 }], ctx({ 'b.mp4': 20 }));
    expect(kids(ahead)[0]).toMatchObject({ sourceIn: 17 });
  });

  it('từ chối ảnh, video chính, nguồn chưa biết độ dài', async () => {
    await expect(run(doc([{ kind: 'image', id: 'i', src: 'a.png', start: 0, end: 2 }]), [{ op: 'slip_element', element_id: 'i', by: 1 }])).rejects.toThrow(/Only video and audio/);
    await expect(run(doc([{ kind: 'video', id: 'm', src: 'assets/master.mp4' }]), [{ op: 'slip_element', element_id: 'm', by: 1 }], ctx({ 'assets/master.mp4': 60 }))).rejects.toThrow(/transcript/);
    await expect(run(doc([broll]), [{ op: 'slip_element', element_id: 'b', by: 1 }])).rejects.toThrow(/not known/);
  });
});

describe('ripple_delete', () => {
  it('xoá và kéo các clip sau trong cùng cha lên', async () => {
    const out = await run(
      doc([
        { kind: 'text', id: 'a', text: 'A', start: 0, end: 2 },
        { kind: 'text', id: 'b', text: 'B', start: 2, end: 4 },
        { kind: 'text', id: 'c', text: 'C', start: 4, end: 7 },
        { kind: 'text', id: 'd', text: 'D', start: 1, end: 3 },
      ]),
      [{ op: 'ripple_delete', element_id: 'b' }],
    );
    expect(kids(out).map((k) => [k.id, k.start, k.end])).toEqual([
      ['a', 0, 2],
      ['c', 2, 5],
      // Bắt đầu trước mép cuối của clip bị xoá: không dời.
      ['d', 1, 3],
    ]);
  });

  it('từ chối khi phải dời video chính, và khi xoá video chính', async () => {
    const master = { kind: 'video', id: 'm', src: 'assets/master.mp4', start: 3, end: 10 };
    await expect(run(doc([{ kind: 'text', id: 'a', text: 'A', start: 0, end: 2 }, master]), [{ op: 'ripple_delete', element_id: 'a' }], ctx({ 'assets/master.mp4': 60 }))).rejects.toThrow(/own video/);
    await expect(run(doc([master]), [{ op: 'ripple_delete', element_id: 'm' }], ctx({ 'assets/master.mp4': 60 }))).rejects.toThrow(/cannot be deleted/);
  });

  it('agent gọi được cả ba op', () => {
    expect(AGENT_OP_INPUTS.set_fade && AGENT_OP_INPUTS.slip_element && AGENT_OP_INPUTS.ripple_delete).toBeTruthy();
  });
});

describe('marker', () => {
  it('thêm, sửa, xoá; xếp theo thời gian; id ổn định', async () => {
    const { readMarkers } = await import('./ops');
    let d = doc([]);
    d = await run(d, [{ op: 'set_marker', time: 5, name: 'Tighten here', comment: 'too slow' }]);
    d = await run(d, [{ op: 'set_marker', time: 1.5, duration: 2, color: 'red' }]);
    expect(readMarkers(d).map((m) => [m.id, m.name, m.time, m.duration, m.color, m.status])).toEqual([
      ['m2', 'Marker 2', 1.5, 2, 'red', 'open'],
      ['m1', 'Tighten here', 5, 0, 'blue', 'open'],
    ]);
    d = await run(d, [{ op: 'set_marker', marker_id: 'm1', status: 'resolved', comment: null }]);
    expect(readMarkers(d).find((m) => m.id === 'm1')).toMatchObject({ status: 'resolved' });
    expect(readMarkers(d).find((m) => m.id === 'm1')).not.toHaveProperty('comment');
    d = await run(d, [{ op: 'delete_marker', marker_id: 'm2' }, { op: 'delete_marker', marker_id: 'm1' }]);
    expect(readMarkers(d)).toEqual([]);
    expect((d.stage.children[0] as unknown as Record<string, unknown>).marks).toBeUndefined();
  });

  it('marker mới cần time; id lạ báo lỗi', async () => {
    await expect(run(doc([]), [{ op: 'set_marker', name: 'x' }])).rejects.toThrow(/time/);
    await expect(run(doc([]), [{ op: 'delete_marker', marker_id: 'm9' }])).rejects.toThrow(/no marker/);
  });
});

describe('set_caption_breaks', () => {
  it('ghi trần lên mọi lớp phụ đề; null trả về luật preset', async () => {
    const d = doc([{ kind: 'captions', id: 'c', src: 't.json' }, { kind: 'group', id: 'g', children: [{ kind: 'captions', id: 'c2', src: 'v.json' }] }]);
    // captionsOnTop dồn lớp phụ đề lên trên cùng sau mỗi lượt: tìm theo id, không theo vị trí.
    const byId = (document: ClipDocument, id: string) => kids(document).find((k) => k.id === id)!;
    const on = await run(d, [{ op: 'set_caption_breaks', max_words: 4, hold_gap: 0.5 }]);
    expect(byId(on, 'c')).toMatchObject({ maxWords: 4, holdGap: 0.5 });
    expect((byId(on, 'g').children as Array<Record<string, unknown>>)[0]).toMatchObject({ maxWords: 4 });
    const off = await run(on, [{ op: 'set_caption_breaks', max_words: null, hold_gap: null }]);
    expect(byId(off, 'c')).not.toHaveProperty('maxWords');
    expect(byId(off, 'c')).not.toHaveProperty('holdGap');
    await expect(run(doc([]), [{ op: 'set_caption_breaks', max_words: 3 }])).rejects.toThrow(/no captions/);
  });
});

describe('clean_audio (học Palmier §C7)', () => {
  it('đặt denoise cho mọi mảnh master; 0 gỡ; element lạ / không phải tiếng bị từ chối', async () => {
    const d = doc([
      { kind: 'video', id: 'v1', src: 'assets/master.mp4', start: 0, end: 2 },
      { kind: 'video', id: 'v2', src: 'assets/master.mp4', start: 2, end: 4, sourceIn: 3 },
      { kind: 'audio', id: 'm', src: 'music.mp3' },
      { kind: 'text', id: 't', text: 'hi' },
    ]);
    const on = (await applyOps(d, [{ op: 'clean_audio', amount: 0.6 }], ctx())).document;
    const kids = (on.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children;
    expect(kids.filter((k) => k.denoise === 0.6).map((k) => k.id)).toEqual(['v1', 'v2']);
    const off = (await applyOps(on, [{ op: 'clean_audio', amount: 0 }], ctx())).document;
    expect(JSON.stringify(off)).not.toContain('denoise');
    const music = (await applyOps(d, [{ op: 'clean_audio', amount: 0.4, element_id: 'm' }], ctx())).document;
    expect((music.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children[2]!.denoise).toBe(0.4);
    await expect(applyOps(d, [{ op: 'clean_audio', amount: 0.4, element_id: 't' }], ctx())).rejects.toThrow(/video and audio/);
  });
});

describe('set_audio_roll (J/L-cut)', async () => {
  const { writeCaptionState } = await import('./captions');
  const { MASTER_SRC } = await import('./doc');
  // Video master 0–20 s, đã cắt 5–8 s → hai đoạn: [0,5] lúc 0 và [8,20] lúc 5.
  const cut = () =>
    writeCaptionState(
      doc([
        { kind: 'video', id: 'm', src: MASTER_SRC, sourceIn: 0, sourceOut: 20, volume: -3, denoise: 0.6 },
        { kind: 'captions', id: 'c', src: 'tr.json' },
      ]),
      { base: 'tr.json', removed: [{ start: 5, end: 8 }] },
    );
  const sequence = (document: ClipDocument) => kids(document).find((child) => child.kind === 'sequence') as { children: Record<string, unknown>[]; marks: Record<string, { roll?: Record<string, number> }> };
  const sounds = (document: ClipDocument) => sequence(document).children.filter((child) => child.kind === 'audio');

  it('L-cut: tiếng đoạn trước kéo sang hình đoạn sau; hình câm, tiếng mang âm lượng + khử ồn', async () => {
    const out = await run(cut(), [{ op: 'set_audio_roll', at: 5, seconds: 0.5 }]);
    const videos = sequence(out).children.filter((child) => child.kind === 'video');
    expect(videos.every((video) => video.muted === true)).toBe(true);
    expect(sounds(out)).toMatchObject([
      { kind: 'audio', src: MASTER_SRC, start: 0, sourceIn: 0, sourceOut: 5.5, volume: -3, denoise: 0.6 },
      { kind: 'audio', src: MASTER_SRC, start: 5.5, sourceIn: 8.5, sourceOut: 20 },
    ]);
    expect(sequence(out).marks['text-cut']!.roll).toEqual({ '8': 0.5 });
  });

  it('J-cut: tiếng đoạn sau vào sớm (dùng nguồn trước điểm vào của nó)', async () => {
    const out = await run(cut(), [{ op: 'set_audio_roll', at: 5.2, seconds: -1 }]);
    expect(sounds(out)).toMatchObject([
      { start: 0, sourceIn: 0, sourceOut: 4 },
      { start: 4, sourceIn: 7, sourceOut: 20 },
    ]);
  });

  it('cắt thêm vẫn giữ J/L-cut của chỗ cắt còn lại; 0 hoặc restore bỏ nó', async () => {
    const rolled = await run(cut(), [{ op: 'set_audio_roll', at: 5, seconds: 0.5 }]);
    const recut = writeCaptionState(rolled, { base: 'tr.json', removed: [{ start: 5, end: 8 }, { start: 15, end: 16 }] });
    expect(sequence(recut).marks['text-cut']!.roll).toEqual({ '8': 0.5 });
    expect(sounds(recut)).toHaveLength(3);
    const straight = await run(rolled, [{ op: 'set_audio_roll', at: 5, seconds: 0 }]);
    expect(sounds(straight)).toHaveLength(0);
    expect(sequence(straight).children.some((child) => child.muted)).toBe(false);
    const restored = writeCaptionState(rolled, { base: 'tr.json', removed: [] });
    expect(kids(restored).find((child) => child.kind === 'sequence')).toBeUndefined();
  });

  it('khử ồn chạm cả đoạn tiếng; không có chỗ cắt gần thì báo rõ', async () => {
    const rolled = await run(cut(), [{ op: 'set_audio_roll', at: 5, seconds: 0.5 }, { op: 'clean_audio', amount: 0.3 }]);
    expect(sounds(rolled).every((sound) => sound.denoise === 0.3)).toBe(true);
    await expect(run(cut(), [{ op: 'set_audio_roll', at: 12, seconds: 0.5 }])).rejects.toThrow(/no cut near 12s/);
  });
});
