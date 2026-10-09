/**
 * Màu CSS → số 0xRRGGBB. Alpha bị bỏ: document nói "alpha ignored, dùng
 * opacity", và DS vẽ đúng như vậy.
 */

import { colord, extend } from 'colord';
import namesPlugin from 'colord/plugins/names';

extend([namesPlugin]);

const cache = new Map<string, number>();

export function parseColor(input: string | number): number {
  if (typeof input === 'number') return input & 0xffffff;
  const hit = cache.get(input);
  if (hit !== undefined) return hit;
  let value = 0;
  const parsed = colord(input.trim());
  if (parsed.isValid()) {
    const { r, g, b } = parsed.toRgb();
    value = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  } else {
    // Chuỗi hex hỏng (thiếu ký tự): đệm cho đủ 6, như DS đọc.
    const hex = input.replace(/[^0-9a-f]/gi, '');
    const padded =
      hex.length === 1 ? hex.repeat(6)
      : hex.length === 2 ? hex.repeat(3)
      : hex.length === 3 ? [...hex].map((ch) => ch + ch).join('')
      : (hex + '000000').slice(0, 6);
    value = hex.length ? parseInt(padded, 16) : 0;
  }
  cache.set(input, value);
  return value;
}

export function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** Màu kèm độ mờ cho điểm dừng gradient; mờ hoàn toàn thì viết hex. */
export function css(color: number, opacity: number): string {
  if (opacity >= 1) return hex(color);
  const clamped = Math.min(1, Math.max(0, opacity));
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${clamped})`;
}

/** Nội suy theo từng kênh — nội suy trên số gộp làm lem kênh sang nhau. */
export function mixColor(from: number, to: number, t: number): number {
  const channel = (shift: number) =>
    Math.round(((from >> shift) & 255) + (((to >> shift) & 255) - ((from >> shift) & 255)) * t);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
