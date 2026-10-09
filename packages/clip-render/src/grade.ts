/**
 * Chỉnh màu và hiệu ứng trên PIXEL (E3, học hành vi Palmier Adjust — công thức tự viết).
 *
 * Toàn bộ phần màu (tone, saturation, wheels, curves, hue curves, chroma key) gom thành
 * MỘT bảng 3D 33³ (RGB → RGBA) rồi áp bằng nội suy tetrahedral: đo trên Node, khung
 * 1920×1080 mất ~36 ms (`note.md` 04/10) — đủ cho export, và preview chỉ chạy ở số pixel
 * đang hiện. JS thuần nên trình duyệt và exporter Node ra cùng một màu (không WebGL).
 * Phần không gian (sharpen, clarity, glow, grain, motion blur) dùng blur của Canvas 2D
 * rồi trộn trên pixel.
 */

import type { Effect } from '@opencmo/clip-doc';

import type { Drawable } from './types.ts';

/** Effect xử lý ở đây (các effect cũ vẫn là filter/lớp phủ Canvas trong `draw.ts`). */
export const GRADE_TYPES = new Set([
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'saturation',
  'curves',
  'wheels',
  'hueCurves',
  'chromaKey',
  'sharpen',
  'clarity',
  'dehaze',
  'grain',
  'glow',
  'motionBlur',
  'lut',
]);
const COLOR_TYPES = new Set(['highlights', 'shadows', 'whites', 'blacks', 'saturation', 'curves', 'wheels', 'hueCurves', 'chromaKey', 'dehaze', 'lut']);

type Params = NonNullable<Effect['params']>;
/** Effect đã giải giá trị ở khung đang vẽ (keyframe của `value`). */
/** `lut`: bảng `.cube` đã đọc (nơi chạy nạp theo `params.src`); thiếu thì bước bị bỏ. */
export type GradeStep = { type: string; value: number; params: Params; cube?: CubeLut | null };

/** LUT 3D đọc từ `.cube`: `size³` bộ RGB 0…1, R chạy nhanh nhất (đúng thứ tự của định dạng). */
export type CubeLut = { size: number; data: Float32Array };

/**
 * Đọc `.cube` (Adobe/Resolve): `LUT_3D_SIZE`, tuỳ chọn `DOMAIN_MIN/MAX`, rồi `size³` dòng
 * "r g b". LUT 1D và file hỏng thì ném lỗi tiếng Anh (hiện thẳng trong app).
 */
export function parseCube(text: string): CubeLut {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.split(/\s+/);
    const keyword = head[0]!.toUpperCase();
    if (keyword === 'TITLE') continue;
    if (keyword === 'LUT_1D_SIZE') throw new Error('Only 3D LUTs are supported. Export a 3D .cube LUT.');
    if (keyword === 'LUT_3D_SIZE') {
      size = Number(head[1]);
      if (!Number.isInteger(size) || size < 2 || size > 65) throw new Error('This LUT size is not supported (2 to 65).');
      continue;
    }
    if (keyword === 'DOMAIN_MIN' || keyword === 'DOMAIN_MAX') {
      const triple = head.slice(1, 4).map(Number);
      if (triple.length !== 3 || triple.some((v) => !Number.isFinite(v))) throw new Error('This .cube file is damaged.');
      if (keyword === 'DOMAIN_MIN') min = triple;
      else max = triple;
      continue;
    }
    if (/^[A-Z_]+$/.test(keyword)) continue;
    const triple = head.map(Number);
    if (triple.length !== 3 || triple.some((v) => !Number.isFinite(v))) throw new Error('This .cube file is damaged.');
    values.push(...triple);
  }
  if (!size || values.length !== size * size * size * 3) throw new Error('This .cube file is damaged.');
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = clamp01((values[i]! - min[c]!) / Math.max(1e-6, max[c]! - min[c]!));
  }
  return { size, data };
}

/** Tra LUT ở (r, g, b) 0…1, nội suy ba chiều. */
function sampleCube({ size, data }: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = size - 1;
  const fr = clamp01(r) * n;
  const fg = clamp01(g) * n;
  const fb = clamp01(b) * n;
  const r0 = Math.min(n - 1, fr | 0);
  const g0 = Math.min(n - 1, fg | 0);
  const b0 = Math.min(n - 1, fb | 0);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const out: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const ir = corner & 1;
    const ig = (corner >> 1) & 1;
    const ib = (corner >> 2) & 1;
    const weight = (ir ? dr : 1 - dr) * (ig ? dg : 1 - dg) * (ib ? db : 1 - db);
    if (!weight) continue;
    const i = (((b0 + ib) * size + (g0 + ig)) * size + (r0 + ir)) * 3;
    out[0] += weight * data[i]!;
    out[1] += weight * data[i + 1]!;
    out[2] += weight * data[i + 2]!;
  }
  return out;
}

/** Canvas tạm — `OffscreenCanvas` ở trình duyệt, `createCanvas` của @napi-rs/canvas ở Node. */
export type PixelCanvas = Drawable & {
  getContext(kind: '2d'): PixelContext | null;
};
type PixelContext = {
  drawImage(image: never, dx: number, dy: number, dw?: number, dh?: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
  putImageData(data: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number): void;
  createImageData(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number };
  clearRect(x: number, y: number, w: number, h: number): void;
  filter: string;
  globalAlpha: number;
  globalCompositeOperation: string;
};
export type CanvasFactory = (width: number, height: number) => PixelCanvas;

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const clamp01 = (value: number) => clamp(value, 0, 1);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ------------------------------------------------------------------ đường cong

/** Bảng 256 mục từ các điểm [x, y] (nội suy cubic đơn điệu — không vọt quá điểm). */
export function curveTable(points: [number, number][] | undefined): Float32Array | null {
  if (!points || points.length < 2) return null;
  const pts = [...points].map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) slopes.push((ys[i + 1]! - ys[i]!) / Math.max(1e-6, xs[i + 1]! - xs[i]!));
  const tangents = new Array<number>(n);
  tangents[0] = slopes[0]!;
  tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i++) tangents[i] = slopes[i - 1]! * slopes[i]! <= 0 ? 0 : (slopes[i - 1]! + slopes[i]!) / 2;
  // Fritsch–Carlson: giữ đơn điệu.
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slopes[i]!;
    const b = tangents[i + 1]! / slopes[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangents[i] = t * a * slopes[i]!;
      tangents[i + 1] = t * b * slopes[i]!;
    }
  }
  const table = new Float32Array(256);
  let seg = 0;
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    if (x <= xs[0]!) {
      table[v] = ys[0]!;
      continue;
    }
    if (x >= xs[n - 1]!) {
      table[v] = ys[n - 1]!;
      continue;
    }
    while (seg < n - 2 && x > xs[seg + 1]!) seg++;
    const h = xs[seg + 1]! - xs[seg]!;
    const t = (x - xs[seg]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    table[v] = clamp01(
      (2 * t3 - 3 * t2 + 1) * ys[seg]! + (t3 - 2 * t2 + t) * h * tangents[seg]! + (-2 * t3 + 3 * t2) * ys[seg + 1]! + (t3 - t2) * h * tangents[seg + 1]!,
    );
  }
  return table;
}

const lookup = (table: Float32Array, value: number) => {
  const f = clamp01(value) * 255;
  const i = Math.min(254, f | 0);
  return table[i]! + (table[i + 1]! - table[i]!) * (f - i);
};

/** Đường tuần hoàn theo hue (0…1, nối vòng), nội suy tuyến tính; trả hàm hue → chỉnh. */
function hueCurve(points: [number, number][] | undefined): ((hue: number) => number) | null {
  if (!points?.length) return null;
  const pts = [...points].map(([x, y]) => [((x % 1) + 1) % 1, clamp(y, -1, 1)] as [number, number]).sort((a, b) => a[0] - b[0]);
  return (hue) => {
    if (pts.length === 1) return pts[0]![1];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const span = (b[0] - a[0] + 1) % 1 || 1;
      const offset = (hue - a[0] + 1) % 1;
      if (offset <= span) return a[1] + (b[1] - a[1]) * (offset / span);
    }
    return 0;
  };
}

function hexRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// ------------------------------------------------------------------ hàm màu

type ColorFn = (r: number, g: number, b: number) => [number, number, number, number];

/** Gộp các bước màu theo đúng thứ tự trong danh sách effect. */
export function colorFunction(steps: GradeStep[]): ColorFn | null {
  const ops: ((c: [number, number, number, number]) => void)[] = [];
  for (const step of steps) {
    const { type, value, params } = step;
    if (!COLOR_TYPES.has(type)) continue;
    switch (type) {
      case 'highlights':
      case 'shadows': {
        const amount = clamp(value, -1, 1);
        if (Math.abs(amount) < 1e-4) break;
        const high = type === 'highlights';
        ops.push((c) => {
          const y = luma(c[0], c[1], c[2]);
          // Chuông lệch về sáng/tối: đỉnh ~2/3 (highlights) hoặc ~1/3 (shadows).
          const weight = high ? 4 * y * y * (1 - y) : 4 * y * (1 - y) * (1 - y);
          retone(c, y, clamp01(y + 0.5 * amount * weight));
        });
        break;
      }
      case 'whites':
      case 'blacks': {
        const amount = clamp(value, -1, 1);
        if (Math.abs(amount) < 1e-4) break;
        const whites = type === 'whites';
        ops.push((c) => {
          const y = luma(c[0], c[1], c[2]);
          const weight = whites ? y ** 3 : (1 - y) ** 3;
          retone(c, y, clamp01(y + 0.25 * amount * weight));
        });
        break;
      }
      case 'saturation': {
        const factor = 1 + clamp(value, -1, 1);
        if (Math.abs(factor - 1) < 1e-4) break;
        ops.push((c) => saturate(c, factor));
        break;
      }
      case 'dehaze': {
        const amount = clamp(value, -1, 1);
        if (Math.abs(amount) < 1e-4) break;
        // Khử mù: kéo điểm đen xuống, tăng tương phản và màu nhẹ; âm = thêm mù.
        const black = 0.08 * amount;
        const contrast = 1 + 0.25 * amount;
        ops.push((c) => {
          for (let i = 0; i < 3; i++) c[i] = clamp01(((c[i]! - black) / (1 - black) - 0.5) * contrast + 0.5);
          saturate(c, 1 + 0.2 * amount);
        });
        break;
      }
      case 'wheels': {
        const strength = clamp01(value);
        const lift = (params.lift ?? [0, 0, 0]).map((v) => clamp(v, -1, 1) * strength * 0.25);
        const gamma = (params.gamma ?? [0, 0, 0]).map((v) => clamp(v, -1, 1) * strength);
        const gain = (params.gain ?? [0, 0, 0]).map((v) => clamp(v, -1, 1) * strength);
        if (![...lift, ...gamma, ...gain].some((v) => Math.abs(v) > 1e-4)) break;
        ops.push((c) => {
          for (let i = 0; i < 3; i++) {
            const lifted = c[i]! * (1 + gain[i]!) + lift[i]! * (1 - c[i]!);
            // gamma > 0 làm sáng trung tính (mũ < 1).
            c[i] = clamp01(Math.max(0, lifted) ** (1 / Math.max(0.2, 1 + gamma[i]!)));
          }
        });
        break;
      }
      case 'curves': {
        const strength = clamp01(value);
        const tables = [params.master, params.red, params.green, params.blue].map(curveTable);
        if (strength < 1e-4 || !tables.some(Boolean)) break;
        const [master, red, green, blue] = tables;
        ops.push((c) => {
          for (let i = 0; i < 3; i++) {
            let v = c[i]!;
            if (master) v = lookup(master, v);
            const channel = i === 0 ? red : i === 1 ? green : blue;
            if (channel) v = lookup(channel, v);
            c[i] = c[i]! + (v - c[i]!) * strength;
          }
        });
        break;
      }
      case 'hueCurves': {
        const strength = clamp01(value);
        const hue = hueCurve(params.hue);
        const sat = hueCurve(params.sat);
        const lum = hueCurve(params.lum);
        if (strength < 1e-4 || !(hue || sat || lum)) break;
        ops.push((c) => {
          const [h, s, l] = toHsl(c[0], c[1], c[2]);
          if (s < 1e-4) return;
          // Vùng ít màu bị chỉnh ít: hue curve không được nhuộm vùng xám.
          const weight = strength * Math.min(1, s * 4);
          const nh = hue ? h + 0.5 * hue(h) * weight : h;
          const ns = sat ? clamp01(s * (1 + sat(h) * weight)) : s;
          const nl = lum ? clamp01(l + 0.3 * lum(h) * weight * s) : l;
          const [r, g, b] = fromHsl(((nh % 1) + 1) % 1, ns, nl);
          c[0] = r;
          c[1] = g;
          c[2] = b;
        });
        break;
      }
      case 'lut': {
        const strength = clamp01(value);
        const cube = step.cube;
        if (!cube || strength < 1e-4) break;
        ops.push((c) => {
          const [r, g, b] = sampleCube(cube, c[0], c[1], c[2]);
          c[0] = c[0] + (r - c[0]) * strength;
          c[1] = c[1] + (g - c[1]) * strength;
          c[2] = c[2] + (b - c[2]) * strength;
        });
        break;
      }
      case 'chromaKey': {
        const range = clamp(value, 0, 1);
        const key = hexRgb(params.color ?? '#00ff00');
        const spill = clamp01(params.spill ?? 0.5);
        const [kcb, kcr] = chroma(key[0], key[1], key[2]);
        const inner = 0.04 + 0.3 * range;
        const outer = inner + 0.08;
        const dominant = key[1] >= key[0] && key[1] >= key[2] ? 1 : key[2] >= key[0] ? 2 : 0;
        ops.push((c) => {
          const [cb, cr] = chroma(c[0], c[1], c[2]);
          const distance = Math.hypot(cb - kcb, cr - kcr);
          const alpha = distance <= inner ? 0 : distance >= outer ? 1 : (distance - inner) / (outer - inner);
          c[3] *= alpha;
          // Khử viền màu: kênh chủ đạo của màu key không được cao hơn hai kênh kia.
          if (spill > 0) {
            const others = (c[(dominant + 1) % 3]! + c[(dominant + 2) % 3]!) / 2;
            if (c[dominant]! > others) c[dominant] = c[dominant]! - (c[dominant]! - others) * spill;
          }
        });
        break;
      }
    }
  }
  if (!ops.length) return null;
  return (r, g, b) => {
    const c: [number, number, number, number] = [r, g, b, 1];
    for (const op of ops) op(c);
    return c;
  };
}

/** Đổi độ sáng mà giữ màu: nhân RGB theo tỉ lệ luma mới / cũ (thêm trắng khi luma ~0). */
function retone(c: [number, number, number, number], from: number, to: number): void {
  if (from < 1e-4) {
    c[0] = c[1] = c[2] = to;
    return;
  }
  const k = to / from;
  for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]! * k);
}

function saturate(c: [number, number, number, number], factor: number): void {
  const y = luma(c[0], c[1], c[2]);
  for (let i = 0; i < 3; i++) c[i] = clamp01(y + (c[i]! - y) * factor);
}

const chroma = (r: number, g: number, b: number): [number, number] => [-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b];

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max - min < 1e-6) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = ((t % 1) + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

// ------------------------------------------------------------------ bảng 3D

const SIZE = 33;
const STRIDE_R = 4;
const STRIDE_G = SIZE * 4;
const STRIDE_B = SIZE * SIZE * 4;
const INDEX = new Int32Array(256);
const FRACTION = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const f = (v * (SIZE - 1)) / 255;
  const i = Math.min(SIZE - 2, f | 0);
  INDEX[v] = i;
  FRACTION[v] = f - i;
}

export type ColorTable = { lut: Float32Array; alpha: boolean };

/** Nướng hàm màu thành bảng 33³ RGBA (giá trị 0…255). */
export function bakeTable(fn: ColorFn): ColorTable {
  const lut = new Float32Array(SIZE * SIZE * SIZE * 4);
  let alpha = false;
  for (let b = 0; b < SIZE; b++) {
    for (let g = 0; g < SIZE; g++) {
      for (let r = 0; r < SIZE; r++) {
        const out = fn(r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1));
        const i = b * STRIDE_B + g * STRIDE_G + r * STRIDE_R;
        lut[i] = out[0] * 255;
        lut[i + 1] = out[1] * 255;
        lut[i + 2] = out[2] * 255;
        lut[i + 3] = out[3];
        if (out[3] < 0.999) alpha = true;
      }
    }
  }
  return { lut, alpha };
}

/** Áp bảng lên từng pixel (nội suy tetrahedral; alpha nhân vào alpha sẵn có). */
export function applyTable(data: Uint8ClampedArray, { lut, alpha }: ColorTable): void {
  for (let p = 0; p < data.length; p += 4) {
    const R = data[p]!;
    const G = data[p + 1]!;
    const B = data[p + 2]!;
    const fr = FRACTION[R]!;
    const fg = FRACTION[G]!;
    const fb = FRACTION[B]!;
    const base = INDEX[B]! * STRIDE_B + INDEX[G]! * STRIDE_G + INDEX[R]! * STRIDE_R;
    // Gán thẳng từng biến: destructuring mảng cấp phát một mảng mỗi pixel (chậm ~3×).
    let o1 = STRIDE_G;
    let o2 = STRIDE_R + STRIDE_G;
    let w0 = 1 - fg;
    let w1 = fg - fr;
    let w2 = fr - fb;
    let w3 = fb;
    if (fr > fg) {
      if (fg > fb) {
        o1 = STRIDE_R; o2 = STRIDE_R + STRIDE_G; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb;
      } else if (fr > fb) {
        o1 = STRIDE_R; o2 = STRIDE_R + STRIDE_B; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg;
      } else {
        o1 = STRIDE_B; o2 = STRIDE_R + STRIDE_B; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg;
      }
    } else if (fb > fg) {
      o1 = STRIDE_B; o2 = STRIDE_G + STRIDE_B; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr;
    } else if (fb > fr) {
      o1 = STRIDE_G; o2 = STRIDE_G + STRIDE_B; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr;
    }
    const c1 = base + o1;
    const c2 = base + o2;
    const c3 = base + STRIDE_R + STRIDE_G + STRIDE_B;
    data[p] = w0 * lut[base]! + w1 * lut[c1]! + w2 * lut[c2]! + w3 * lut[c3]!;
    data[p + 1] = w0 * lut[base + 1]! + w1 * lut[c1 + 1]! + w2 * lut[c2 + 1]! + w3 * lut[c3 + 1]!;
    data[p + 2] = w0 * lut[base + 2]! + w1 * lut[c1 + 2]! + w2 * lut[c2 + 2]! + w3 * lut[c3 + 2]!;
    if (alpha) data[p + 3] = data[p + 3]! * (w0 * lut[base + 3]! + w1 * lut[c1 + 3]! + w2 * lut[c2 + 3]! + w3 * lut[c3 + 3]!);
  }
}

const tables = new Map<string, ColorTable | null>();

/** Bảng màu của một bộ bước (cache theo nội dung — keyframe đổi giá trị thì nướng lại). */
export function colorTable(steps: GradeStep[]): ColorTable | null {
  const color = steps.filter((step) => COLOR_TYPES.has(step.type));
  if (!color.length) return null;
  // Bảng LUT lớn: khoá theo `params.src` (đã nằm trong params), không theo dữ liệu.
  const key = JSON.stringify(color, (name, value) => (name === 'cube' ? (value ? (value as CubeLut).size : null) : value));
  if (tables.has(key)) return tables.get(key)!;
  const fn = colorFunction(color);
  const table = fn ? bakeTable(fn) : null;
  if (tables.size > 64) tables.delete(tables.keys().next().value!);
  tables.set(key, table);
  return table;
}

// ------------------------------------------------------------------ không gian

/** Hạt nhiễu tất định theo (x, y, khung): cùng khung là cùng hạt, ở trình duyệt lẫn Node. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function blurred(factory: CanvasFactory, source: PixelCanvas, radius: number): Uint8ClampedArray {
  const { width, height } = source;
  const canvas = factory(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.filter = `blur(${radius.toFixed(2)}px)`;
  ctx.drawImage(source as never, 0, 0);
  ctx.filter = 'none';
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Vẽ `frame` đã chỉnh vào một canvas `width×height` mới. `seed` = chỉ số khung (grain).
 * Không có bước nào cần làm thì trả null (vẽ khung gốc như cũ).
 */
export function gradeFrame(frame: Drawable, steps: GradeStep[], width: number, height: number, factory: CanvasFactory, seed = 0): PixelCanvas | null {
  const active = steps.filter((step) => GRADE_TYPES.has(step.type));
  if (!active.length) return null;
  const canvas = factory(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(frame as never, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;

  const table = colorTable(active);
  if (table) applyTable(data, table);
  // Một ImageData xuyên suốt: chỉ đẩy lên canvas khi bước sau cần blur của canvas
  // (`dirty`) và một lần ở cuối — mỗi getImageData khung 1080p tốn ~35 ms trên Node.
  let dirty = true;
  const flush = () => {
    if (dirty) ctx.putImageData(image, 0, 0);
    dirty = false;
  };

  for (const { type, value, params } of active) {
    if (COLOR_TYPES.has(type)) continue;
    const amount = type === 'clarity' ? clamp(value, -1, 1) : clamp01(value);
    if (Math.abs(amount) < 1e-4) continue;
    if (type === 'sharpen' || type === 'clarity') {
      // Unsharp mask: sharpen bán kính nhỏ, clarity bán kính lớn và chỉ ở tông giữa.
      flush();
      const radius = type === 'sharpen' ? Math.max(0.8, width / 1200) : Math.max(4, width / 60);
      const soft = blurred(factory, canvas, radius);
      const strength = type === 'sharpen' ? 1.5 * amount : 0.8 * amount;
      const midtones = type === 'clarity';
      for (let p = 0; p < data.length; p += 4) {
        let k = strength;
        if (midtones) {
          const y = luma(data[p]!, data[p + 1]!, data[p + 2]!) / 255;
          k *= 4 * y * (1 - y);
        }
        data[p] = data[p]! + (data[p]! - soft[p]!) * k;
        data[p + 1] = data[p + 1]! + (data[p + 1]! - soft[p + 1]!) * k;
        data[p + 2] = data[p + 2]! + (data[p + 2]! - soft[p + 2]!) * k;
      }
      dirty = true;
    } else if (type === 'glow') {
      const threshold = clamp01(params.threshold ?? 0.7);
      const radius = Math.max(2, clamp01(params.radius ?? 0.3) * width * 0.08);
      const warmth = clamp01(params.warmth ?? 0.3);
      const bright = factory(width, height);
      const brightCtx = bright.getContext('2d')!;
      const mask = brightCtx.createImageData(width, height);
      for (let p = 0; p < data.length; p += 4) {
        const y = luma(data[p]!, data[p + 1]!, data[p + 2]!) / 255;
        const k = y <= threshold ? 0 : (y - threshold) / Math.max(1e-3, 1 - threshold);
        mask.data[p] = data[p]! * k * (1 + 0.15 * warmth);
        mask.data[p + 1] = data[p + 1]! * k;
        mask.data[p + 2] = data[p + 2]! * k * (1 - 0.3 * warmth);
        mask.data[p + 3] = 255;
      }
      brightCtx.putImageData(mask, 0, 0);
      const halo = blurred(factory, bright, radius);
      for (let p = 0; p < data.length; p += 4) {
        data[p] = 255 - ((255 - data[p]!) * (255 - halo[p]! * amount)) / 255;
        data[p + 1] = 255 - ((255 - data[p + 1]!) * (255 - halo[p + 1]! * amount)) / 255;
        data[p + 2] = 255 - ((255 - data[p + 2]!) * (255 - halo[p + 2]! * amount)) / 255;
      }
      dirty = true;
    } else if (type === 'grain') {
      const size = clamp(Math.round(params.size ?? 1), 1, 4);
      const strength = 60 * amount;
      for (let y = 0; y < height; y++) {
        const row = (y / size) | 0;
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 4;
          // Hạt rõ nhất ở tông giữa, như phim.
          const l = luma(data[p]!, data[p + 1]!, data[p + 2]!) / 255;
          const noise = (hash((x / size) | 0, row, seed) - 0.5) * strength * (0.4 + 2.4 * l * (1 - l));
          data[p] = data[p]! + noise;
          data[p + 1] = data[p + 1]! + noise;
          data[p + 2] = data[p + 2]! + noise;
        }
      }
      dirty = true;
    } else if (type === 'motionBlur') {
      // Cộng N bản dịch dọc theo góc, mỗi bản 1/N — vệt mờ chuyển động một hướng.
      const angle = ((params.angle ?? 0) * Math.PI) / 180;
      const distance = amount * width * 0.04;
      const copy = factory(width, height);
      copy.getContext('2d')!.putImageData(image, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const taps = 9;
      for (let i = 0; i < taps; i++) {
        const t = i / (taps - 1) - 0.5;
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(copy as never, Math.cos(angle) * distance * t, Math.sin(angle) * distance * t, width, height);
      }
      ctx.globalAlpha = 1;
      dirty = false;
      // Bước sau còn đọc pixel thì lấy lại; motion blur cuối cùng thì canvas đã là kết quả.
      if (active.slice(active.findIndex((step) => step.type === 'motionBlur') + 1).some((step) => !COLOR_TYPES.has(step.type))) {
        data.set(ctx.getImageData(0, 0, width, height).data);
      }
    }
  }
  flush();
  return canvas;
}

/** Effect chỉnh màu đang bật của một node, đã giải giá trị (`valueOf` đọc keyframe). */
export function gradeSteps(effects: Effect[] | undefined, valueOf: (effect: Effect) => number): GradeStep[] {
  return (effects ?? [])
    .filter((effect) => !effect.hidden && GRADE_TYPES.has(effect.type))
    .map((effect) => ({ type: effect.type, value: valueOf(effect), params: effect.params ?? {} }));
}

// ------------------------------------------------------------------ đo (scopes, inspect_color)

export type ScopeStats = {
  /** Luma p1 / p50 / p99, 0…1 — điểm đen, tông giữa, điểm trắng. */
  black: number;
  median: number;
  white: number;
  /** Tỉ lệ pixel cháy trắng (luma ≥ 0.98) / bệt đen (≤ 0.02). */
  clippedHighs: number;
  clippedShadows: number;
  /** Trung bình RGB 0…1: lệch nhau trên cảnh trung tính là ám màu. */
  average: [number, number, number];
  /** Độ bão hoà trung bình (max − min của RGB), 0…1. */
  saturation: number;
  /** Histogram luma 16 ô, tổng 1. */
  histogram: number[];
};

/**
 * Số liệu màu của một vùng pixel RGBA (bỏ pixel trong suốt). `step` lấy mẫu thưa
 * để khung lớn vẫn rẻ — số liệu thống kê không cần mọi pixel.
 */
export function scopeStats(data: Uint8ClampedArray, step = 1): ScopeStats {
  const bins = new Uint32Array(256);
  const histogram = new Array<number>(16).fill(0);
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let sat = 0;
  for (let p = 0; p < data.length; p += 4 * step) {
    if (data[p + 3]! < 8) continue;
    const R = data[p]!;
    const G = data[p + 1]!;
    const B = data[p + 2]!;
    const y = Math.round(luma(R, G, B));
    bins[y] = bins[y]! + 1;
    histogram[y >> 4] = histogram[y >> 4]! + 1;
    r += R;
    g += G;
    b += B;
    sat += Math.max(R, G, B) - Math.min(R, G, B);
    count++;
  }
  const round3 = (value: number) => Math.round(value * 1000) / 1000;
  if (!count) {
    return { black: 0, median: 0, white: 0, clippedHighs: 0, clippedShadows: 0, average: [0, 0, 0], saturation: 0, histogram };
  }
  const percentile = (q: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += bins[v]!;
      if (seen >= q * count) return v / 255;
    }
    return 1;
  };
  let highs = 0;
  let shadows = 0;
  for (let v = 0; v <= 5; v++) shadows += bins[v]!;
  for (let v = 250; v < 256; v++) highs += bins[v]!;
  return {
    black: round3(percentile(0.01)),
    median: round3(percentile(0.5)),
    white: round3(percentile(0.99)),
    clippedHighs: round3(highs / count),
    clippedShadows: round3(shadows / count),
    average: [round3(r / count / 255), round3(g / count / 255), round3(b / count / 255)],
    saturation: round3(sat / count / 255),
    histogram: histogram.map((value) => round3(value / count)),
  };
}
