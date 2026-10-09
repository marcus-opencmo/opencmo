import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { applyOps, type OpContext } from './ops';

const ctx: OpContext = {
  master: null,
  readTranscript: async () => {
    throw new Error('không dùng');
  },
  saveTranscript: async () => 'x',
};

const doc = (children: unknown[]): ClipDocument =>
  ({ version: 1, stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, children }] } }) as unknown as ClipDocument;
type Fx = { id?: string; type: string; value: number; params?: Record<string, unknown> };
const effectsOf = (document: ClipDocument, index = 0) =>
  ((document.stage.children[0] as unknown as { children: { effects?: Fx[] }[] }).children[index]!.effects ?? []);
const run = async (document: ClipDocument, ops: unknown[]) => (await applyOps(document, ops, ctx)).document;

describe('apply_color', () => {
  const video = { kind: 'video', id: 'v', src: 'assets/master.mp4', effects: [{ id: 'e1', type: 'blur', value: 4 }, { id: 'e2', type: 'saturation', value: 0.5 }] };

  it('thay effect cùng loại (giữ id), thêm loại mới, không đụng effect không phải màu', async () => {
    const out = await run(doc([video]), [
      { op: 'apply_color', element_ids: ['v'], adjustments: { saturation: -0.2, shadows: 0.3, wheels: { gain: [0.1, 0, -0.05] } } },
    ]);
    const effects = effectsOf(out);
    expect(effects.map((e) => e.type)).toEqual(['blur', 'saturation', 'shadows', 'wheels']);
    expect(effects[1]).toMatchObject({ id: 'e2', value: -0.2 });
    expect(effects[3]).toMatchObject({ value: 1, params: { gain: [0.1, 0, -0.05] } });
    expect(effects[3]!.id).toBeTruthy();
  });

  it('giá trị 0 bỏ effect; reset xoá mọi chỉnh màu cũ nhưng giữ blur', async () => {
    const zero = await run(doc([video]), [{ op: 'apply_color', element_ids: ['v'], adjustments: { saturation: 0 } }]);
    expect(effectsOf(zero).map((e) => e.type)).toEqual(['blur']);
    const reset = await run(doc([video]), [{ op: 'apply_color', element_ids: ['v'], adjustments: { exposure: 0.3 }, reset: true }]);
    expect(effectsOf(reset).map((e) => e.type)).toEqual(['blur', 'exposure']);
  });

  it('contrast thành S-curve trên master; contrast cùng master curve thì báo lỗi', async () => {
    const out = await run(doc([video]), [{ op: 'apply_color', element_ids: ['v'], adjustments: { contrast: 0.5 } }]);
    const curves = effectsOf(out).find((e) => e.type === 'curves')!;
    const master = curves.params!.master as [number, number][];
    expect(master[1]![1]).toBeLessThan(0.25);
    expect(master[2]![1]).toBeGreaterThan(0.75);
    await expect(
      run(doc([video]), [{ op: 'apply_color', element_ids: ['v'], adjustments: { contrast: 0.5, curves: { master: [[0, 0], [1, 1]] } } }]),
    ).rejects.toThrow(/contrast or a master curve/);
  });

  it('chroma key viết hoa màu, vignette có tham số; nhiều phần tử một lần', async () => {
    const out = await run(doc([{ kind: 'video', id: 'a', src: 'a.mp4' }, { kind: 'image', id: 'b', src: 'b.png' }]), [
      { op: 'apply_color', element_ids: ['a', 'b'], adjustments: { chroma_key: { color: '#00ff00' }, vignette: { amount: 0.4, feather: 0.8 } } },
    ]);
    for (const index of [0, 1]) {
      expect(effectsOf(out, index)).toMatchObject([
        { type: 'vignette', value: 0.4, params: { feather: 0.8 } },
        { type: 'chromaKey', value: 0.4, params: { color: '#00FF00' } },
      ]);
    }
  });

  it('phần tử không nhận effect và id lạ thì báo lỗi', async () => {
    await expect(run(doc([video]), [{ op: 'apply_color', element_ids: ['x'], adjustments: { grain: 0.2 } }])).rejects.toThrow(/no element/);
    await expect(
      run(doc([{ kind: 'audio', id: 'au', src: 'a.mp3' }]), [{ op: 'apply_color', element_ids: ['au'], adjustments: { grain: 0.2 } }]),
    ).rejects.toThrow(/cannot take color/);
  });
});

describe('apply_color lut', () => {
  it('thêm LUT theo đường dẫn thư viện, strength 0 thì bỏ', async () => {
    const video = { kind: 'video', id: 'v', src: 'assets/master.mp4' };
    const out = await run(doc([video]), [{ op: 'apply_color', element_ids: ['v'], adjustments: { lut: { path: 'Looks/teal.cube', strength: 0.7 } } }]);
    expect(effectsOf(out)).toMatchObject([{ type: 'lut', value: 0.7, params: { src: 'Looks/teal.cube' } }]);
    const removed = await run(out, [{ op: 'apply_color', element_ids: ['v'], adjustments: { lut: { path: 'Looks/teal.cube', strength: 0 } } }]);
    expect(effectsOf(removed)).toEqual([]);
  });
});
