import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { diffDocuments, emptyDelta } from './delta';
import { applyOps, type OpContext } from './ops';

const ctx: OpContext = {
  master: { width: 1920, height: 1080 },
  readTranscript: async () => {
    throw new Error('không dùng');
  },
  saveTranscript: async () => 'x',
  media: { duration: () => 10 },
};

const doc = (children: unknown[]): ClipDocument =>
  ({
    version: 1,
    stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, children }] },
  }) as unknown as ClipDocument;

const texts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'text', id: `t${i}`, text: `Line ${i}`, start: i, end: i + 1 }));

const after = async (document: ClipDocument, ops: unknown[]) => (await applyOps(document, ops, ctx)).document;

describe('diffDocuments', () => {
  it('op không đổi gì: delta rỗng', () => {
    const d = doc(texts(2));
    expect(emptyDelta(diffDocuments(d, d))).toBe(true);
  });

  it('thêm chữ: báo id mới, cha, thời gian, nhãn', async () => {
    const d = doc(texts(1));
    const out = await after(d, [{ op: 'add_text', text: 'Hook here', start: 0, end: 2 }]);
    const delta = diffDocuments(d, out);
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0]).toMatchObject({ tag: 'text', parent: 'sc', start: 0, end: 2, label: 'Hook here' });
    expect(delta.added[0]!.id).toMatch(/^[0-9a-z]{6}$/);
    expect(delta.removed).toEqual([]);
    expect(delta.reread).toBe(false);
  });

  it('đổi thuộc tính: chỉ khoá đổi, giá trị mới', async () => {
    const d = doc(texts(2));
    const out = await after(d, [{ op: 'update_element', element_id: 't1', props: { color: '#FFD400' } }]);
    const delta = diffDocuments(d, out);
    expect(delta.changed).toEqual([{ id: 't1', tag: 'text', set: expect.objectContaining({}) }]);
    expect(Object.keys(delta.changed[0]!.set)).not.toContain('start');
    expect(delta.added).toEqual([]);
  });

  it('nhiều node dời cùng khoảng: gộp thành một luật shift', async () => {
    const d = doc(texts(4));
    const out = await after(d, [{ op: 'move_elements', element_ids: ['t0', 't1', 't2', 't3'], by: 0.5 }]);
    const delta = diffDocuments(d, out);
    expect(delta.shifted).toEqual([{ by: 0.5, count: 4, ids: ['t0', 't1', 't2', 't3'] }]);
    expect(delta.changed).toEqual([]);
  });

  it('dưới ba node dời: liệt kê từng cái', async () => {
    const d = doc(texts(2));
    const out = await after(d, [{ op: 'move_elements', element_ids: ['t0'], by: 1 }]);
    const delta = diffDocuments(d, out);
    expect(delta.shifted).toEqual([]);
    expect(delta.changed).toEqual([{ id: 't0', tag: 'text', set: { start: 1, end: 2 } }]);
  });

  it('xoá: báo id đã xoá', async () => {
    const d = doc(texts(2));
    const out = await after(d, [{ op: 'delete_element', element_id: 't0' }]);
    expect(diffDocuments(d, out).removed).toEqual([{ id: 't0', tag: 'text' }]);
  });

  it('đổi thứ tự lớp: bật reread', async () => {
    const d = doc(texts(3));
    const out = await after(d, [{ op: 'move_layer', element_id: 't0', parent_id: 'sc', before_id: null }]);
    expect(diffDocuments(d, out).reread).toBe(true);
  });

  it('quá giới hạn: cắt danh sách, đếm phần bỏ, bật reread', () => {
    const before = doc([]);
    const big = doc(texts(40));
    const delta = diffDocuments(before, big);
    expect(delta.added).toHaveLength(30);
    expect(delta.omitted).toBe(10);
    expect(delta.reread).toBe(true);
  });
});
