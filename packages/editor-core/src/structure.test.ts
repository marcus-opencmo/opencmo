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
type Node = Record<string, unknown> & { children?: Node[] };
const kids = (document: ClipDocument) => (document.stage.children[0] as unknown as { children: Node[] }).children;
const run = async (document: ClipDocument, ops: unknown[]) => (await applyOps(document, ops, ctx)).document;
const names = (list: Node[] | undefined): unknown[] =>
  (list ?? []).map((node) => (node.children ? { [String(node.name)]: names(node.children) } : node.name));

describe('duplicate_elements', () => {
  it('bản sao ngay trên bản gốc, id mới; con của node cũng được chọn đi theo cha', async () => {
    const out = await run(
      doc([
        { kind: 'group', id: 'g', name: 'G', children: [{ kind: 'rect', id: 'a', name: 'A', x: 5 }] },
        { kind: 'rect', id: 'b', name: 'B' },
      ]),
      [{ op: 'duplicate_elements', element_ids: ['a', 'g'] }],
    );
    expect(names(kids(out))).toEqual([{ G: ['A'] }, { G: ['A'] }, 'B']);
    const [g, copy] = kids(out);
    expect(copy!.id).not.toBe(g!.id);
    expect(copy!.children![0]!.id).not.toBe('a');
    expect(copy!.children![0]!.x).toBe(5);
  });

  it('clip trong sequence: bản sao ra ngoài, ngay trên sequence', async () => {
    const out = await run(
      doc([{ kind: 'sequence', id: 's', name: 'S', children: [{ kind: 'rect', id: 'a', name: 'A' }] }, { kind: 'rect', id: 'z', name: 'Z' }]),
      [{ op: 'duplicate_elements', element_ids: ['a'] }],
    );
    expect(names(kids(out))).toEqual([{ S: ['A'] }, 'A', 'Z']);
  });
});

describe('paste_nodes', () => {
  const base = doc([
    { kind: 'group', id: 'g', name: 'G', children: [{ kind: 'rect', id: 'a', name: 'A' }] },
    { kind: 'sequence', id: 's', name: 'S', children: [{ kind: 'rect', id: 'c', name: 'C' }] },
  ]);
  const nodes = [{ kind: 'rect', id: 'old', name: 'P' }];

  it('vào scene (cuối), vào vật chứa, trước một anh em; không mang id cũ', async () => {
    expect(names(kids(await run(base, [{ op: 'paste_nodes', nodes }])))).toEqual([{ G: ['A'] }, { S: ['C'] }, 'P']);
    expect(names(kids(await run(base, [{ op: 'paste_nodes', parent_id: 'g', nodes }])))).toEqual([{ G: ['A', 'P'] }, { S: ['C'] }, ]);
    const before = await run(base, [{ op: 'paste_nodes', parent_id: 'sc', before_id: 's', nodes }]);
    expect(names(kids(before))).toEqual([{ G: ['A'] }, 'P', { S: ['C'] }]);
    expect(kids(before)[1]!.id).not.toBe('old');
  });

  it('dán lại vào đúng sequence đã copy ra thì ra ngoài, ngay trên nó', async () => {
    const out = await run(base, [{ op: 'paste_nodes', parent_id: 's', nodes, copied_from: 's' }]);
    expect(names(kids(out))).toEqual([{ G: ['A'] }, { S: ['C'] }, 'P']);
    const other = await run(base, [{ op: 'paste_nodes', parent_id: 's', nodes, copied_from: 'g' }]);
    expect(names(kids(other))).toEqual([{ G: ['A'] }, { S: ['C', 'P'] }]);
  });
});

describe('group_elements', () => {
  it('group: đứng chỗ node đầu, giữ thứ tự, chỉ node chung cha, tên kế tiếp', async () => {
    const out = await run(
      doc([
        { kind: 'rect', id: 'a', name: 'A' },
        { kind: 'group', id: 'g1', name: 'Group 1', children: [{ kind: 'rect', id: 'x', name: 'X' }] },
        { kind: 'rect', id: 'b', name: 'B' },
        { kind: 'rect', id: 'c', name: 'C' },
      ]),
      [{ op: 'group_elements', element_ids: ['c', 'a', 'x'], into: 'group', frame: 0 }],
    );
    // Node đầu là C (thứ tự chọn), cha của nó là scene: X ở trong nhóm khác nên đứng ngoài.
    expect(names(kids(out))).toEqual([{ 'Group 2': ['A', 'C'] }, { 'Group 1': ['X'] }, 'B']);
  });

  it('sequence: clip sớm giữ nguyên, clip sau nhường; clip nằm gọn trong clip trước bị bỏ', async () => {
    const out = await run(
      doc([
        { kind: 'rect', id: 'a', name: 'A', end: 4 },
        { kind: 'rect', id: 'b', name: 'B', start: 2, end: 6 },
        { kind: 'rect', id: 'c', name: 'C', start: 1, end: 3 },
      ]),
      [{ op: 'group_elements', element_ids: ['a', 'b', 'c'], into: 'sequence', frame: 0 }],
    );
    const seq = kids(out)[0]!;
    expect(seq).toMatchObject({ kind: 'sequence', name: 'Sequence 1' });
    expect(seq.children!.map((node) => [node.name, node.start ?? 0, node.end, node.sourceIn ?? 0])).toEqual([
      ['A', 0, 4, 0],
      ['B', 4, 6, 2],
    ]);
  });

  it('scene: bao hộp các node (làm tròn ra ngoài), node dời theo góc — kể cả keyframe', async () => {
    const out = await run(
      doc([
        { kind: 'rect', id: 'a', name: 'A', x: 100.4, y: 50, width: 40, height: 10 },
        {
          kind: 'rect',
          id: 'b',
          name: 'B',
          width: 10,
          height: 10,
          tracks: [{ property: 'x', keyframes: [{ time: 0, value: 300 }, { time: 1, value: 400 }] }],
          y: 200,
        },
      ]),
      [{ op: 'group_elements', element_ids: ['a', 'b'], into: 'scene', frame: 0 }],
    );
    const scene = kids(out)[0]!;
    expect(scene).toMatchObject({ kind: 'scene', name: 'Scene 1', x: 100, y: 50, width: 210, height: 160 });
    const [a, b] = scene.children!;
    expect([a!.x, a!.y]).toEqual([0.4, undefined]);
    expect([b!.y, (b!.tracks as { keyframes: { value: number }[] }[])[0]!.keyframes.map((key) => key.value)]).toEqual([150, [200, 300]]);
  });
});

describe('ungroup_elements', () => {
  it('scene lồng dời: con nhận lại toạ độ cũ; group xoay: con xoay theo và đứng đúng chỗ', async () => {
    const wrapped = await run(doc([{ kind: 'rect', id: 'a', name: 'A', x: 100, y: 50, width: 40, height: 10 }]), [
      { op: 'group_elements', element_ids: ['a'], into: 'scene', frame: 0 },
    ]);
    const sceneId = kids(wrapped)[0]!.id as string;
    const back = await run(wrapped, [{ op: 'ungroup_elements', element_ids: [sceneId], frame: 0 }]);
    expect(kids(back)).toEqual([expect.objectContaining({ name: 'A', x: 100, y: 50, width: 40, height: 10 })]);

    // Group xoay 90° quanh tâm hộp của nó (hộp = rect 0,0 20×10 → tâm 10,5).
    const rotated = await run(
      doc([{ kind: 'group', id: 'g', name: 'G', rotation: 90, children: [{ kind: 'rect', id: 'r', name: 'R', width: 20, height: 10 }] }]),
      [{ op: 'ungroup_elements', element_ids: ['g'], frame: 0 }],
    );
    expect(kids(rotated)).toEqual([{ kind: 'rect', id: 'r', name: 'R', width: 20, height: 10, rotation: 90 }]);
  });

  it('group trượt trên timeline: con nhận phần trượt; chỉ sequence khi only=sequence', async () => {
    const base = doc([
      { kind: 'group', id: 'g', name: 'G', start: 2, children: [{ kind: 'rect', id: 'r', name: 'R', start: 1, end: 3 }] },
      { kind: 'sequence', id: 's', name: 'S', children: [{ kind: 'rect', id: 'q', name: 'Q' }] },
    ]);
    const out = await run(base, [{ op: 'ungroup_elements', element_ids: ['g', 's'], frame: 0 }]);
    expect(names(kids(out))).toEqual(['R', { S: ['Q'] }]);
    expect(kids(out)[0]).toMatchObject({ start: 3, end: 5 });
    const seq = await run(base, [{ op: 'ungroup_elements', element_ids: ['g', 's'], only: 'sequence', frame: 0 }]);
    expect(names(kids(seq))).toEqual([{ G: ['R'] }, 'Q']);
    await expect(run(base, [{ op: 'ungroup_elements', element_ids: ['r'], frame: 0 }])).rejects.toThrow(/Select a group/);
  });

  it('Assistant gọi thẳng được; add_generated/replace_src thì không', () => {
    for (const name of ['duplicate_elements', 'paste_nodes', 'group_elements', 'ungroup_elements', 'insert_node']) {
      expect(AGENT_OP_INPUTS[name]).toBeDefined();
    }
    for (const name of ['add_generated', 'replace_src']) expect(AGENT_OP_INPUTS[name]).toBeUndefined();
  });
});

describe('bọc rồi gỡ giữ toạ độ lẻ', () => {
  it('video master x = -688.8 (và keyframe) về đúng giá trị cũ', async () => {
    const base = doc([
      {
        kind: 'video',
        id: 'v',
        src: 'assets/master.mp4',
        x: -688.8,
        width: 3413.33,
        height: 1920,
        tracks: [{ property: 'x', keyframes: [{ time: 2, value: -688.8 }, { time: 8, value: -1917.6 }] }],
      },
      { kind: 'rect', id: 'r', x: 10, y: 20, width: 5, height: 5 },
    ]);
    const wrapped = await run(base, [{ op: 'group_elements', element_ids: ['v', 'r'], into: 'scene', frame: 0 }]);
    const id = kids(wrapped)[0]!.id as string;
    const back = await run(wrapped, [{ op: 'ungroup_elements', element_ids: [id], frame: 0 }]);
    // So giá trị; id của track/keyframe là do lượt stamp đặt.
    const bare = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (key, item) => (key === 'id' && typeof item === 'string' && item.length === 6 ? undefined : item)));
    expect(bare(kids(back))).toEqual(bare(kids(base)));
  });
});

describe('scene cấp stage (công cụ Scene)', () => {
  it('insert_scene thêm scene mới và mở nó; activate_scene đổi scene đang mở', async () => {
    const base = { version: 1, stage: { children: [{ kind: 'scene', id: 'sc', width: 1080, height: 1920, active: true }] } } as unknown as ClipDocument;
    const out = await run(base, [
      { op: 'insert_scene', node: { kind: 'scene', name: 'Scene 1', x: 1200, y: 0, width: 1920, height: 1080, paints: [{ type: 'solid', color: '#000000' }] } },
    ]);
    const scenes = out.stage.children as unknown as Node[];
    expect(scenes.map((scene) => [scene.name ?? scene.id, scene.active ?? false])).toEqual([['sc', false], ['Scene 1', true]]);
    const back = await run(out, [{ op: 'activate_scene', scene_id: 'sc' }]);
    expect((back.stage.children as unknown as Node[]).map((scene) => scene.active ?? false)).toEqual([true, false]);
    await expect(run(out, [{ op: 'activate_scene', scene_id: 'nope' }])).rejects.toThrow(/not in this project/);
  });
});

describe('nhiều timeline (E2-a)', () => {
  const two = async () => {
    const base = doc([
      { kind: 'rect', id: 'r1', name: 'Card', x: 10, width: 100, height: 100 },
    ]);
    (base.stage.children[0] as unknown as Node).active = true;
    return run(base, [{ op: 'create_timeline', from: 'sc', name: '9:16 tight' }]);
  };
  const scenes = (document: ClipDocument) => document.stage.children as unknown as Node[];

  it('create_timeline from: bản sao đủ lớp, id mới, đặt cạnh, mở bản sao', async () => {
    const out = await two();
    const [main, copy] = scenes(out);
    expect(copy!.name).toBe('9:16 tight');
    expect(copy!.active).toBe(true);
    expect(main!.active).toBeUndefined();
    expect(copy!.id).not.toBe('sc');
    expect(copy!.children![0]!.name).toBe('Card');
    expect(copy!.children![0]!.id).not.toBe('r1');
    expect(copy!.x as number).toBeGreaterThan(1080);
  });

  it('op thường chỉ sửa timeline đang mở', async () => {
    const out = await two();
    const copyCard = scenes(out)[1]!.children![0]!.id as string;
    const edited = await run(out, [{ op: 'set_props', element_id: copyCard, props: { x: 500 } }]);
    expect(scenes(edited)[1]!.children![0]!.x).toBe(500);
    expect(scenes(edited)[0]!.children![0]!.x).toBe(10);
    // Id của timeline khác không thấy được từ timeline đang mở.
    await expect(run(out, [{ op: 'set_props', element_id: 'r1', props: { x: 1 } }])).rejects.toThrow();
  });

  it('set_frame đổi khung của timeline đang mở, không phải scene đầu', async () => {
    const out = await two();
    const edited = await run(out, [{ op: 'rename_timeline', timeline_id: scenes(out)[1]!.id as string, name: 'Square' }]);
    expect(scenes(edited)[1]!.name).toBe('Square');
    const back = await run(edited, [{ op: 'set_active_timeline', timeline_id: 'sc' }]);
    expect(scenes(back).map((scene) => scene.active ?? false)).toEqual([true, false]);
  });

  it('create_timeline trống cùng cỡ; delete_timeline mở timeline đứng trước, không xoá timeline cuối', async () => {
    const out = await run(doc([]), [{ op: 'create_timeline' }]);
    const [, blank] = scenes(out);
    expect([blank!.width, blank!.height, blank!.name, blank!.children]).toEqual([1080, 1920, 'Timeline 2', undefined]);
    const removed = await run(out, [{ op: 'delete_timeline', timeline_id: blank!.id as string }]);
    expect(scenes(removed).map((scene) => [scene.id, scene.active])).toEqual([['sc', true]]);
    await expect(run(removed, [{ op: 'delete_timeline', timeline_id: 'sc' }])).rejects.toThrow(/at least one timeline/);
  });
});
