import { createCanvas } from '@napi-rs/canvas';
import { validate } from '@opencmo/clip-doc';
import { describe, expect, it } from 'vitest';

import { applyTable, bakeTable, colorFunction, colorTable, curveTable, gradeFrame, parseCube, scopeStats, type GradeStep } from './grade.ts';
import { createRenderer, type MediaHost } from './index.ts';

const step = (type: string, value: number, params: GradeStep['params'] = {}): GradeStep => ({ type, value, params });
const factory = (w: number, h: number) => createCanvas(w, h) as never;

function solid(color: string, w = 8, h = 8) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return canvas;
}

function pixelOf(canvas: { getContext(kind: '2d'): unknown } | null, x = 2, y = 2): number[] {
  const ctx = (canvas as ReturnType<typeof createCanvas>).getContext('2d');
  return [...ctx.getImageData(x, y, 1, 1).data];
}

describe('đường cong', () => {
  it('bảng đơn điệu, đi qua các điểm, không vọt', () => {
    const table = curveTable([[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]])!;
    for (let i = 1; i < 256; i++) expect(table[i]!).toBeGreaterThanOrEqual(table[i - 1]! - 1e-6);
    expect(table[0]).toBeCloseTo(0, 5);
    expect(table[255]).toBeCloseTo(1, 5);
    expect(table[Math.round(0.25 * 255)]!).toBeCloseTo(0.1, 1);
  });

  it('dưới 2 điểm thì không có bảng', () => {
    expect(curveTable([[0.5, 0.5]])).toBeNull();
    expect(curveTable(undefined)).toBeNull();
  });
});

describe('hàm màu', () => {
  it('saturation −1 ra xám, cùng luma', () => {
    const [r, g, b] = colorFunction([step('saturation', -1)])!(0.8, 0.2, 0.1);
    expect(r).toBeCloseTo(g, 5);
    expect(g).toBeCloseTo(b, 5);
    expect(r).toBeCloseTo(0.2126 * 0.8 + 0.7152 * 0.2 + 0.0722 * 0.1, 5);
  });

  it('shadows + làm sáng vùng tối nhiều hơn vùng sáng', () => {
    const fn = colorFunction([step('shadows', 1)])!;
    const dark = fn(0.2, 0.2, 0.2)[0] - 0.2;
    const bright = fn(0.9, 0.9, 0.9)[0] - 0.9;
    expect(dark).toBeGreaterThan(0.05);
    expect(dark).toBeGreaterThan(bright * 3);
  });

  it('wheels: gain đỏ làm ấm, lift không đụng điểm trắng', () => {
    const fn = colorFunction([step('wheels', 1, { gain: [0.3, 0, 0], lift: [0, 0, 0.5] })])!;
    const [r, g] = fn(0.5, 0.5, 0.5);
    expect(r).toBeGreaterThan(g);
    expect(fn(1, 1, 1)[2]).toBeCloseTo(1, 5);
  });

  it('chroma key: xanh lá thành trong suốt, da người giữ nguyên', () => {
    const fn = colorFunction([step('chromaKey', 0.4, { color: '#00ff00' })])!;
    expect(fn(0.1, 0.9, 0.15)[3]).toBe(0);
    expect(fn(0.85, 0.6, 0.5)[3]).toBe(1);
  });

  it('không có bước màu thật thì không nướng bảng', () => {
    expect(colorFunction([step('saturation', 0)])).toBeNull();
    expect(colorTable([step('grain', 0.5)])).toBeNull();
  });
});

describe('bảng 3D', () => {
  it('bảng đồng nhất giữ nguyên pixel', () => {
    const table = bakeTable((r, g, b) => [r, g, b, 1]);
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 13, 200, 77, 128, 250, 3, 140, 255]);
    const copy = new Uint8ClampedArray(data);
    applyTable(data, table);
    for (let i = 0; i < data.length; i++) expect(Math.abs(data[i]! - copy[i]!)).toBeLessThanOrEqual(1);
  });

  it('tetrahedral khớp hàm gốc trong ±2 trên một đường cong', () => {
    const fn = colorFunction([step('curves', 1, { master: [[0, 0], [0.5, 0.7], [1, 1]] })])!;
    const table = bakeTable(fn);
    const data = new Uint8ClampedArray([64, 128, 200, 255]);
    applyTable(data, table);
    const expected = fn(64 / 255, 128 / 255, 200 / 255).map((v) => v * 255);
    for (let i = 0; i < 3; i++) expect(Math.abs(data[i]! - expected[i]!)).toBeLessThanOrEqual(2);
  });
});

describe('gradeFrame', () => {
  it('không có bước chỉnh thì trả null (vẽ khung gốc)', () => {
    expect(gradeFrame(solid('#808080'), [step('blur', 3)], 8, 8, factory)).toBeNull();
  });

  it('grain tất định theo khung, khác giữa hai khung', () => {
    const frame = solid('#808080', 16, 16);
    const a = pixelOf(gradeFrame(frame, [step('grain', 1)], 16, 16, factory, 3), 5, 5);
    const b = pixelOf(gradeFrame(frame, [step('grain', 1)], 16, 16, factory, 3), 5, 5);
    const all = [...Array(16).keys()].map((x) => pixelOf(gradeFrame(frame, [step('grain', 1)], 16, 16, factory, 4), x, 5)[0]);
    expect(a).toEqual(b);
    expect(new Set(all).size).toBeGreaterThan(1);
  });

  it('glow làm sáng quanh điểm sáng', () => {
    const canvas = createCanvas(40, 40);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 40, 40);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(18, 18, 4, 4);
    const out = gradeFrame(canvas, [step('glow', 1, { threshold: 0.5, radius: 1 })], 40, 40, factory);
    expect(pixelOf(out, 15, 20)[0]!).toBeGreaterThan(5);
  });
});

describe('renderer', () => {
  const media = (frame: unknown): MediaHost => ({
    image: () => frame as never,
    video: () => null,
    duration: () => null,
    canvas: (w, h) => createCanvas(w, h),
  });

  it('effect saturation trên ảnh đi qua grade, chroma key đục lỗ thấy nền scene', () => {
    const document = validate({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene',
            name: 'S',
            width: 100,
            height: 100,
            fill: '#0000ff',
            active: true,
            children: [{ kind: 'image', width: 100, height: 100, src: 'a.png' }],
          },
        ],
      },
    });
    const image = (document.stage.children[0] as { children: { effects?: unknown[] }[] }).children[0]!;
    image.effects = [{ type: 'saturation', value: -1 }];
    const red = solid('#ff0000', 100, 100);
    const render = () => {
      const renderer = createRenderer(document, media(red));
      const canvas = createCanvas(100, 100);
      renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(0));
      return [...canvas.getContext('2d').getImageData(50, 50, 1, 1).data];
    };
    const [r, g, b] = render();
    expect(Math.abs(r! - g!)).toBeLessThanOrEqual(1);
    expect(Math.abs(g! - b!)).toBeLessThanOrEqual(1);

    image.effects = [{ type: 'chromaKey', value: 0.4, params: { color: '#ff0000' } }];
    expect(render().slice(0, 3)).toEqual([0, 0, 255]);
  });
});

describe('vignette có tham số', () => {
  const render = (params?: Record<string, number>) => {
    const document = validate({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene',
            name: 'S',
            width: 200,
            height: 100,
            fill: '#000000',
            active: true,
            children: [{ kind: 'rect', width: 200, height: 100, fill: '#ffffff' }],
          },
        ],
      },
    });
    const rect = (document.stage.children[0] as { children: { effects?: unknown[] }[] }).children[0]!;
    rect.effects = [{ type: 'vignette', value: 1, ...(params ? { params } : {}) }];
    const renderer = createRenderer(document, { image: () => null, video: () => null, duration: () => null });
    const canvas = createCanvas(200, 100);
    renderer.render(canvas.getContext('2d') as never, renderer.exportFrame(0));
    const ctx = canvas.getContext('2d');
    return (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[0]!;
  };

  it('midpoint nhỏ tối vào sâu hơn, feather 0 cho mép cứng; tâm giữ trắng', () => {
    const wide = render({ midpoint: 1 });
    const tight = render({ midpoint: 0 });
    expect(tight(100, 50)).toBeGreaterThan(250);
    expect(tight(30, 50)).toBeLessThan(wide(30, 50));
    const hard = render({ feather: 0, midpoint: 0.3 });
    expect(hard(100, 50)).toBeGreaterThan(250);
    expect(hard(2, 2)).toBeLessThan(60);
  });
});

describe('scopeStats', () => {
  it('đo điểm đen/trắng, cháy, ám màu, bỏ pixel trong suốt', () => {
    // Nửa đen tuyền, nửa trắng tuyền, thêm 1 pixel trong suốt đỏ (bị bỏ).
    const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
    const stats = scopeStats(data);
    expect(stats.black).toBe(0);
    expect(stats.white).toBe(1);
    expect(stats.clippedHighs).toBe(0.5);
    expect(stats.clippedShadows).toBe(0.5);
    expect(stats.saturation).toBe(0);
    expect(stats.histogram[0]).toBe(0.5);
    expect(stats.histogram[15]).toBe(0.5);
    const warm = scopeStats(new Uint8ClampedArray([200, 128, 80, 255]));
    expect(warm.average[0]).toBeGreaterThan(warm.average[2]);
    expect(warm.saturation).toBeCloseTo(120 / 255, 2);
  });
});

/** `.cube` kích thước n: đảo màu (1 − x), R chạy nhanh nhất. */
function invertCube(n: number, header = ''): string {
  const lines = [`TITLE "invert"`, header, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${1 - r / (n - 1)} ${1 - g / (n - 1)} ${1 - b / (n - 1)}`);
  return lines.join('\n');
}

describe('LUT .cube', () => {
  it('đọc kích thước, thứ tự R nhanh nhất, DOMAIN', () => {
    const cube = parseCube(invertCube(2));
    expect(cube.size).toBe(2);
    expect([...cube.data.slice(0, 6)]).toEqual([1, 1, 1, 0, 1, 1]);
    const scaled = parseCube(invertCube(2).replace('LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\nLUT_3D_SIZE 2'));
    expect(scaled.data[0]).toBe(0.5);
  });

  it('LUT 1D và file hỏng báo lỗi tiếng Anh', () => {
    expect(() => parseCube('LUT_1D_SIZE 4\n0 0 0')).toThrow(/3D/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/damaged/);
    expect(() => parseCube('LUT_3D_SIZE 99')).toThrow(/size/);
  });

  it('bước lut áp theo độ mạnh; chưa nạp (cube null) thì bỏ qua', () => {
    const cube = parseCube(invertCube(17));
    const full = colorFunction([{ type: 'lut', value: 1, params: { src: 'a.cube' }, cube }])!;
    const [r, g, b] = full(0.2, 0.5, 0.9);
    expect(r).toBeCloseTo(0.8, 3);
    expect(g).toBeCloseTo(0.5, 3);
    expect(b).toBeCloseTo(0.1, 3);
    const half = colorFunction([{ type: 'lut', value: 0.5, params: { src: 'a.cube' }, cube }])!;
    expect(half(0.2, 0.5, 0.9)[0]).toBeCloseTo(0.5, 3);
    expect(colorFunction([{ type: 'lut', value: 1, params: { src: 'a.cube' }, cube: null }])).toBeNull();
  });
});

describe('cache chỉnh màu theo khung', () => {
  it('cùng một đối tượng khung (decoder dùng lại) nhưng khác giây nguồn thì chỉnh lại', () => {
    const document = validate({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene',
            name: 'S',
            width: 10,
            height: 10,
            fill: '#000000',
            active: true,
            children: [{ kind: 'video', width: 10, height: 10, src: 'a.mp4' }],
          },
        ],
      },
    });
    const video = (document.stage.children[0] as { children: { effects?: unknown[] }[] }).children[0]!;
    video.effects = [{ type: 'saturation', value: -1 }];
    const shared = createCanvas(10, 10);
    const host: MediaHost = { image: () => null, video: () => shared as never, duration: () => 2, canvas: (w, h) => createCanvas(w, h) };
    const renderer = createRenderer(document, host);
    const read = (seconds: number, color: string) => {
      const c = shared.getContext('2d');
      c.fillStyle = color;
      c.fillRect(0, 0, 10, 10);
      const out = createCanvas(10, 10);
      renderer.render(out.getContext('2d') as never, renderer.exportFrame(seconds));
      return out.getContext('2d').getImageData(5, 5, 1, 1).data[0]!;
    };
    const dark = read(0, '#202020');
    const bright = read(1, '#e0e0e0');
    expect(bright).toBeGreaterThan(dark + 100);
  });
});
