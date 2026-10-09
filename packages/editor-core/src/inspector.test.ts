import { describe, expect, it } from 'vitest';

import type { ClipDocument } from '@opencmo/clip-doc';

import { AGENT_OP_INPUTS, applyOps, type OpContext } from './ops';

const ctx: OpContext = {
  master: null,
  readTranscript: async () => {
    throw new Error('không dùng');
  },
  saveTranscript: async () => 'x',
};

const doc = (children: unknown[]): ClipDocument =>
  ({ version: 1, stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, children }] } }) as unknown as ClipDocument;
const kids = (document: ClipDocument) => (document.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children;
const run = async (document: ClipDocument, ops: unknown[]) => (await applyOps(document, ops, ctx)).document;

describe('set_props', () => {
  it('ghi, bỏ (null/false), làm tròn bốn chữ số', async () => {
    const out = await run(doc([{ kind: 'rect', id: 'r', opacity: 0.5, hidden: true }]), [
      { op: 'set_props', element_id: 'r', props: { x: 10.123456, opacity: null, hidden: false, blendMode: 'multiply' } },
    ]);
    expect(kids(out)[0]).toEqual({ kind: 'rect', id: 'r', x: 10.1235, blendMode: 'multiply' });
  });

  it('sửa được thời gian video master bằng tay (khác update_element của Assistant)', async () => {
    const out = await run(doc([{ kind: 'video', id: 'v', src: 'assets/master.mp4' }]), [
      { op: 'set_props', element_id: 'v', props: { sourceIn: 1.0333, playbackRate: 1.5 } },
    ]);
    expect(kids(out)[0]).toMatchObject({ sourceIn: 1.0333, playbackRate: 1.5 });
  });

  it('ghi được lên thành phần phụ và transition', async () => {
    const out = await run(doc([{ kind: 'rect', id: 'r', paints: [{ id: 'p', type: 'solid', color: '#000000' }] }]), [
      { op: 'set_props', element_id: 'p', props: { color: '#ff0000', opacity: 0.4 } },
      { op: 'set_props', element_id: 'r', props: { transition: { type: 'dissolve', duration: 0.5 } } },
    ]);
    expect(kids(out)[0]).toMatchObject({ paints: [{ color: '#ff0000', opacity: 0.4 }], transition: { type: 'dissolve', duration: 0.5 } });
  });

  it('đổi loại effect/animation; đổi loại fill mà sót khoá cũ thì bị từ chối', async () => {
    const base = doc([{ kind: 'rect', id: 'r', effects: [{ id: 'e', type: 'blur', value: 8 }], paints: [{ id: 'p', type: 'solid', color: '#000000' }] }]);
    const out = await run(base, [{ op: 'set_props', element_id: 'e', props: { type: 'sepia', value: 0.5 } }]);
    expect(kids(out)[0]).toMatchObject({ effects: [{ type: 'sepia', value: 0.5 }] });
    await expect(run(base, [{ op: 'set_props', element_id: 'p', props: { type: 'linearGradient' } }])).rejects.toThrow(/not accepted/);
  });

  it('từ chối cấu trúc, cỡ scene và giá trị sai schema', async () => {
    const base = doc([{ kind: 'rect', id: 'r' }]);
    await expect(run(base, [{ op: 'set_props', element_id: 'r', props: { children: [] } }])).rejects.toThrow(/cannot be changed/);
    await expect(run(base, [{ op: 'set_props', element_id: 'sc', props: { width: 10 } }])).rejects.toThrow(/frame buttons/);
    await expect(run(base, [{ op: 'set_props', element_id: 'r', props: { blendMode: 'nope' } }])).rejects.toThrow(/not accepted/);
    await expect(run(base, [{ op: 'set_props', element_id: 'r', props: { wobble: 1 } }])).rejects.toThrow(/wobble/);
  });
});

describe('set_keyframe', () => {
  it('thêm track + keyframe, cập nhật keyframe cùng frame, xoá cả track khi hết', async () => {
    const base = doc([{ kind: 'rect', id: 'r' }]);
    const one = await run(base, [
      { op: 'set_keyframe', element_id: 'r', property: 'x', time: 1, value: 10 },
      { op: 'set_keyframe', element_id: 'r', property: 'x', time: 0, value: 0, easing: 'easeOut' },
      { op: 'set_keyframe', element_id: 'r', property: 'x', time: 1.01, value: 20 },
    ]);
    const track = (kids(one)[0] as { tracks: { property: string; keyframes: Record<string, unknown>[] }[] }).tracks[0]!;
    expect(track.property).toBe('x');
    expect(track.keyframes.map((key) => [key.time, key.value, key.easing])).toEqual([[0, 0, 'easeOut'], [1, 20, undefined]]);
    const gone = await run(one, [
      { op: 'set_keyframe', element_id: 'r', property: 'x', time: 0, remove: true },
      { op: 'set_keyframe', element_id: 'r', property: 'x', time: 1, remove: true },
    ]);
    expect(kids(gone)[0]).not.toHaveProperty('tracks');
  });

  it('keyframe trên thành phần phụ (màu của fill)', async () => {
    const out = await run(doc([{ kind: 'rect', id: 'r', paints: [{ id: 'p', type: 'solid', color: '#000000' }] }]), [
      { op: 'set_keyframe', element_id: 'p', property: 'color', time: 0, value: '#ffffff' },
    ]);
    expect((kids(out)[0] as { paints: { tracks: unknown[] }[] }).paints[0]!.tracks).toHaveLength(1);
  });
});

describe('add_part / move_part', () => {
  it('thêm effect, animation, mask; xếp lại; xoá bằng delete_element', async () => {
    const base = doc([{ kind: 'rect', id: 'r', width: 100, height: 50 }]);
    const out = await run(base, [
      { op: 'add_part', element_id: 'r', key: 'effects', part: { type: 'blur', value: 4 } },
      { op: 'add_part', element_id: 'r', key: 'effects', part: { type: 'sepia', value: 1 } },
      { op: 'add_part', element_id: 'r', key: 'animations', part: { type: 'fade', phase: 'in', duration: 0.5 } },
      { op: 'add_part', element_id: 'r', key: 'masks', part: { kind: 'rect', width: 100, height: 50, id: 'lấy-trộm' } },
    ]);
    const rect = kids(out)[0] as { effects: { id: string; type: string }[]; masks: { id: string }[]; animations: unknown[] };
    expect(rect.effects.map((effect) => effect.type)).toEqual(['blur', 'sepia']);
    expect(rect.masks[0]!.id).not.toBe('lấy-trộm');
    const moved = await run(out, [{ op: 'move_part', part_id: rect.effects[1]!.id, to: 0 }]);
    expect((kids(moved)[0] as { effects: { type: string }[] }).effects.map((effect) => effect.type)).toEqual(['sepia', 'blur']);
    const deleted = await run(moved, [{ op: 'delete_element', element_id: rect.effects[0]!.id }]);
    expect((kids(deleted)[0] as { effects: { type: string }[] }).effects.map((effect) => effect.type)).toEqual(['sepia']);
  });

  it('thành phần sai schema bị từ chối', async () => {
    await expect(
      run(doc([{ kind: 'rect', id: 'r' }]), [{ op: 'add_part', element_id: 'r', key: 'effects', part: { type: 'wobble', value: 1 } }]),
    ).rejects.toThrow(/cannot be added/);
  });
});

it('op inspector Assistant gọi thẳng được (spec agent-editor)', () => {
  for (const name of ['set_props', 'set_keyframe', 'add_part', 'move_part']) expect(AGENT_OP_INPUTS).toHaveProperty(name);
});

describe('insert_node / replace_src', () => {
  it('chèn node lên trên cùng; từ chối cha không phải container và node sai schema', async () => {
    const base = doc([{ kind: 'rect', id: 'r' }]);
    const out = await run(base, [
      { op: 'insert_node', parent_id: 'sc', node: { kind: 'audio', name: 'music', src: 'music.mp3', width: 500, height: 150, id: 'x' } },
    ]);
    expect(kids(out).map((node) => node.kind)).toEqual(['rect', 'audio']);
    expect(kids(out)[1]!.id).not.toBe('x');
    await expect(run(base, [{ op: 'insert_node', parent_id: 'r', node: { kind: 'rect' } }])).rejects.toThrow(/scene, a group/);
    await expect(run(base, [{ op: 'insert_node', parent_id: 'sc', node: { kind: 'rect', wobble: 1 } }])).rejects.toThrow(/cannot be added/);
  });

  it('đổi src theo đường dẫn mới — node, paint, và đầu vào của khai báo', async () => {
    const base = doc([
      { kind: 'rect', id: 'r', paints: [{ id: 'p', type: 'video', src: 'a.mp4' }] },
      { kind: 'image', id: 'i', src: { transform: 'upscale', input: 'a.mp4' } },
      { kind: 'audio', id: 'm', src: 'other.mp3' },
    ]);
    const out = await run(base, [{ op: 'replace_src', renames: [{ from: 'a.mp4', to: 'x/b.mp4' }] }]);
    expect((kids(out)[0] as { paints: { src: string }[] }).paints[0]!.src).toBe('x/b.mp4');
    expect(kids(out)[1]!.src).toEqual({ transform: 'upscale', input: 'x/b.mp4' });
    expect(kids(out)[2]!.src).toBe('other.mp3');
    expect(await run(base, [{ op: 'replace_src', renames: [{ from: 'nope', to: 'x' }] }])).toBe(base);
  });
});

describe('copy_settings', () => {
  const source = {
    kind: 'text', id: 'a', text: 'Hook', start: 0, end: 2, x: 10, y: 20,
    color: '#FFD400', fontFamily: 'Inter', fontWeight: 800, fontSize: 90, textCase: 'upper',
    strokes: [{ id: 's1', color: '#000000', width: 6 }],
    shadows: [{ id: 'sh', color: '#000000', blur: 8 }],
    animations: [{ id: 'an', type: 'fade', phase: 'in', duration: 0.4 }],
    opacity: 0.9,
  };
  const target = { kind: 'text', id: 'b', text: 'Second', start: 5, end: 7, x: 300, y: 600, fontSize: 40 };

  it('chép kiểu chữ + hiệu ứng + motion, giữ chữ, thời gian, vị trí; thành phần phụ có id mới', async () => {
    const out = await run(doc([source, target]), [{ op: 'copy_settings', from_id: 'a', to_ids: ['b'] }]);
    const b = kids(out)[1]!;
    expect(b).toMatchObject({ text: 'Second', start: 5, end: 7, x: 300, y: 600, color: '#FFD400', fontWeight: 800, fontSize: 90, textCase: 'upper', opacity: 0.9 });
    const strokes = b.strokes as Array<{ id?: string; width: number }>;
    expect(strokes[0]!.width).toBe(6);
    expect(strokes[0]!.id).toBeTruthy();
    expect(strokes[0]!.id).not.toBe('s1');
    expect((b.animations as unknown[]).length).toBe(1);
  });

  it('chỉ nhóm được chọn', async () => {
    const out = await run(doc([source, target]), [{ op: 'copy_settings', from_id: 'a', to_ids: ['b'], groups: ['motion'] }]);
    const b = kids(out)[1]!;
    expect(b.animations).toBeTruthy();
    expect(b.color).toBeUndefined();
    expect(b.fontSize).toBe(40);
  });

  it('nhóm không hợp loại: bỏ qua khi tự chọn, báo lỗi khi người gọi chỉ định', async () => {
    const video = { kind: 'video', id: 'v', src: 'a.mp4', start: 0, end: 3 };
    const out = await run(doc([source, video]), [{ op: 'copy_settings', from_id: 'a', to_ids: ['v'] }]);
    const v = kids(out)[1]!;
    expect(v.opacity).toBe(0.9);
    expect(v.fontSize).toBeUndefined();
    await expect(run(doc([source, video]), [{ op: 'copy_settings', from_id: 'a', to_ids: ['v'], groups: ['text'] }])).rejects.toThrow(/cannot take text/);
  });

  it('phần tử không tồn tại: lỗi rõ', async () => {
    await expect(run(doc([source]), [{ op: 'copy_settings', from_id: 'a', to_ids: ['zz'] }])).rejects.toThrow(/no element "zz"/);
  });

  it('agent gọi thẳng được', () => {
    expect(AGENT_OP_INPUTS.copy_settings).toBeTruthy();
  });
});
