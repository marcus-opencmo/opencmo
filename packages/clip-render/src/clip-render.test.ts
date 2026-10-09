import { createCanvas } from '@napi-rs/canvas';
import { validate } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { easing } from './easing.ts';
import { evaluate } from './frame.ts';
import { createRenderer, mediaSources, type MediaHost } from './index.ts';
import { buildTree, type RNode } from './tree.ts';

const NO_MEDIA: MediaHost = { image: () => null, video: () => null, duration: () => null };

type Nodes = Record<string, unknown>[];

const project = (body: Nodes, scene: Record<string, unknown> = { width: 100, height: 100, fill: '#000000' }) =>
  validate({ version: 1, stage: { children: [{ kind: 'scene', name: 'S', ...scene, active: true, children: body }] } });

function treeAt(body: Nodes, frame: number, media: MediaHost = NO_MEDIA, scene?: Record<string, unknown>): RNode {
  const document = project(body, scene);
  const root = buildTree(document.stage.children[0] as never, media);
  evaluate(root, frame, [1, 0, 0, 1, 0, 0]);
  return root;
}

/** Màu điểm ảnh sau khi vẽ thật bằng Skia (đường export). */
function pixel(body: Nodes, seconds: number, x: number, y: number, media: MediaHost = NO_MEDIA): [number, number, number] {
  const renderer = createRenderer(project(body), media);
  const canvas = createCanvas(100, 100);
  renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(seconds));
  const data = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return [data[0]!, data[1]!, data[2]!];
}

describe('thời gian theo frame', () => {
  it('start/end/sourceIn quy về frame nguyên, gốc giữ phần lẻ', () => {
    const [clip] = treeAt([{ kind: 'rect', start: 1, end: 2.5, sourceIn: 0.5, playbackRate: 2 }], 0).children;
    // origin = start − sourceIn / rate = 30 − 15/2
    expect(clip!.origin).toBe(22.5);
    expect(clip!.start).toBe(30);
    expect(clip!.end).toBe(75);
  });

  it('không có end: nguồn có độ dài thì theo nguồn, không thì 16 giây', () => {
    const media: MediaHost = { ...NO_MEDIA, duration: () => 4 };
    expect(treeAt([{ kind: 'video', src: 'a.mp4' }], 0, media).children[0]!.end).toBe(120);
    expect(treeAt([{ kind: 'rect' }], 0).children[0]!.end).toBe(480);
  });

  it('group không có end bao trọn con; có end thì cắt', () => {
    const root = treeAt(
      [
        { kind: 'group', children: [{ kind: 'rect', start: 1, end: 2 }, { kind: 'rect', start: 3, end: 5 }] },
        { kind: 'group', end: 1, children: [{ kind: 'rect', start: 0, end: 4 }] },
      ],
      0,
    );
    expect([root.children[0]!.start, root.children[0]!.end]).toEqual([30, 150]);
    expect(root.children[1]!.end).toBe(30);
  });

  it('khoảng hiện là [start, end)', () => {
    const at = (frame: number) => treeAt([{ kind: 'rect', start: 1, end: 2 }], frame).children[0]!.visible;
    expect([at(29), at(30), at(59), at(60)]).toEqual([false, true, true, false]);
  });

  it('export bắt đầu ở đầu workarea, hai phép làm tròn tách riêng', () => {
    const renderer = createRenderer(project([{ kind: 'rect' }], { width: 100, height: 100, workarea: [2, 4] }), NO_MEDIA);
    expect(renderer.exportFrame(0)).toBe(60);
    expect(renderer.exportFrame(1.75)).toBe(113);
  });
});

describe('giá trị mỗi khung', () => {
  it('keyframe nội suy theo frame, giữ mép ngoài khoảng', () => {
    const x = (frame: number) =>
      treeAt(
        [
          {
            kind: 'rect',
            tracks: [{ property: 'x', keyframes: [{ time: 1, value: 10 }, { time: 2, value: 40 }] }],
          },
        ],
        frame,
      ).children[0]!.values.x;
    expect([x(0), x(30), x(45), x(60), x(90)]).toEqual([10, 10, 25, 40, 40]);
  });

  it('easing có tên mở thành đường cong của fork', () => {
    expect(easing('linear')).toBeNull();
    expect(easing('easeIn')!(0.5)).toBeCloseTo(0.3154, 3);
    expect(easing('steps(4)')!(0.3)).toBe(0.25);
    expect(easing('gentle')!(0.3)).toBeGreaterThan(1);
  });

  it('scale cùng scaleX: node tĩnh theo trục, node có motion theo scale', () => {
    const still = treeAt([{ kind: 'rect', scale: 0.6, scaleX: 2 }], 0).children[0]!.values;
    expect([still.scaleX, still.scaleY]).toEqual([2, 1]);
    const moving = treeAt([{ kind: 'rect', scale: 0.6, scaleX: 2, animations: [{ type: 'fade', duration: 0.1 }] }], 60).children[0]!
      .values;
    expect([moving.scaleX, moving.scaleY]).toEqual([0.6, 0.6]);
  });

  it('fade vào: trước cửa sổ giữ 0, hết cửa sổ về tĩnh', () => {
    const opacity = (frame: number) =>
      treeAt([{ kind: 'rect', start: 0, end: 4, animations: [{ type: 'fade', duration: 1, delay: 1 }] }], frame).children[0]!.values
        .opacity;
    expect(opacity(0)).toBe(0);
    expect(opacity(45)).toBeGreaterThan(0.5);
    expect(opacity(61)).toBe(1);
  });

  it('adjustment layer nhân transform vào clip ngay dưới nó', () => {
    const root = treeAt([{ kind: 'rect', x: 10 }, { kind: 'adjustmentLayer', x: 5, y: 7, width: 100, height: 100 }], 0);
    expect(root.children[0]!.localMatrix.slice(4)).toEqual([15, 7]);
  });
});

describe('vẽ bằng Skia (đường export)', () => {
  it('fill, và opacity nhân dồn qua các cấp (không cô lập lớp)', () => {
    expect(pixel([{ kind: 'rect', x: 10, y: 10, width: 50, height: 50, fill: '#FF0000' }], 0, 20, 20)).toEqual([255, 0, 0]);
    // 0.5 × 0.5 trắng trên đen ≈ 64; Skia làm tròn xuống 63.
    const [r, g, b] = pixel([
      {
        kind: 'group',
        opacity: 0.5,
        children: [{ kind: 'rect', width: 100, height: 100, opacity: 0.5, fill: '#FFFFFF' }],
      },
    ], 0, 5, 5);
    for (const channel of [r, g, b]) expect(Math.abs(channel - 64)).toBeLessThanOrEqual(1);
  });

  it('mask cắt cha: ngoài mask là nền scene', () => {
    const body = [
      {
        kind: 'rect',
        width: 100,
        height: 100,
        fill: '#00FF00',
        masks: [{ kind: 'rect', x: 0, y: 0, width: 50, height: 100 }],
      },
    ];
    expect(pixel(body, 0, 25, 50)).toEqual([0, 255, 0]);
    expect(pixel(body, 0, 75, 50)).toEqual([0, 0, 0]);
  });

  it('media hỏng vẽ màu báo lỗi, media chưa có thì để trống', () => {
    const body = [{ kind: 'image', width: 100, height: 100, src: 'a.png' }];
    expect(pixel(body, 0, 50, 50, { ...NO_MEDIA, image: () => 'failed' })).toEqual([0x5c, 0x28, 0x28]);
    expect(pixel(body, 0, 50, 50)).toEqual([0, 0, 0]);
  });

  it('liệt kê nguồn media để nạp trước', () => {
    const document = project([{ kind: 'video', src: 'a.mp4' }, { kind: 'rect', paints: [{ type: 'image', src: 'b.png' }] }]);
    expect(mediaSources(document)).toEqual([
      { kind: 'video', src: 'a.mp4' },
      { kind: 'image', src: 'b.png' },
    ]);
  });
});

describe('chữ (A3)', () => {
  it('hiện dần theo từ/ký tự, không kèm khoảng trắng sau từ cuối', async () => {
    const { revealWords, revealChars } = await import('./text.ts');
    expect(revealWords('one two  three four', 0.5)).toBe('one two');
    expect(revealWords('one two three', 0.2)).toBe('');
    expect(revealWords('one two three', 1)).toBe('one two three');
    expect(revealChars('abcdef', 0.5)).toBe('abc');
  });

  it('scramble: giữ độ dài và dấu cách, ổn định dần từ trái, tất định', async () => {
    const { scramble } = await import('./text.ts');
    const text = 'Words appear one by one';
    const early = scramble(text, 0.2);
    expect(early).toHaveLength(text.length);
    expect([...early].filter((char, index) => text[index] === ' ' && char === ' ')).toHaveLength(4);
    expect(scramble(text, 0.2)).toBe(early);
    // Ký tự đầu ổn định ở 0.3, ký tự cuối ở gần 1: giữa chừng thì đầu đã đúng, cuối chưa.
    const mid = scramble(text, 0.45);
    expect(mid.slice(0, 3)).toBe(text.slice(0, 3));
    expect(mid.slice(-3)).not.toBe(text.slice(-3));
    expect(scramble(text, 1)).toBe(text);
  });

  it('không có đủ width + height thì hộp co theo chữ (textAlign không còn gì để căn)', () => {
    const renderer = createRenderer(project([{ kind: 'text', width: 100, text: 'Hi', color: '#FFFFFF', fontSize: 20, textAlign: 'center' }]), NO_MEDIA);
    const canvas = createCanvas(100, 100);
    renderer.render(canvas.getContext('2d') as never, 0);
    const data = canvas.getContext('2d').getImageData(0, 0, 100, 100).data;
    // Chữ nằm sát mép trái, không ở giữa hộp 100 px.
    let leftmost = 100;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (data[(y * 100 + x) * 4]! > 128) leftmost = Math.min(leftmost, x);
    expect(leftmost).toBeLessThan(10);
  });
});

describe('phụ đề (A3)', () => {
  const words = (spec: [string, number, number][]) => spec.map(([text, start, end]) => ({ text, start, end }));

  it('nhóm từ: không gộp qua câu, đóng sau dấu câu, giới hạn độ dài/thời lượng', async () => {
    const { groupWords } = await import('./captions.ts');
    const transcript = [
      { words: words([['so', 0, 0.1], ['this,', 0.1, 0.2], ['is', 0.2, 0.3], ['it', 0.3, 0.4]]) },
      { words: words([['next', 1, 1.1]]) },
    ];
    expect(groupWords(transcript, { length: 50 }).map((g) => g.map((w) => w.text).join(' '))).toEqual(['so this,', 'is it', 'next']);
    expect(groupWords(transcript, { duration: 0.2 }).map((g) => g.length)).toEqual([2, 2, 1]);
  });

  it('ngắt theo trần (học Palmier): câu → mệnh đề → giữa; giữ U.S. và 3.14', async () => {
    const { groupPhrases } = await import('./captions.ts');
    const line = (text: string) => ({ words: text.split(' ').map((w, i) => ({ text: w, start: i, end: i + 0.8 })) });
    const texts = (groups: { text: string }[][]) => groups.map((g) => g.map((w) => w.text).join(' '));
    // Hết câu được ưu tiên dù không ở đúng giữa.
    expect(texts(groupPhrases([line('We shipped it. Then the clients paid on time')], { maxWords: 4 }))).toEqual(['We shipped it.', 'Then the clients', 'paid on time']);
    // Không có câu: ngắt ở dấu phẩy.
    expect(texts(groupPhrases([line('If you invoice late, you get paid late')], { maxWords: 5 }))).toEqual(['If you invoice late,', 'you get paid late']);
    // "U.S." không phải hết câu; "3.14" nguyên vẹn.
    expect(texts(groupPhrases([line('The U.S. rate is 3.14 percent now')], { maxWords: 4 }))).toEqual(['The U.S. rate is', '3.14 percent now']);
    // Trần ký tự.
    expect(groupPhrases([line('one two three four five six')], { maxChars: 9 }).every((g) => g.map((w) => w.text).join(' ').length <= 9)).toBe(true);
    // Vừa trần: giữ nguyên dòng.
    expect(texts(groupPhrases([line('short line')], { maxWords: 6 }))).toEqual(['short line']);
  });

  it('animation pop: bắt đầu nhỏ và mờ, vượt nhẹ quá 1 rồi về đúng 1', async () => {
    const { createRenderer } = await import('./index.ts');
    const doc = {
      version: 1,
      stage: { children: [{ kind: 'scene', id: 'sc', width: 100, height: 100, children: [
        { kind: 'rect', id: 'r', width: 50, height: 50, start: 0, end: 2, animations: [{ type: 'pop', phase: 'in', duration: 0.5 }] },
      ] }] },
    } as never;
    const host = { image: () => null, video: () => null, duration: () => null };
    const renderer = createRenderer(doc, host as never);
    const at = (frame: number) => renderer.layout(frame).find((box) => (box.node as { id?: string }).id === 'r')!.values as { scaleX: number; opacity: number };
    expect(at(0).scaleX).toBeCloseTo(0.6, 2);
    expect(at(0).opacity).toBeLessThan(0.1);
    const peak = Math.max(...[6, 7, 8, 9, 10, 11].map((f) => at(f).scaleX));
    expect(peak).toBeGreaterThan(1);
    expect(at(20).scaleX).toBeCloseTo(1, 5);
    expect(at(20).opacity).toBe(1);
  });

  it('holdGap: dòng ở lại qua khoảng lặng ngắn, không qua khoảng dài', async () => {
    const { stateAt } = await import('./captions.ts');
    const groups = [
      [{ text: 'a', start: 0, end: 1 }],
      [{ text: 'b', start: 1.3, end: 2 }],
      [{ text: 'c', start: 5, end: 6 }],
    ];
    const node = { kind: 'captions', holdGap: 0.5 } as never;
    expect(stateAt(node, groups, 1.15)).toBe('0');
    expect(stateAt(node, groups, 3)).toBe(null);
    expect(stateAt(node, groups, 6.3)).toBe('2');
    expect(stateAt(node, groups, 6.6)).toBe(null);
    expect(stateAt({ kind: 'captions' } as never, groups, 1.15)).toBe(null);
  });

  it('chia hai dòng tại dấu cách gần giữa nhất', async () => {
    const { splitLines } = await import('./captions.ts');
    const [left, right] = splitLines(words([['people', 0, 1], ['scream', 1, 2], ['about', 2, 3]]));
    expect(left.map((w) => w.text)).toEqual(['people', 'scream']);
    expect(right.map((w) => w.text)).toEqual(['about']);
  });

  it('guinea: màu nhấn theo số lần dòng đổi khi phát LIÊN TỤC, tua lùi thì đếm lại', async () => {
    const { captionFrame, groupWords } = await import('./captions.ts');
    const transcript = [{ words: words([['aa', 0, 0.5], ['bb', 0.5, 1], ['cc', 1, 1.5], ['dd', 1.5, 2]]) }];
    const document = project([{ kind: 'captions', src: 't.json', preset: 'guinea' }]);
    const media: MediaHost = { ...NO_MEDIA, transcript: () => transcript };
    const root = buildTree(document.stage.children[0] as never, media);
    const colorAt = (frame: number) => {
      evaluate(root, frame, [1, 0, 0, 1, 0, 0]);
      return root.children[0]!.caption!.node.ranges?.[0]?.paints?.[0];
    };
    const first = colorAt(0);
    expect(colorAt(40)).not.toEqual(first);
    expect(colorAt(0)).toEqual(first);
    // Cùng khung, cùng màu dù hỏi riêng lẻ: không phụ thuộc lịch sử tua.
    const captions = (document.stage.children[0] as unknown as { children: never[] }).children[0]!;
    expect(captionFrame(captions, groupWords(transcript, { length: 18 }), 0, 1).node.ranges).toBeDefined();
  });

  it('stark: chỉ vẽ bằng paint trắng blend difference, không có màu chữ gốc', async () => {
    const { captionFrame } = await import('./captions.ts');
    const frame = captionFrame({ kind: 'captions', preset: 'stark' }, [words([['hi', 0, 1]])], 0.5, 0);
    expect(frame.node.color).toBeUndefined();
    expect(frame.node.paints).toEqual([{ type: 'solid', color: '#FFFFFF', blendMode: 'difference' }]);
    expect(frame.node.textCase).toBe('upper');
  });

  it('font, độ đậm, màu chữ đè preset; thiếu thì đúng preset; stark bỏ qua màu', async () => {
    const { captionFrame } = await import('./captions.ts');
    const group = [words([['hi', 0, 1]])];
    const plain = captionFrame({ kind: 'captions', preset: 'spotlight' }, group, 0.5, 0);
    expect(plain.node).toMatchObject({ fontFamily: 'Montserrat', fontWeight: 900, color: '#FFFFFF' });
    const styled = captionFrame({ kind: 'captions', preset: 'spotlight', fontFamily: 'Bebas Neue', fontWeight: 400, color: '#FFD400' }, group, 0.5, 0);
    expect(styled.node).toMatchObject({ fontFamily: 'Bebas Neue', fontWeight: 400, color: '#FFD400' });
    expect(captionFrame({ kind: 'captions', preset: 'stark', color: '#FF0000' }, group, 0.5, 0).node.color).toBeUndefined();
  });

  it('highlight block: range đúng từ đang nói (không lấy dấu cách), màu hộp từ colors[0]; spotlight bỏ tô chữ', async () => {
    const { captionFrame } = await import('./captions.ts');
    const group = [words([['most', 0, 0.4], ['freelancers', 0.4, 0.8], ['chase', 0.8, 1.2]])];
    const frame = captionFrame({ kind: 'captions', preset: 'classic', highlight: 'block' }, group, 0.9, 0);
    expect(frame.text.slice(frame.block!.range.start, frame.block!.range.end)).toBe('chase');
    expect(frame.block!.color).toBe('#FFD400');
    expect(frame.node.ranges).toContain(frame.block!.range);
    const spot = captionFrame({ kind: 'captions', preset: 'spotlight', highlight: 'block', colors: ['#22D3EE'] }, group, 0.5, 0);
    expect(spot.block!.color).toBe('#22D3EE');
    expect(spot.node.ranges!.filter((range) => range.paints)).toHaveLength(0);
    expect(captionFrame({ kind: 'captions', preset: 'classic' }, group, 0.9, 0).block).toBeUndefined();
    // paper/guinea tự xuống dòng (chữ khác chuỗi nhóm): không có hộp.
    expect(captionFrame({ kind: 'captions', preset: 'paper', highlight: 'block' }, group, 0.9, 0).block).toBeUndefined();
  });

  it('fontScale nhân cỡ chữ và hộp của preset', async () => {
    const { captionFrame, placeCaption } = await import('./captions.ts');
    const group = [words([['hi', 0, 1]])];
    const normal = captionFrame({ kind: 'captions', preset: 'spotlight' }, group, 0.5, 0);
    const big = captionFrame({ kind: 'captions', preset: 'spotlight', fontScale: 1.5 }, group, 0.5, 0);
    expect(big.node.fontSize).toBe(normal.node.fontSize! * 1.5);
    const frame = { width: 1080, height: 1920 };
    const box = placeCaption({ kind: 'captions', preset: 'spotlight', fontScale: 1.5 }, frame);
    expect(box.width).toBe(placeCaption({ kind: 'captions', preset: 'spotlight' }, frame).width * 1.5);
    expect(box.x + box.width / 2).toBe(540);
  });

  it('dòng dài hơn khung (phụ đề có sẵn, cả câu là một "từ") được kéo vào trong khung', () => {
    // UAT production 29/09: Stark vẽ một dòng dài gấp rưỡi khung 1080, cắt cả hai mép.
    const line = 'who was in a drawing lesson she was six and she was at the back';
    const transcript = [{ text: line, words: words([[line, 0, 3]]) }];
    const media: MediaHost = { ...NO_MEDIA, transcript: () => transcript };
    for (const preset of ['spotlight', 'stark', 'classic', 'guinea', 'cascade']) {
      const document = project([{ kind: 'captions', src: 't.json', preset }], { width: 1080, height: 1920, fill: '#000000' });
      const renderer = createRenderer(document, media);
      const canvas = createCanvas(1080, 1920);
      renderer.render(canvas.getContext('2d') as never, 30);
      const data = canvas.getContext('2d').getImageData(0, 0, 1080, 1920).data;
      let lit = 0;
      let edge = 0;
      for (let y = 0; y < 1920; y++) {
        for (let x = 0; x < 1080; x++) {
          const i = (y * 1080 + x) * 4;
          if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < 128) continue;
          lit++;
          if (x < 20 || x > 1060) edge++;
        }
      }
      expect(lit, preset).toBeGreaterThan(0);
      expect(edge, preset).toBe(0);
    }
  });
});

describe('tiếng', () => {
  it('volume và muted trên sequence/group nhân vào mọi clip bên trong', () => {
    const media: MediaHost = { ...NO_MEDIA, duration: () => 10 };
    const renderer = createRenderer(
      project([
        { kind: 'sequence', volume: -6, children: [{ kind: 'audio', end: 2, src: 'a.mp3' }] },
        { kind: 'group', muted: true, children: [{ kind: 'audio', end: 2, src: 'b.mp3' }] },
        { kind: 'audio', end: 2, src: 'c.mp3', volume: 6 },
      ]),
      media,
    );
    const [a, b, c] = renderer.gains(0);
    expect(a).toBeCloseTo(10 ** (-6 / 20), 5);
    expect(b).toBe(0);
    expect(c).toBeCloseTo(10 ** (6 / 20), 5);
  });
});

describe('layout (hộp cho canvas và op hình học)', () => {
  it('hộp theo toạ độ scene, cha trước con, nhóm bao con, ẩn theo thời gian', () => {
    const renderer = createRenderer(
      project(
        [
          {
            kind: 'group',
            name: 'G',
            x: 10,
            children: [
              { kind: 'rect', name: 'A', x: 20, y: 30, width: 40, height: 10 },
              { kind: 'rect', name: 'B', x: 50, y: 30, rotation: 90, width: 10, height: 20 },
            ],
          },
          { kind: 'rect', name: 'Late', width: 5, height: 5, start: 2 },
        ],
      ),
      NO_MEDIA,
    );
    const boxes = renderer.layout(0);
    expect(boxes.map((box) => (box.node as { name?: string }).name)).toEqual(['G', 'A', 'B', 'Late']);
    const [group, a, b, late] = boxes;
    const corner = (m: number[], x: number, y: number) => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
    expect(corner(a!.matrix, 0, 0)).toEqual([30, 30]);
    expect(a!.box).toEqual([0, 0, 40, 10]);
    // B xoay 90° quanh tâm (55, 40): thành 20×10, x 45…65 — nhóm bao 20…65 × 30…45.
    expect(group!.box.map((n) => Math.round(n))).toEqual([20, 30, 45, 15]);
    expect(b!.values.rotation).toBe(90);
    expect(late!.visible).toBe(false);
    expect(renderer.layout(90)[3]!.visible).toBe(true);
  });
});

describe('lottie', () => {
  it('xin khung theo giây cục bộ × speed + offset, đúng cỡ pixel của hộp', () => {
    const calls: [unknown, number, number, number, boolean][] = [];
    const frame = createCanvas(10, 10);
    frame.getContext('2d').fillStyle = '#00FF00';
    frame.getContext('2d').fillRect(0, 0, 10, 10);
    const media: MediaHost = {
      ...NO_MEDIA,
      lottie: (src, seconds, width, height, loop) => {
        calls.push([src, seconds, width, height, loop]);
        return frame as never;
      },
    };
    const renderer = createRenderer(project([
      {
        kind: 'lottie',
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        start: 1,
        src: 'builtin:walk',
        speed: 2,
        loop: false,
        offset: 0.5,
      },
    ]), media);
    const canvas = createCanvas(200, 200);
    renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(2));
    // Giây cục bộ = 1 → 1 × 2 + 0.5.
    expect(calls.at(-1)).toEqual(['builtin:walk', 2.5, 40, 20, false]);
    expect([...canvas.getContext('2d').getImageData(20, 20, 1, 1).data.slice(0, 3)]).toEqual([0, 255, 0]);
  });

  it('nguồn hỏng vẽ màu báo thiếu; builtin: không cần tải', () => {
    const media: MediaHost = { ...NO_MEDIA, lottie: () => 'failed' };
    expect(pixel([{ kind: 'lottie', width: 100, height: 100, src: 'x.json' }], 0, 50, 50, media)).not.toEqual([0, 0, 0]);
    const document = project([{ kind: 'lottie', src: 'builtin:walk' }, { kind: 'lottie', src: 'upload.json' }]);
    expect(mediaSources(document).map((item) => [item.kind, item.src])).toEqual([['lottie', 'upload.json']]);
  });
});

describe('lottie: thời gian + tên builtin (dùng chung preview/export)', async () => {
  const { builtinLottieName, lottieTime } = await import('./index.ts');
  it('lặp quay vòng, không lặp dừng ở khung cuối', () => {
    expect(lottieTime(5, 2, 30, true)).toBeCloseTo(1);
    expect(lottieTime(5, 2, 30, false)).toBeCloseTo(2 - 1 / 30);
    expect(lottieTime(5, 0, 30, true)).toBe(0);
  });
  it('builtin cho một cấp thư mục, bỏ ký tự lạ, không thoát thư mục', () => {
    expect(builtinLottieName('builtin:walk')).toBe('walk');
    expect(builtinLottieName('builtin:emoji/fire')).toBe('emoji/fire');
    expect(builtinLottieName('builtin:../../etc/passwd')).toBe(null);
    expect(builtinLottieName('builtin:..%2Fsecret')).toBe(null);
    expect(builtinLottieName('builtin:a/b/c')).toBe(null);
    expect(builtinLottieName('folder/x.json')).toBe(null);
  });
});

describe('objectPosition (E5)', () => {
  it('cover cắt theo điểm neo: neo trái giữ nửa trái của ảnh, mặc định giữ giữa', () => {
    // Ảnh 200×100: nửa trái đỏ, nửa phải xanh. Hộp 100×100 → cover cắt mất 100 px ngang.
    const image = createCanvas(200, 100);
    const c = image.getContext('2d');
    c.fillStyle = '#ff0000';
    c.fillRect(0, 0, 100, 100);
    c.fillStyle = '#0000ff';
    c.fillRect(100, 0, 100, 100);
    const media: MediaHost = { ...NO_MEDIA, image: () => image as never };
    const left = pixel([{ kind: 'image', width: 100, height: 100, src: 'a.png', objectPosition: [0, 0.5] }], 0, 80, 50, media);
    const right = pixel([{ kind: 'image', width: 100, height: 100, src: 'a.png', objectPosition: [1, 0.5] }], 0, 20, 50, media);
    const middle = pixel([{ kind: 'image', width: 100, height: 100, src: 'a.png' }], 0, 20, 50, media);
    expect(left[0]).toBeGreaterThan(200);
    expect(right[2]).toBeGreaterThan(200);
    expect(middle[0]).toBeGreaterThan(200);
  });
});
