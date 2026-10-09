import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { AGENT_OP_INPUTS, applyOps, OP_NAMES, type OpContext } from './ops';

const ctx = (durations: Record<string, number> = {}): OpContext => ({
  master: { width: 1920, height: 1080 },
  readTranscript: async () => {
    throw new Error('không dùng');
  },
  saveTranscript: async () => 'x',
  media: { duration: (src) => (typeof src === 'string' ? (durations[src] ?? null) : null) },
});

const doc = (children: unknown[]): ClipDocument =>
  ({
    version: 1,
    stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, children }] },
  }) as unknown as ClipDocument;

const scene = (document: ClipDocument) => document.stage.children[0] as unknown as { children: Record<string, unknown>[] };
const run = async (document: ClipDocument, ops: unknown[], context = ctx()) =>
  (await applyOps(document, ops, context)).document;

describe('trim_element', () => {
  it('cắt đầu khi chưa có end: ghim end, start dời, sourceIn tiến đúng phần mất', async () => {
    const out = await run(doc([{ kind: 'video', id: 'v', src: 'a.mp4', start: 1 }]), [
      { op: 'trim_element', element_id: 'v', edge: 'in', at: 3 },
    ], ctx({ 'a.mp4': 10 }));
    expect(scene(out).children[0]).toMatchObject({ start: 3, sourceIn: 2, end: 11 });
  });

  it('cắt cuối: end dời; sourceOut chỉ theo khi đã có', async () => {
    const a = await run(doc([{ kind: 'video', id: 'v', src: 'a.mp4' }]), [
      { op: 'trim_element', element_id: 'v', edge: 'out', at: 4 },
    ], ctx({ 'a.mp4': 10 }));
    expect(scene(a).children[0]).toMatchObject({ end: 4 });
    expect(scene(a).children[0]).not.toHaveProperty('sourceOut');
    const b = await run(doc([{ kind: 'video', id: 'v', src: 'a.mp4', sourceIn: 2, sourceOut: 8 }]), [
      { op: 'trim_element', element_id: 'v', edge: 'out', at: 3 },
    ], ctx({ 'a.mp4': 10 }));
    expect(scene(b).children[0]).toMatchObject({ end: 3, sourceOut: 5 });
  });

  it('mép chặn ở phần nguồn còn lại và ở mép kia', async () => {
    const context = ctx({ 'a.mp4': 10 });
    const start = doc([{ kind: 'video', id: 'v', src: 'a.mp4', start: 2, sourceIn: 1 }]);
    // Nguồn bắt đầu ở frame 30 của scene (2 − 1 giây): không kéo đầu qua đó.
    const head = await run(start, [{ op: 'trim_element', element_id: 'v', edge: 'in', at: 0 }], context);
    expect(scene(head).children[0]).toMatchObject({ start: 1 });
    expect(scene(head).children[0]).not.toHaveProperty('sourceIn');
    // Nguồn hết ở giây 11 của scene — clip vốn chạy tới đó, nên kéo đuôi xa hơn là không đổi gì.
    const tail = await run(start, [{ op: 'trim_element', element_id: 'v', edge: 'out', at: 30 }], context);
    expect(tail).toBe(start);
    const shorter = await run(start, [{ op: 'trim_element', element_id: 'v', edge: 'out', at: 5 }], context);
    const longer = await run(shorter, [{ op: 'trim_element', element_id: 'v', edge: 'out', at: 30 }], context);
    expect(scene(longer).children[0]).toMatchObject({ end: 11 });
    const past = await run(start, [{ op: 'trim_element', element_id: 'v', edge: 'in', at: 20 }], context);
    expect((scene(past).children[0] as { start: number }).start).toBeCloseTo(10.9667, 3);
  });

  it('không cắt được sequence (nó không có thời gian riêng)', async () => {
    await expect(
      run(doc([{ kind: 'sequence', id: 's', children: [{ kind: 'rect', id: 'r' }] }]), [
        { op: 'trim_element', element_id: 's', edge: 'out', at: 1 },
      ]),
    ).rejects.toThrow(/inside a sequence/);
  });
});

describe('move_elements', () => {
  it('dời cả start lẫn end, và dừng ở đầu scene', async () => {
    const out = await run(doc([
      { kind: 'rect', id: 'a', start: 2, end: 4 },
      { kind: 'rect', id: 'b', start: 1 },
    ]), [{ op: 'move_elements', element_ids: ['a', 'b'], by: -5 }]);
    expect(scene(out).children[0]).toMatchObject({ start: 1, end: 3 });
    expect(scene(out).children[1]).not.toHaveProperty('start');
  });

  it('trong sequence clip vừa thả thắng: cắt mép, xoá, tách đôi', async () => {
    const base = doc([{
      kind: 'sequence',
      id: 's',
      children: [
        { kind: 'rect', id: 'a', end: 4 },
        { kind: 'rect', id: 'b', start: 4, end: 6 },
        { kind: 'rect', id: 'c', start: 6, end: 12 },
        { kind: 'rect', id: 'd', start: 20, end: 21 },
      ],
    }]);
    // d (1 giây) thả vào giữa c → c còn [6,8) và [9,12).
    const split = await run(base, [{ op: 'move_elements', element_ids: ['d'], by: -12 }]);
    const kids = (scene(split).children[0] as { children: Record<string, unknown>[] }).children;
    expect(kids.map((kid) => [kid.start, kid.end, kid.sourceIn])).toEqual([
      [undefined, 4, undefined],
      [4, 6, undefined],
      [6, 8, undefined],
      [9, 12, 3],
      [8, 9, undefined],
    ]);
    // b (2 giây) dời sang 3 → phủ đuôi a, phủ đầu c.
    const edges = await run(base, [{ op: 'move_elements', element_ids: ['b'], by: -1 }]);
    const after = (scene(edges).children[0] as { children: Record<string, unknown>[] }).children;
    expect(after.map((kid) => [kid.id, kid.start, kid.end])).toEqual([
      ['a', undefined, 3],
      ['b', 3, 5],
      ['c', 6, 12],
      ['d', 20, 21],
    ]);
    // a phủ hết b → b bị xoá.
    const covers = await run(
      doc([{ kind: 'sequence', id: 's', children: [
        { kind: 'rect', id: 'a', start: 10, end: 14 },
        { kind: 'rect', id: 'b', start: 4, end: 6 },
      ] }]),
      [{ op: 'move_elements', element_ids: ['a'], by: -7 }],
    );
    expect((scene(covers).children[0] as { children: { id: string }[] }).children.map((kid) => kid.id)).toEqual(['a']);
  });

  it('dời sequence là dời mọi con của nó', async () => {
    const out = await run(doc([{ kind: 'sequence', id: 's', children: [
      { kind: 'rect', id: 'a', end: 1 },
      { kind: 'rect', id: 'b', start: 1, end: 2 },
    ] }]), [{ op: 'move_elements', element_ids: ['s'], by: 2 }]);
    const kids = (scene(out).children[0] as { children: Record<string, unknown>[] }).children;
    expect(kids.map((kid) => [kid.start, kid.end])).toEqual([[2, 3], [3, 4]]);
  });
});

describe('split_elements', () => {
  it('thẳng dưới scene: hai nửa bọc trong "Sequence N", nửa sau phát tiếp nguồn', async () => {
    const out = await run(doc([
      { kind: 'sequence', id: 'old', name: 'Sequence 2', children: [{ kind: 'rect', id: 'r', start: 30 }] },
      { kind: 'video', id: 'v', src: 'a.mp4', name: 'Clip' },
    ]), [{ op: 'split_elements', at: 4 }], ctx({ 'a.mp4': 10 }));
    const wrapped = scene(out).children[1] as { kind: string; name: string; children: Record<string, unknown>[] };
    expect(wrapped.kind).toBe('sequence');
    expect(wrapped.name).toBe('Sequence 3');
    expect(wrapped.children.map((kid) => [kid.name, kid.start, kid.end, kid.sourceIn])).toEqual([
      ['Clip', undefined, 4, undefined],
      ['Clip', 4, 10, 4],
    ]);
    expect(wrapped.children[1]!.id).not.toBe('v');
  });

  it('trong sequence: cắt con dưới mốc, không bọc thêm', async () => {
    const out = await run(doc([{ kind: 'sequence', id: 's', children: [
      { kind: 'rect', id: 'a', end: 2 },
      { kind: 'rect', id: 'b', start: 2, end: 6 },
    ] }]), [{ op: 'split_elements', element_ids: ['s'], at: 3 }]);
    const kids = (scene(out).children[0] as { children: Record<string, unknown>[] }).children;
    expect(kids.map((kid) => [kid.start, kid.end])).toEqual([[undefined, 2], [2, 3], [3, 6]]);
  });

  it('mốc ngay mép clip thì không có gì để cắt', async () => {
    const base = doc([{ kind: 'rect', id: 'a', start: 1, end: 2 }]);
    expect(await run(base, [{ op: 'split_elements', at: 1 }])).toBe(base);
  });
});

describe('move_layer', () => {
  const base = () => doc([
    { kind: 'rect', id: 'a', end: 2 },
    { kind: 'group', id: 'g', children: [{ kind: 'rect', id: 'b' }] },
    { kind: 'sequence', id: 's', children: [{ kind: 'rect', id: 'c', start: 1, end: 3 }] },
  ]);

  it('đổi thứ tự và đổi cha', async () => {
    const before = await run(base(), [{ op: 'move_layer', element_id: 'a', parent_id: 'sc', before_id: 's' }]);
    expect(scene(before).children.map((kid) => kid.id)).toEqual(['g', 'a', 's']);
    const into = await run(base(), [{ op: 'move_layer', element_id: 'a', parent_id: 'g' }]);
    expect((scene(into).children[0] as { children: { id: string }[] }).children.map((kid) => kid.id)).toEqual(['b', 'a']);
  });

  it('thả vào sequence thì ghi đè; sequence bị rút hết thì biến mất', async () => {
    const out = await run(base(), [{ op: 'move_layer', element_id: 'a', parent_id: 's' }]);
    const seq = scene(out).children[1] as { children: Record<string, unknown>[] };
    expect(seq.children.map((kid) => [kid.id, kid.start, kid.end])).toEqual([['c', 2, 3], ['a', undefined, 2]]);
    const emptied = await run(base(), [{ op: 'move_layer', element_id: 'c', parent_id: 'sc' }]);
    expect(scene(emptied).children.map((kid) => kid.id)).toEqual(['a', 'g', 'c']);
  });

  it('không thả được vào chính nó hay vào một clip', async () => {
    await expect(run(base(), [{ op: 'move_layer', element_id: 'g', parent_id: 'g' }])).rejects.toThrow(/inside itself/);
    await expect(run(base(), [{ op: 'move_layer', element_id: 'g', parent_id: 'a' }])).rejects.toThrow(/scene, a group/);
  });
});

describe('keyframe và vùng làm việc', () => {
  it('move_keyframe dời và giữ thứ tự thời gian', async () => {
    const out = await run(doc([{ kind: 'rect', id: 'r', tracks: [{ id: 't', property: 'x', keyframes: [
      { id: 'k1', time: 0, value: 0 },
      { id: 'k2', time: 1, value: 100 },
    ] }] }]), [{ op: 'move_keyframe', keyframe_id: 'k1', time: 2 }]);
    const keys = (scene(out).children[0] as { tracks: { keyframes: { id: string; time: number }[] }[] }).tracks[0]!.keyframes;
    expect(keys.map((key) => [key.id, key.time])).toEqual([['k2', 1], ['k1', 2]]);
  });

  it('set_workarea đặt và gỡ', async () => {
    const set = await run(doc([]), [{ op: 'set_workarea', start: 1, end: 3.5 }]);
    expect((set.stage.children[0] as { workarea: number[] }).workarea).toEqual([1, 3.5]);
    const cleared = await run(set, [{ op: 'set_workarea', clear: true }]);
    expect(cleared.stage.children[0]).not.toHaveProperty('workarea');
    await expect(run(doc([]), [{ op: 'set_workarea', start: 3, end: 3 }])).rejects.toThrow(/end after/);
  });
});

it('op timeline có trong registry và Assistant gọi thẳng được', () => {
  for (const name of ['move_elements', 'trim_element', 'split_elements', 'move_layer', 'move_keyframe', 'set_workarea']) {
    expect(OP_NAMES).toContain(name);
    expect(AGENT_OP_INPUTS).toHaveProperty(name);
  }
});
