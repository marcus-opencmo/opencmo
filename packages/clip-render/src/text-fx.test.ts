import { createCanvas } from '@napi-rs/canvas';
import { validate } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { captionFrame } from './captions.ts';
import { evaluate } from './frame.ts';
import { createRenderer, type MediaHost } from './index.ts';
import { buildTree } from './tree.ts';

const NO_MEDIA: MediaHost = { image: () => null, video: () => null, duration: () => null };

type Fx = Record<string, unknown>;

const project = (animation: Fx) =>
  validate({
    version: 1,
    stage: {
      children: [
        {
          kind: 'scene',
          name: 'S',
          width: 400,
          height: 100,
          fill: '#000000',
          active: true,
          children: [
            { kind: 'text', x: 10, y: 20, end: 4, text: 'AAAA BBBB', color: '#FFFFFF', fontSize: 48, animations: [animation] },
          ],
        },
      ],
    },
  });

/** Đếm điểm ảnh trắng / đỏ ở nửa trái và nửa phải của chữ (cột chia ở giữa hai từ). */
function halves(animation: Fx, frame: number) {
  const document = project(animation);
  const renderer = createRenderer(document, NO_MEDIA);
  const canvas = createCanvas(400, 100);
  renderer.render(canvas.getContext('2d') as never, frame);
  const data = canvas.getContext('2d').getImageData(0, 0, 400, 100).data;
  // Bề ngang "AAAA " để biết cột chia.
  const ctx = createCanvas(10, 10).getContext('2d');
  ctx.font = '48px Inter';
  const split = 10 + ctx.measureText('AAAA ').width - 4;
  const count = { leftWhite: 0, rightWhite: 0, leftRed: 0, rightRed: 0 };
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 400; x++) {
      const p = (y * 400 + x) * 4;
      const [r, g, b] = [data[p]!, data[p + 1]!, data[p + 2]!];
      // Bỏ dải 16 px quanh cột chia: từ đang phóng 1.15 tràn sang một chút.
      if (Math.abs(x - split) < 16) continue;
      const side = x < split ? 'left' : 'right';
      if (r > 200 && g > 200 && b > 200) count[`${side}White`]++;
      if (r > 200 && g < 80 && b < 80) count[`${side}Red`]++;
    }
  }
  return count;
}

describe('animation chữ theo từ (E4)', () => {
  it('wordSlide: từ hiện lần lượt theo perWord', () => {
    const fx = { type: 'wordSlide', perWord: 1 };
    const start = halves(fx, 0);
    expect(start.leftWhite + start.rightWhite).toBeLessThan(20);
    // perWord 1 s = 30 khung, mỗi từ trượt trong 60 khung. Khung 45: từ 1 gần xong (98%), từ 2 mới 25% (còn mờ).
    const mid = halves(fx, 45);
    expect(mid.leftWhite).toBeGreaterThan(200);
    expect(mid.rightWhite).toBeLessThan(mid.leftWhite / 3);
    const end = halves(fx, 119);
    expect(end.rightWhite).toBeGreaterThan(200);
  });

  it('highlightPop: từ đang tới màu nhấn, từ khác giữ màu chữ; hết lượt thì về màu thường', () => {
    const fx = { type: 'highlightPop', perWord: 0.5, color: '#FF0000' };
    const first = halves(fx, 5);
    expect(first.leftRed).toBeGreaterThan(200);
    expect(first.rightWhite).toBeGreaterThan(200);
    expect(first.rightRed).toBe(0);
    const second = halves(fx, 20);
    expect(second.rightRed).toBeGreaterThan(200);
    expect(second.leftWhite).toBeGreaterThan(200);
    const done = halves(fx, 40);
    expect(done.leftRed + done.rightRed).toBe(0);
  });

  it('typewriter: hiện dần ký tự, có con trỏ khi đang gõ, đủ chữ khi xong', () => {
    const document = project({ type: 'typewriter', duration: 1 });
    const root = buildTree(document.stage.children[0] as never, NO_MEDIA);
    evaluate(root, 15, [1, 0, 0, 1, 0, 0]);
    const text = root.children[0]!;
    expect(text.chars!.endsWith('|')).toBe(true);
    expect(text.chars!.length).toBeLessThan('AAAA BBBB'.length + 1);
    evaluate(root, 45, [1, 0, 0, 1, 0, 0]);
    expect(root.children[0]!.chars).toBeNull();
  });
});

describe('phụ đề highlight pop (E4)', () => {
  it('từ đang nói có range màu nhấn và phóng sau 0.08 s', () => {
    const group = [
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.5, end: 1 },
    ];
    const frame = captionFrame({ kind: 'captions', src: 'x.json', preset: 'classic', highlight: 'pop' } as never, [group], 0.7, 0);
    expect(frame.pop).toBeDefined();
    expect(frame.pop!.scale).toBeCloseTo(1.15, 5);
    expect(frame.text.slice(frame.pop!.range.start, frame.pop!.range.end)).toBe('world');
  });
});

describe('kiểu chữ (E4-b/c)', () => {
  const scene = (body: Record<string, unknown>[], fill = '#000000') =>
    validate({
      version: 1,
      stage: { children: [{ kind: 'scene', name: 'S', width: 300, height: 120, fill, active: true, children: body }] },
    });
  const render = (body: Record<string, unknown>[], fill?: string, edit?: (doc: ReturnType<typeof scene>) => void) => {
    const document = scene(body, fill);
    edit?.(document);
    const renderer = createRenderer(document, { ...NO_MEDIA, canvas: (w, h) => createCanvas(w, h) });
    const canvas = createCanvas(300, 120);
    renderer.render(canvas.getContext('2d') as never, 0);
    const ctx = canvas.getContext('2d');
    return (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
  };
  const textNode = (doc: ReturnType<typeof scene>) => (doc.stage.children[0] as unknown as { children: Record<string, unknown>[] }).children.at(-1)!;

  it('hộp nền bao chữ có padding; ngoài hộp vẫn là nền scene', () => {
    const at = render([{ kind: 'text', x: 60, y: 40, text: 'Hi', color: '#FFFFFF', fontSize: 30 }], '#000000', (doc) => {
      textNode(doc).background = { color: '#0000FF', paddingX: 20, paddingY: 10, radius: 4 };
    });
    expect(at(45, 50)).toEqual([0, 0, 255]);
    expect(at(10, 10)).toEqual([0, 0, 0]);
  });

  it('gạch dưới nằm dưới chữ, theo bề rộng dòng', () => {
    const without = render([{ kind: 'text', x: 20, y: 20, text: 'HELLO', color: '#FFFFFF', fontSize: 40 }]);
    const withLine = render([{ kind: 'text', x: 20, y: 20, text: 'HELLO', color: '#FFFFFF', fontSize: 40 }], '#000000', (doc) => {
      textNode(doc).decoration = ['underline'];
    });
    let added = 0;
    for (let y = 40; y < 80; y++) if (withLine(60, y)[0]! > 200 && without(60, y)[0]! < 50) added++;
    expect(added).toBeGreaterThan(0);
  });

  it('footage: trong lòng chữ thấy lớp dưới, ngoài chữ phủ màu chữ', () => {
    const body = [
      { kind: 'rect', width: 300, height: 120, fill: '#FF0000' },
      { kind: 'text', x: 10, y: 10, text: 'II', color: '#000000', fontSize: 100, fontWeight: 900 },
    ];
    const at = render(body, '#000000', (doc) => {
      textNode(doc).fill = 'footage';
    });
    // Góc khung: phủ đen (màu chữ). Giữa nét chữ "I" đầu: thấy đỏ của rect.
    expect(at(290, 110)).toEqual([0, 0, 0]);
    let red = 0;
    for (let x = 10; x < 60; x++) if (at(x, 60)[0]! > 200) red++;
    expect(red).toBeGreaterThan(5);
  });

  it('inverted: chữ trắng trên nền trắng thành đen (difference)', () => {
    const at = render([
      { kind: 'rect', width: 300, height: 120, fill: '#FFFFFF' },
      { kind: 'text', x: 10, y: 10, text: 'II', color: '#FFFFFF', fontSize: 100, fontWeight: 900 },
    ], '#FFFFFF', (doc) => {
      textNode(doc).fill = 'inverted';
    });
    let black = 0;
    for (let x = 10; x < 60; x++) if (at(x, 60)[0]! < 50) black++;
    expect(black).toBeGreaterThan(5);
  });

  it('tiltY co bề ngang chữ', () => {
    const width = (tilt: number) => {
      const document = scene([{ kind: 'text', x: 20, y: 20, text: 'WIDE TEXT', color: '#FFFFFF', fontSize: 40 }]);
      textNode(document).tiltY = tilt;
      const renderer = createRenderer(document, NO_MEDIA);
      const canvas = createCanvas(300, 120);
      renderer.render(canvas.getContext('2d') as never, 0);
      const data = canvas.getContext('2d').getImageData(0, 0, 300, 120).data;
      let min = 300;
      let max = 0;
      for (let y = 0; y < 120; y++) for (let x = 0; x < 300; x++) if (data[(y * 300 + x) * 4]! > 128) (min = Math.min(min, x)), (max = Math.max(max, x));
      return max - min;
    };
    expect(width(60)).toBeLessThan(width(0) * 0.7);
  });
});
