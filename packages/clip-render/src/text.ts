/**
 * Chữ: dàn dòng rồi vẽ, theo đúng cách người dùng đang thấy trong fork.
 *
 * ## Dàn dòng
 *
 * - Chữ chia thành ĐOẠN tại mọi mép của `<textRange>`. Mỗi đoạn lấy kiểu của
 *   `<text>`, và range nào phủ đoạn đó thì ghi đè lên, range viết sau thắng.
 * - Mỗi đoạn tách thành TỪ, dấu cách dính vào cuối từ đứng trước. Đo từng từ
 *   bằng chính canvas. Từ nào tràn `width` đã viết thì xuống dòng, trừ từ đầu
 *   dòng. `\n` luôn xuống dòng.
 * - Cao một dòng = cao hộp font (ascent + descent của font, không phải của
 *   glyph) lớn nhất trong dòng. Các dòng cách nhau `cao · leading`, riêng dòng
 *   cuối không nhân.
 * - **Chỉ khi có CẢ `width` lẫn `height` thì hộp mới cố định.** Thiếu một trong
 *   hai là hộp co theo chữ, nên `textAlign`/`textBaseline` không còn gì để căn
 *   (checklist §4).
 * - Toạ độ vẽ mỗi từ bị CẮT về số nguyên.
 *
 * ## Vẽ
 *
 * Ba lượt trên toàn bộ từ: bóng, rồi viền, rồi màu. Bóng của chữ có viền lấy
 * hình của viền dày nhất. Paint ảnh/video trên chữ không vẽ ảnh mà tô đen —
 * fork làm vậy, và ảnh vàng `text-paint` giữ đúng điều đó.
 */

import type { Paint, Shadow, Stroke, TextNode, TextRange } from '@opencmo/clip-doc';

import { hex, parseColor } from './color.ts';
import { FONTS } from './fonts.ts';
import type { RNode } from './tree.ts';
import type { Ctx2D } from './types.ts';

/** Những gì dàn dòng cần từ canvas: đặt font và đo. */
export type Measurer = Pick<Ctx2D, 'save' | 'restore'> & {
  font: string;
  textBaseline: string;
  letterSpacing: string;
  measureText(text: string): TextMetricsLike;
};

export type TextMetricsLike = {
  width: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
};

type Style = {
  size: number;
  family: string;
  weight: string;
  style: string;
  spacing: number;
  textCase: string;
  /** Range phủ đoạn này, theo thứ tự viết — để tìm màu/paint/viền/bóng ghi đè. */
  ranges: TextRange[];
};

export type Word = {
  chars: string;
  style: Style;
  width: number;
  height: number;
  ascent: number;
  /** Chỉ ở Node: dời thêm khi vẽ theo baseline chữ (0 trong trình duyệt). */
  drop: number;
  x: number;
  y: number;
};

/** `bounds`: hộp chữ THẬT trong khung của node `[x, y, w, h]` — chữ có thể tràn hộp cố định (phụ đề). */
export type TextLayout = { words: Word[]; width: number; height: number; bounds: [number, number, number, number] };

const WEIGHTS: Record<string, string> = { normal: '400', bold: '700' };

function styleFor(node: TextNode, ranges: TextRange[]): Style {
  let size = node.fontSize ?? 16;
  let family = node.fontFamily || 'Inter';
  let weight = node.fontWeight ?? '400';
  let style = node.fontStyle ?? 'normal';
  let spacing = node.letterSpacing ?? 0;
  let textCase = node.textCase ?? 'original';
  for (const range of ranges) {
    size = range.fontSize ?? size;
    family = range.fontFamily ?? family;
    weight = range.fontWeight ?? weight;
    style = range.fontStyle ?? style;
    spacing = range.letterSpacing ?? spacing;
    textCase = range.textCase ?? textCase;
  }
  return { size, family, weight: WEIGHTS[String(weight)] ?? String(weight), style, spacing, textCase, ranges };
}

/**
 * Đặt font lên context. Chromium tự chọn trục `wght`/`opsz` của font variable
 * theo độ đậm và cỡ chữ (optical sizing: opsz = cỡ px). Skia của Node thì
 * không, nên nơi nào có `fontVariationSettings` thì đặt tay cho giống.
 */
export function applyFont(ctx: Measurer, style: Style, baseline: string): void {
  ctx.font = `${style.style} ${style.weight} ${style.size}px ${style.family}`;
  ctx.letterSpacing = `${style.spacing}px`;
  if (isChromium(ctx)) {
    ctx.textBaseline = baseline;
  } else {
    // Skia của Node: đặt trục font variable bằng tay, và vẽ theo baseline chữ
    // (xem `drop`), vì `top/middle/bottom` của nó không trùng Chromium.
    ctx.textBaseline = 'alphabetic';
    const opsz = Math.min(32, Math.max(14, style.size));
    (ctx as unknown as { fontVariationSettings: string }).fontVariationSettings = `"wght" ${style.weight}, "opsz" ${opsz}`;
  }
}

/** Canvas của trình duyệt không có `fontVariationSettings`; của `@napi-rs/canvas` thì có. */
const isChromium = (ctx: object) => !('fontVariationSettings' in ctx);

/**
 * Khoảng từ điểm neo theo `baseline` xuống baseline chữ, như Chromium tính:
 * hộp em cao đúng một cỡ chữ, đỉnh của nó ở `emTop · cỡ` trên baseline chữ.
 */
function drop(style: Style, baseline: string, metrics: TextMetricsLike): number {
  if (baseline === 'alphabetic') return 0;
  const known = (FONTS as Record<string, { emTop: number }>)[style.family]?.emTop;
  const emTop = known ?? metrics.fontBoundingBoxAscent / (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
  const offset = baseline === 'middle' ? emTop - 0.5 : baseline === 'bottom' ? emTop - 1 : emTop;
  return offset * style.size;
}

/**
 * Số đo một từ theo nghĩa của Chromium. Ở Node: đo theo baseline chữ, rồi làm
 * tròn ascent/descent riêng từng cái như Chromium làm khi báo hộp font.
 */
function measure(ctx: Measurer, text: string, style: Style, baseline: string) {
  const metrics = ctx.measureText(text);
  if (isChromium(ctx)) {
    return {
      width: metrics.width,
      height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
      ascent: metrics.fontBoundingBoxAscent,
      drop: 0,
    };
  }
  const ascent = Math.round(metrics.fontBoundingBoxAscent);
  // Ascent của font × cỡ rơi đúng nửa pixel (Inter 48/80/112 px…): hai bên làm tròn
  // mặt nạ glyph về hai phía, chữ của Node thấp hơn 1 px. Đo trên 10 font × 60 cỡ,
  // luật này đúng 600/600.
  const tie = Math.abs((metrics.fontBoundingBoxAscent % 1) - 0.5) < 1e-6 ? -1 : 0;
  return {
    width: metrics.width,
    height: ascent + Math.round(metrics.fontBoundingBoxDescent),
    ascent,
    drop: drop(style, baseline, metrics) + tie,
  };
}

const casing = (text: string, textCase: string) =>
  textCase === 'upper' ? text.toUpperCase() : textCase === 'lower' ? text.toLocaleLowerCase() : text;

/** Tách giữ dấu cách ở cuối mỗi từ: "a b c" → ["a ", "b ", "c"]. */
function splitWords(text: string): string[] {
  if (!text.includes(' ')) return [text];
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === ' ') {
      out.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Đoạn chữ theo mép của các range, mỗi đoạn kèm range đang phủ nó. */
function segments(text: string, ranges: TextRange[]): { text: string; ranges: TextRange[] }[] {
  if (!ranges.length) return [{ text, ranges: [] }];
  if (!text.length) return [];
  const clampIndex = (value: number) => Math.min(text.length, Math.max(0, value));
  const span = (range: TextRange) => [clampIndex(range.start), clampIndex(range.end ?? text.length)] as const;
  const cuts = [...new Set([0, text.length, ...ranges.flatMap((range) => span(range))])].sort((a, b) => a - b);
  const out: { text: string; ranges: TextRange[] }[] = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const from = cuts[index]!;
    const to = cuts[index + 1]!;
    if (from >= to) continue;
    const covering = ranges.filter((range) => {
      const [start, end] = span(range);
      return start <= from && end > from;
    });
    out.push({ text: text.slice(from, to), ranges: covering });
  }
  return out;
}

/**
 * Dàn dòng. `values.width/height` của node được thay bằng hộp chữ khi node
 * không có đủ cả hai.
 */
export function layoutText(measurer: Measurer, r: RNode, chars: string, node: TextNode): TextLayout {
  const baseline = node.textBaseline ?? 'top';
  const maxWidth = typeof node.width === 'number' ? node.width : Infinity;
  const lines: Word[][] = [[]];
  let offset = 0;
  measurer.save();
  for (const segment of segments(chars, node.ranges ?? [])) {
    const style = styleFor(node, segment.ranges);
    applyFont(measurer, style, baseline);
    for (const word of splitWords(segment.text)) {
      const parts = word.split('\n');
      parts.forEach((part, index) => {
        const text = casing(part, style.textCase);
        const metrics = measure(measurer, text, style, baseline);
        if (offset + metrics.width > maxWidth && offset > 0) {
          lines.push([]);
          offset = 0;
        }
        lines[lines.length - 1]!.push({ chars: text, style, ...metrics, x: offset, y: 0 });
        offset += metrics.width;
        if (index < parts.length - 1) {
          lines.push([]);
          offset = 0;
        }
      });
    }
  }
  measurer.restore();

  const leading = node.leading ?? 1;
  const widths = lines.map((line) => line.reduce((sum, word) => sum + word.width, 0));
  const heights = lines.map((line) => Math.max(...line.map((word) => word.height)));
  const total = heights.reduce((sum, height, index) => sum + height * (index < heights.length - 1 ? leading : 1), 0);
  const v = r.values;
  if (!v.width || !v.height) {
    v.width = Math.ceil(Math.max(...widths));
    v.height = Math.ceil(total);
  }
  const align = node.textAlign ?? 'left';
  let top = baseline === 'middle' ? (v.height - total) / 2 : baseline === 'bottom' ? v.height - total : 0;
  const lefts = widths.map((width) => (align === 'center' ? (v.width - width) / 2 : align === 'right' ? v.width - width : 0));
  const minX = Math.min(...lefts);
  const bounds: [number, number, number, number] = [minX, top, Math.max(...lefts.map((left, index) => left + widths[index]!)) - minX, total];
  lines.forEach((line, index) => {
    const height = heights[index]!;
    const left = lefts[index]!;
    const drop =
      baseline === 'middle' ? height / 2
      : baseline === 'bottom' ? height
      : baseline === 'alphabetic' ? Math.max(...line.map((word) => word.ascent)) || height * 0.75
      : 0;
    for (const word of line) {
      word.x = (word.x + left) | 0;
      word.y = (top + drop) | 0;
    }
    top += height * leading;
  });
  return { words: lines.flat(), width: v.width, height: v.height, bounds };
}

// ------------------------------------------------------------------ vẽ

type Lookup = (holder: object, key: string, fallback: number) => number;

/** Thứ range ghi đè lên chữ: range cuối có danh sách không rỗng thắng. */
function override<T>(node: TextNode, ranges: TextRange[], key: 'paints' | 'strokes' | 'shadows'): T[] {
  let list = ((node as Record<string, unknown>)[key] as T[] | undefined) ?? [];
  for (const range of ranges) {
    const own = (range as Record<string, unknown>)[key] as T[] | undefined;
    if (own?.length) list = own;
  }
  return list;
}

/** Giá trị đã viết của thành phần phụ — fork đọc bóng/viền/paint của chữ từ đây, không theo keyframe. */
const own = (holder: object, key: string, fallback: number): number => {
  const value = (holder as Record<string, unknown>)[key];
  if (key === 'color' && typeof value === 'string') return parseColor(value);
  return typeof value === 'number' ? value : fallback;
};

export function drawText(
  ctx: Ctx2D & Measurer & { fillText(t: string, x: number, y: number): void; strokeText(t: string, x: number, y: number): void },
  r: RNode,
  layout: TextLayout,
  node: TextNode,
  live: Lookup,
  gradient: (paint: Extract<Paint, { stops: unknown }>) => unknown,
  shadowScale: number,
): void {
  const baseline = node.textBaseline ?? 'top';
  const saved = ctx.globalAlpha;

  // Dòng thật của chữ (bỏ từ toàn khoảng trắng): dùng cho hộp nền và gạch dưới/trên/ngang.
  const lineBoxes = new Map<number, { x0: number; x1: number; top: number; height: number; ascent: number; size: number }>();
  for (const word of layout.words) {
    if (!word.chars.trim()) continue;
    const top = word.y - (baseline === 'middle' ? word.height / 2 : baseline === 'bottom' ? word.height : baseline === 'alphabetic' ? word.ascent : 0);
    const line = lineBoxes.get(word.y);
    if (line) (line.x0 = Math.min(line.x0, word.x)), (line.x1 = Math.max(line.x1, word.x + word.width));
    else lineBoxes.set(word.y, { x0: word.x, x1: word.x + word.width, top, height: word.height, ascent: word.ascent, size: word.style.size });
  }

  // Lượt 0a: hộp nền (E4, học Palmier TextStyle.Background) — cả khối hoặc từng dòng.
  const background = (node as { background?: { color: string; paddingX?: number; paddingY?: number; radius?: number; outlineColor?: string; outlineWidth?: number; perLine?: boolean } }).background;
  if (background && lineBoxes.size) {
    const lines = [...lineBoxes.values()];
    const boxes = background.perLine
      ? lines
      : [{ x0: Math.min(...lines.map((l) => l.x0)), x1: Math.max(...lines.map((l) => l.x1)), top: Math.min(...lines.map((l) => l.top)), height: Math.max(...lines.map((l) => l.top + l.height)) - Math.min(...lines.map((l) => l.top)) }];
    const padX = background.paddingX ?? lines[0]!.height * 0.3;
    const padY = background.paddingY ?? lines[0]!.height * 0.12;
    ctx.save();
    for (const box of boxes) {
      ctx.beginPath();
      ctx.roundRect(box.x0 - padX, box.top - padY, box.x1 - box.x0 + padX * 2, box.height + padY * 2, background.radius ?? 0);
      ctx.fillStyle = background.color;
      ctx.fill();
      if (background.outlineWidth && background.outlineColor) {
        ctx.lineWidth = background.outlineWidth;
        ctx.strokeStyle = background.outlineColor;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Lượt 0: hộp nhấn sau từ đang nói (phụ đề `highlight: 'block'`), mỗi dòng một hộp.
  const block = r.caption?.block;
  if (block) {
    const lines = new Map<number, { x0: number; x1: number; top: number; height: number }>();
    for (const word of layout.words) {
      if (!word.style.ranges.includes(block.range) || !word.chars.trim()) continue;
      // `y` là điểm neo theo baseline của dòng (cùng luật dàn dòng ở trên) — lùi về đỉnh dòng.
      const top =
        word.y - (baseline === 'middle' ? word.height / 2 : baseline === 'bottom' ? word.height : baseline === 'alphabetic' ? word.ascent : 0);
      const line = lines.get(word.y);
      if (line) (line.x0 = Math.min(line.x0, word.x)), (line.x1 = Math.max(line.x1, word.x + word.width));
      else lines.set(word.y, { x0: word.x, x1: word.x + word.width, top, height: word.height });
    }
    ctx.save();
    ctx.fillStyle = block.color;
    for (const line of lines.values()) {
      const pad = line.height * 0.12;
      ctx.beginPath();
      ctx.roundRect(line.x0 - pad * 1.4, line.top - pad * 0.4, line.x1 - line.x0 + pad * 2.8, line.height + pad * 0.8, line.height * 0.22);
      ctx.fill();
    }
    ctx.restore();
  }

  // Animation theo từ (E4): mỗi từ có thể dời, phóng quanh tâm, mờ, đổi màu — áp ở mọi lượt vẽ.
  const tweakOf = wordTweaks(r, layout);
  const enter = (word: Word): { alpha: number; color?: string } | null => {
    const tweak = tweakOf(word);
    if (!tweak) return null;
    const top = word.y - (baseline === 'middle' ? word.height / 2 : baseline === 'bottom' ? word.height : baseline === 'alphabetic' ? word.ascent : 0);
    const cx = word.x + word.width / 2;
    const cy = top + word.height / 2;
    ctx.save();
    ctx.translate(cx + tweak.dx, cy + tweak.dy);
    ctx.scale(tweak.scale, tweak.scale);
    ctx.translate(-cx, -cy);
    return tweak;
  };

  // Lượt 1: bóng.
  ctx.save();
  for (const word of layout.words) {
    const tweak = enter(word);
    const fade = tweak?.alpha ?? 1;
    if (fade <= 0) {
      if (tweak) ctx.restore();
      continue;
    }
    applyFont(ctx, word.style, baseline);
    const shadows = override<Shadow>(node, word.style.ranges, 'shadows');
    const strokes = override<Stroke>(node, word.style.ranges, 'strokes').filter((stroke) => !stroke.hidden);
    const widest = strokes.reduce<Stroke | null>(
      (best, stroke) => (best === null || live(stroke, 'width', 1) > live(best, 'width', 1) ? stroke : best),
      null,
    );
    if (widest) strokeStyle(ctx, widest, live);
    for (const shadow of shadows) {
      if (shadow.hidden) continue;
      ctx.shadowOffsetX = own(shadow, 'offsetX', 0) * shadowScale;
      ctx.shadowOffsetY = own(shadow, 'offsetY', 0) * shadowScale;
      ctx.shadowBlur = own(shadow, 'blur', 0) * shadowScale;
      const color = hex(own(shadow, 'color', 0));
      ctx.shadowColor = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = saved * fade * own(shadow, 'opacity', 1);
      if (widest) ctx.strokeText(word.chars, word.x, Math.round(word.y + word.drop));
      else ctx.fillText(word.chars, word.x, Math.round(word.y + word.drop));
    }
    if (shadows.length) {
      ctx.globalAlpha = saved;
      ctx.shadowColor = 'transparent';
    }
    if (tweak) ctx.restore();
  }
  ctx.restore();

  // Lượt 2: viền.
  ctx.save();
  for (const word of layout.words) {
    const strokes = override<Stroke>(node, word.style.ranges, 'strokes');
    if (!strokes.length) continue;
    const tweak = enter(word);
    const fade = tweak?.alpha ?? 1;
    applyFont(ctx, word.style, baseline);
    for (const stroke of strokes) {
      if (stroke.hidden || fade <= 0) continue;
      const composite = ctx.globalCompositeOperation;
      if (stroke.blendMode && stroke.blendMode !== 'sourceOver') ctx.globalCompositeOperation = dash(stroke.blendMode);
      ctx.globalAlpha = saved * fade * own(stroke, 'opacity', 1);
      strokeStyle(ctx, stroke, live);
      ctx.strokeStyle = hex(own(stroke, 'color', 0));
      ctx.strokeText(word.chars, word.x, Math.round(word.y + word.drop));
      ctx.globalCompositeOperation = composite;
    }
    if (tweak) ctx.restore();
  }
  ctx.restore();

  // Lượt 3: màu chữ, rồi paint.
  ctx.save();
  for (const word of layout.words) {
    let color: number | null = r.values.color;
    for (const range of word.style.ranges) {
      if (typeof range.color === 'string') color = live(range, 'color', parseColor(range.color));
    }
    let paints = override<Paint>(node, word.style.ranges, 'paints');
    const tweak = enter(word);
    const fade = tweak?.alpha ?? 1;
    // highlightPop: từ đang tới đổi hẳn sang màu nhấn (paint của node không đè lên).
    if (tweak?.color) {
      color = parseColor(tweak.color);
      paints = [];
    }
    if (fade <= 0 || (!paints.length && color === null)) {
      if (tweak) ctx.restore();
      continue;
    }
    applyFont(ctx, word.style, baseline);
    if (color !== null) {
      ctx.globalAlpha = saved * fade;
      ctx.fillStyle = hex(color);
      ctx.fillText(word.chars, word.x, Math.round(word.y + word.drop));
    }
    for (const paint of paints) {
      if (paint.hidden) continue;
      const composite = ctx.globalCompositeOperation;
      if (paint.blendMode && paint.blendMode !== 'sourceOver') ctx.globalCompositeOperation = dash(paint.blendMode);
      ctx.globalAlpha = saved * fade * own(paint, 'opacity', 1);
      ctx.fillStyle = 'stops' in paint ? gradient(paint) : hex(paint.type === 'solid' ? own(paint, 'color', 0) : 0);
      ctx.fillText(word.chars, word.x, Math.round(word.y + word.drop));
      ctx.globalCompositeOperation = composite;
    }
    if (tweak) ctx.restore();
  }
  ctx.restore();

  // Lượt 4: gạch dưới / trên / ngang theo bề rộng từng dòng, màu chữ.
  const decoration = (node as { decoration?: string[] }).decoration;
  if (decoration?.length && r.values.color !== null) {
    ctx.save();
    ctx.globalAlpha = saved;
    ctx.fillStyle = hex(r.values.color);
    for (const line of lineBoxes.values()) {
      const thickness = Math.max(1, line.size * 0.06);
      for (const kind of decoration) {
        const y = kind === 'underline' ? line.top + line.ascent + thickness * 1.5 : kind === 'overline' ? line.top + thickness * 0.5 : line.top + line.ascent * 0.62;
        ctx.fillRect(line.x0, y - thickness / 2, line.x1 - line.x0, thickness);
      }
    }
    ctx.restore();
  }
}

type Tweak = { dx: number; dy: number; scale: number; alpha: number; color?: string };

/**
 * Biến đổi của từng từ ở khung này (E4, học Palmier TextAnimation theo từ):
 * - wordSlide: từ thứ i bắt đầu sau i × per khung, trượt lên từ dưới 0.6 chiều cao chữ và hiện dần;
 * - highlightPop: từ đang tới (t / per) phóng 1.15 quanh tâm, đổi màu nhấn;
 * - phụ đề `highlight: 'pop'`: từ đang nói phóng theo `caption.pop.scale`.
 * Từ khoảng trắng không đếm.
 */
function wordTweaks(r: RNode, layout: TextLayout): (word: Word) => Tweak | null {
  const fx = r.wordFx;
  const pop = r.caption?.pop;
  if (!fx && !pop) return () => null;
  const index = new Map<Word, number>();
  let count = 0;
  for (const word of layout.words) if (word.chars.trim()) index.set(word, count++);
  return (word) => {
    if (pop) return word.style.ranges.includes(pop.range) ? { dx: 0, dy: 0, scale: pop.scale, alpha: 1 } : null;
    const i = index.get(word);
    if (!fx || i === undefined) return null;
    if (fx.type === 'wordSlide') {
      const length = Math.max(fx.per * 2, 8);
      const p = Math.min(1, Math.max(0, (fx.t - i * fx.per) / length));
      const e = 1 - (1 - p) ** 3;
      return fx.out ? { dx: 0, dy: -e * word.height * 0.6, scale: 1, alpha: 1 - e } : { dx: 0, dy: (1 - e) * word.height * 0.6, scale: 1, alpha: e };
    }
    if (fx.out) return null;
    const active = Math.floor(fx.t / fx.per);
    if (fx.t < 0 || active !== i || active >= count) return null;
    const p = Math.min(1, (fx.t - i * fx.per) / Math.min(fx.per, 5));
    return { dx: 0, dy: 0, scale: 1 + 0.15 * p, alpha: 1, color: fx.color };
  };
}

function strokeStyle(ctx: Ctx2D, stroke: Stroke, live: Lookup): void {
  ctx.lineWidth = live(stroke, 'width', 1);
  ctx.lineJoin = stroke.join ?? 'miter';
  ctx.lineCap = stroke.cap ?? 'butt';
  ctx.miterLimit = stroke.miterLimit ?? 10;
}

const dash = (mode: string) => mode.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

// ------------------------------------------------------------------ animation chữ

/** Hiện dần theo từ: `ratio` 0 → rỗng, 1 → đủ. Khoảng trắng sau từ cuối chưa hiện. */
export function revealWords(text: string, ratio: number): string {
  if (ratio >= 1) return text;
  if (ratio <= 0) return '';
  const pieces = text.split(/(\s+)/);
  const words = Math.ceil(pieces.length / 2);
  const shown = Math.floor(ratio * words);
  if (shown <= 0) return '';
  // Từ thứ k nằm ở vị trí 2k; lấy tới hết từ thứ `shown`, bỏ khoảng trắng theo sau.
  return pieces.slice(0, shown * 2 - 1).join('');
}

export function revealChars(text: string, ratio: number): string {
  if (ratio >= 1) return text;
  if (ratio <= 0) return '';
  return text.slice(0, Math.floor(ratio * text.length));
}

const SCRAMBLE_SET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!%#_';
/** Mỗi ký tự "chạy" trong 30% thời lượng; chữ đổi 30 lần trong cả animation. */
const ACTIVE = 0.3;
const REFRESHES = 30;

/**
 * Ký tự ngẫu nhiên ổn định dần từ trái sang. Nhịp giống fork: ký tự thứ c ổn
 * định ở `ceil((c · (1 − 0.3) / n + 0.3) · 30) / 30`, dấu cách giữ nguyên.
 * Còn ký tự ngẫu nhiên thì khác: thuật toán băm của fork không phải thứ chép
 * được (clean-room), và cũng không ai dựa vào nó. Ảnh vàng chỉ so lúc đã ổn định.
 */
export function scramble(text: string, ratio: number): string {
  if (!text.length) return '';
  if (ratio >= 1) return text;
  const step = Math.floor(ratio * REFRESHES);
  let seed = 0;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const settle = Math.ceil(((index * (1 - ACTIVE)) / text.length + ACTIVE) * REFRESHES) / REFRESHES;
    if (ratio >= settle || text[index] === ' ') {
      out += text[index];
      continue;
    }
    // Xáo có hạt giống: cùng chữ, cùng vị trí, cùng nhịp → cùng ký tự (tua lại vẫn y hệt).
    let h = (seed + index * 7919 + step * 104729) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    out += SCRAMBLE_SET[((h ^ (h >>> 16)) >>> 0) % SCRAMBLE_SET.length];
  }
  return out;
}

