/**
 * Hợp đồng giữa renderer và nơi chạy nó (trình duyệt hoặc Node).
 *
 * Renderer không tự tải media: vẽ một khung phải đồng bộ và tất định, còn tải
 * file thì không. Nơi chạy đọc `mediaNeeds()` để nạp trước đúng các ảnh/khung
 * video mà khung sắp vẽ cần, rồi trả chúng qua `MediaHost`.
 */

import type { AssetInput } from '@opencmo/clip-doc';

import type { Transcript } from './captions.ts';
import type { CubeLut } from './grade.ts';

/** Thứ `drawImage` nhận: ImageBitmap, canvas, Image của @napi-rs/canvas… */
export type Drawable = { width: number; height: number };

/**
 * Tập con của Canvas 2D mà renderer dùng. `CanvasRenderingContext2D`,
 * `OffscreenCanvasRenderingContext2D` và context của `@napi-rs/canvas` đều khớp.
 */
export interface Ctx2D {
  canvas: { width: number; height: number };
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
  setLineDash(segments: number[]): void;
  lineDashOffset: number;
  fill(fillRule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  clip(): void;
  drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  miterLimit: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

export interface Gradient {
  addColorStop(offset: number, color: string): void;
}

/** Trạng thái một nguồn: chưa có (vẽ trống), hỏng (vẽ màu báo lỗi), hoặc có. */
export type MediaResult = Drawable | 'failed' | null;

export interface MediaHost {
  /** Ảnh tĩnh đã giải mã, nguyên cỡ. */
  image(src: AssetInput): MediaResult;
  /**
   * Khung video ở `seconds` giây của NGUỒN. Nơi chạy chọn khung đầu tiên có chỉ
   * số ≥ `round(seconds · fps nguồn)` — cùng luật với DS.
   */
  video(src: AssetInput, seconds: number): MediaResult;
  /** Độ dài nguồn video/âm thanh, giây; null khi chưa biết. */
  duration(src: AssetInput): number | null;
  /** Transcript của `<captions src>` đã đọc sẵn; null khi chưa có (phụ đề trống). */
  transcript?(src: string): Transcript | null;
  /**
   * Khung của animation Lottie ở `seconds` giây của animation, vẽ ở `width×height`
   * PIXEL (đã tính độ phóng) để không nhoè. `loop` = lặp khi quá độ dài. Nơi chạy
   * giữ engine (Skottie) — renderer chỉ `drawImage` như khung video.
   */
  lottie?(src: AssetInput, seconds: number, width: number, height: number, loop: boolean): MediaResult;
  /**
   * Canvas tạm `width×height` cho chỉnh màu trên pixel (E3, `grade.ts`). Không có thì
   * renderer dùng `OffscreenCanvas` toàn cục (trình duyệt); Node phải cấp `createCanvas`.
   */
  canvas?(width: number, height: number): unknown;
  /** LUT `.cube` của thư viện đã đọc (`parseCube`); null khi đang nạp, 'failed' khi hỏng. */
  lut?(src: string): CubeLut | null | 'failed';
}

export type MediaNeed =
  | { kind: 'image'; src: AssetInput }
  | { kind: 'video'; src: AssetInput; seconds: number }
  | { kind: 'lottie'; src: AssetInput; seconds: number }
  | { kind: 'lut'; src: string };
