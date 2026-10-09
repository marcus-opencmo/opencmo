/**
 * Vẽ một khung lên Canvas 2D.
 *
 * ## Vì sao không cô lập lớp
 *
 * Độ mờ, blend và filter của một node KHÔNG vẽ vào lớp riêng rồi mới ghép: chúng
 * đổi trạng thái context và mọi lệnh vẽ bên trong (kể cả của con) chịu nó từng
 * lệnh một. Opacity nhân dồn qua các cấp, một filter blur trên group làm mờ TỪNG
 * con riêng lẻ. Đó là cái người dùng đang thấy trong fork, và ảnh vàng đo đúng
 * nó — cô lập lớp sẽ "đúng hơn" về lý thuyết nhưng khác khung hình.
 *
 * Thứ tự trên một hình: path hộp → bóng (fill có shadow) → màu `fill` → media của
 * chính node → paint con → viền. Rồi mới tới con; scene cắt con theo khung.
 */

import { parsePath, pathLength, transformPath, trimPath, type AssetInput, type ClipNode, type Effect, type Paint, type PathNode, type PathSegment, type Shadow, type Stroke, type TextNode } from '@opencmo/clip-doc';

import { css, hex } from './color.ts';
import { hasTransition, partnerOf, subValue, transitionWindow } from './frame.ts';
import { gradeFrame, gradeSteps, type CanvasFactory, type CubeLut, type PixelCanvas } from './grade.ts';
import { drawText } from './text.ts';
import { drawScene3D } from './three/render.ts';
import { toFrames, type Mat, type RNode } from './tree.ts';
import type { Ctx2D, Drawable, MediaHost, MediaNeed } from './types.ts';

const MISSING = '#5C2828';
const EPSILON = 1e-4;

type Scope = { ctx: Ctx2D; media: MediaHost; view: Mat; shadowScale: number };

export function drawTree(scope: Scope, root: RNode): void {
  const { ctx } = scope;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(...scope.view);
  drawNode(scope, root);
}

function drawNode(scope: Scope, r: RNode): void {
  if (!r.visible) return;
  const node = r.node as ClipNode & { hidden?: boolean; blendMode?: string };
  if (node.hidden) return;
  const { ctx } = scope;

  ctx.save();
  ctx.transform(...r.localMatrix);

  for (const mask of r.masks) {
    if (!mask.visible) continue;
    ctx.save();
    ctx.setTransform(...mask.worldMatrix);
    rectPath(ctx, mask);
    ctx.restore();
    ctx.clip();
  }

  ctx.globalAlpha *= r.values.opacity;
  if (node.blendMode && node.blendMode !== 'sourceOver') ctx.globalCompositeOperation = composite(node.blendMode);
  const filter = effectFilter(r);
  let previousFilter: string | null = null;
  if (filter) {
    previousFilter = ctx.filter;
    ctx.filter = filter;
  }

  switch (node.kind) {
    case 'scene':
    case 'rect':
    case 'video':
    case 'image':
      drawShape(scope, r);
      break;
    case 'path':
      drawPath(scope, r);
      break;
    case 'scene3d':
      drawScene3D(ctx, r);
      break;
    case 'lottie':
      drawLottie(scope, r);
      break;
    case 'text':
    case 'captions':
      if (r.layout) {
        const fill = node.kind === 'text' ? (node as TextNode & { fill?: string }).fill : undefined;
        const draw = (target: Ctx2D) =>
          drawText(
            target as never,
            r,
            r.layout!,
            node.kind === 'captions' ? r.caption!.node : (node as TextNode),
            (holder, key, fallback) => subValue(r, holder, key, fallback),
            (paint) => gradient(target, r, paint),
            scope.shadowScale,
          );
        if (fill === 'footage') drawFootageText(scope, r, draw);
        else if (fill === 'inverted') {
          // Học Palmier: chữ "inverted" là blend difference — trắng đảo màu hình bên dưới.
          const composite = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'difference';
          draw(ctx);
          ctx.globalCompositeOperation = composite;
        } else draw(ctx);
      }
      break;
    // Âm thanh không có hình trong scene.
    default:
      break;
  }

  // Lớp phủ màu phủ cả nội dung của node lẫn con của nó, dưới cùng bộ lọc và mask.
  const grade = node.kind === 'video' || node.kind === 'image' || node.kind === 'rect';
  if (grade && !r.children.length) gradeOverlays(ctx, r);

  if (r.children.length) {
    const clips = node.kind === 'scene';
    if (clips) {
      ctx.save();
      ctx.clip();
    }
    for (const child of r.children) {
      if (hasTransition(child) && node.kind === 'sequence') drawTransition(scope, r, child);
      drawNode(scope, child);
    }
    if (clips) ctx.restore();
    if (grade) gradeOverlays(ctx, r);
  }

  if (previousFilter !== null) ctx.filter = previousFilter;
  ctx.restore();
}

/** `colorDodge` → `color-dodge`. */
const composite = (mode: string) => mode.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

// ------------------------------------------------------------------ hình

function rectPath(ctx: Ctx2D, r: RNode): void {
  const { width, height, corners, cornerRadius } = r.values;
  const radii = corners ?? [cornerRadius, cornerRadius, cornerRadius, cornerRadius];
  ctx.beginPath();
  if (radii.every((radius) => radius === 0)) ctx.rect(0, 0, width, height);
  else if (radii.every((radius) => radius === radii[0])) ctx.roundRect(0, 0, width, height, radii[0]);
  // Bốn góc khác nhau: thứ tự trái-trên, phải-trên, phải-dưới, trái-dưới; canvas
  // tự co bán kính khi hai góc kề nhau vượt cạnh chung (luật CSS).
  else ctx.roundRect(0, 0, width, height, radii);
  ctx.closePath();
}

function drawShape(scope: Scope, r: RNode): void {
  const { ctx } = scope;
  const node = r.node as ClipNode & { paints?: Paint[]; strokes?: Stroke[]; shadows?: Shadow[]; src?: AssetInput; objectFit?: string };
  rectPath(ctx, r);
  drawShadows(scope, r, node.shadows ?? []);
  if (r.values.color !== null) {
    ctx.fillStyle = hex(r.values.color);
    ctx.fill();
  }
  if ((node.kind === 'video' || node.kind === 'image') && node.src !== undefined) {
    drawMedia(scope, r, node.kind, node.src, node.objectFit, (node as { objectPosition?: [number, number] }).objectPosition);
  }
  for (const paint of node.paints ?? []) {
    if (paint.hidden) continue;
    const savedAlpha = ctx.globalAlpha;
    const savedComposite = ctx.globalCompositeOperation;
    if (paint.blendMode && paint.blendMode !== 'sourceOver') ctx.globalCompositeOperation = composite(paint.blendMode);
    ctx.globalAlpha = savedAlpha * subValue(r, paint, 'opacity', 1);
    if (paint.type === 'solid') {
      ctx.fillStyle = hex(subValue(r, paint, 'color', 0));
      ctx.fill();
    } else if ('stops' in paint) {
      ctx.fillStyle = gradient(ctx, r, paint);
      ctx.fill();
    } else if ('src' in paint) {
      drawMedia(scope, r, paint.type, paint.src, paint.objectFit, paint.objectPosition);
    }
    ctx.globalCompositeOperation = savedComposite;
    ctx.globalAlpha = savedAlpha;
  }
  drawStrokes(scope, r, node.strokes ?? []);
}

// ------------------------------------------------------------------ path

/**
 * Đường đã đọc, theo `d`. Parse là phần đắt nhất; một clip có vài chục đường và
 * mỗi đường được vẽ lại mỗi khung. Trần để một project sinh hàng nghìn đường
 * khác nhau (morph) không giữ bộ nhớ mãi.
 */
const PARSED = new Map<string, PathSegment[]>();
const GEOMETRY = new Map<string, { segments: PathSegment[]; length: number }>();
const CACHE_LIMIT = 512;

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/**
 * Đoạn của path đã scale từ `viewBox` vào hộp `width×height` của node, cùng độ
 * dài của chính đường đã scale — dash đo theo nét trên màn hình, và scale khác
 * nhau theo hai trục làm độ dài đổi không đều.
 */
export function pathGeometry(node: PathNode, width: number, height: number): { segments: PathSegment[]; length: number } {
  const [vx, vy, vw, vh] = node.viewBox ?? [0, 0, width, height];
  const sx = vw > 0 ? width / vw : 1;
  const sy = vh > 0 ? height / vh : 1;
  return remember(GEOMETRY, `${node.d}|${sx}|${sy}|${vx}|${vy}`, () => {
    const parsed = remember(PARSED, node.d, () => {
      try {
        return parsePath(node.d);
      } catch {
        return [];
      }
    });
    const segments = transformPath(parsed, sx, sy, vx, vy);
    return { segments, length: pathLength(segments) };
  });
}

/** Như `pathGeometry` cho hình đang morph: đổi mỗi khung, không cache. */
function morphGeometry(shape: PathSegment[], node: PathNode, width: number, height: number): { segments: PathSegment[]; length: number } {
  const [vx, vy, vw, vh] = node.viewBox ?? [0, 0, width, height];
  const segments = transformPath(shape, vw > 0 ? width / vw : 1, vh > 0 ? height / vh : 1, vx, vy);
  return { segments, length: pathLength(segments) };
}

function tracePath(ctx: Ctx2D, segments: PathSegment[]): void {
  ctx.beginPath();
  for (const s of segments) {
    switch (s.type) {
      case 'M':
        ctx.moveTo(s.x, s.y);
        break;
      case 'L':
        ctx.lineTo(s.x, s.y);
        break;
      case 'C':
        ctx.bezierCurveTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y);
        break;
      case 'Q':
        ctx.quadraticCurveTo(s.x1, s.y1, s.x, s.y);
        break;
      case 'Z':
        ctx.closePath();
        break;
    }
  }
}

/**
 * Path: fill (màu + paint) rồi viền, như `drawShape` nhưng hình là đường.
 *
 * `trimStart`/`trimEnd` là phần đường được vẽ — animation "vẽ nét" kiểu Create
 * của manim. Trim chỉ áp cho VIỀN, cắt hình học (`trimPath` — dash thì canvas
 * đặt lại ở mỗi đường con); fill chỉ có khi đường vẽ trọn (tô một đường hở một nửa trông như lỗi). Muốn
 * "vẽ rồi tô" thì keyframe opacity của paint.
 *
 * Path không fill thì bóng đổ theo NÉT (mũi tên trắng trên video cần bóng mới
 * đọc được); có fill thì bóng theo hình như rect.
 */
function drawPath(scope: Scope, r: RNode): void {
  const { ctx } = scope;
  const node = r.node as PathNode;
  const v = r.values;
  const { segments, length } = r.shape ? morphGeometry(r.shape, node, v.width, v.height) : pathGeometry(node, v.width, v.height);
  if (!segments.length) return;
  const start = Math.min(Math.max(v.trimStart, 0), 1);
  const end = Math.min(Math.max(v.trimEnd, 0), 1);
  if (end <= start) return;
  const full = start <= EPSILON && end >= 1 - EPSILON;
  const rule = node.fillRule ?? 'nonzero';
  tracePath(ctx, segments);

  const paints = (node.paints ?? []).filter((paint) => !paint.hidden);
  const filled = full && (v.color !== null || paints.length > 0);
  if (filled) {
    drawShadows(scope, r, node.shadows ?? [], rule);
    if (v.color !== null) {
      ctx.fillStyle = hex(v.color);
      ctx.fill(rule);
    }
    for (const paint of paints) {
      const savedAlpha = ctx.globalAlpha;
      const savedComposite = ctx.globalCompositeOperation;
      if (paint.blendMode && paint.blendMode !== 'sourceOver') ctx.globalCompositeOperation = composite(paint.blendMode);
      ctx.globalAlpha = savedAlpha * subValue(r, paint, 'opacity', 1);
      if (paint.type === 'solid') {
        ctx.fillStyle = hex(subValue(r, paint, 'color', 0));
        ctx.fill(rule);
      } else if ('stops' in paint) {
        ctx.fillStyle = gradient(ctx, r, paint);
        ctx.fill(rule);
      } else if ('src' in paint) {
        drawMedia(scope, r, paint.type, paint.src, paint.objectFit, paint.objectPosition);
      }
      ctx.globalCompositeOperation = savedComposite;
      ctx.globalAlpha = savedAlpha;
    }
  }

  const strokes = node.strokes ?? [];
  if (!strokes.some((stroke) => !stroke.hidden)) return;
  if (!full) {
    if (length <= 0) return;
    tracePath(ctx, trimPath(segments, start, end));
  }
  if (node.dash?.length) {
    ctx.setLineDash(node.dash);
    ctx.lineDashOffset = v.dashOffset;
  }
  const shadow = !filled ? (node.shadows ?? []).find((item) => !item.hidden) : undefined;
  if (shadow) {
    ctx.save();
    ctx.shadowColor = hex(subValue(r, shadow, 'color', 0));
    ctx.shadowBlur = subValue(r, shadow, 'blur', 0) * scope.shadowScale;
    ctx.shadowOffsetX = subValue(r, shadow, 'offsetX', 0) * scope.shadowScale;
    ctx.shadowOffsetY = subValue(r, shadow, 'offsetY', 0) * scope.shadowScale;
  }
  drawStrokes(scope, r, strokes);
  if (shadow) ctx.restore();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function drawShadows(scope: Scope, r: RNode, shadows: Shadow[], rule?: 'nonzero' | 'evenodd'): void {
  if (!shadows.length) return;
  const { ctx, shadowScale } = scope;
  ctx.save();
  const savedAlpha = ctx.globalAlpha;
  for (const shadow of shadows) {
    if (shadow.hidden) continue;
    const color = hex(subValue(r, shadow, 'color', 0));
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = savedAlpha * subValue(r, shadow, 'opacity', 1);
    ctx.shadowBlur = subValue(r, shadow, 'blur', 0) * shadowScale;
    ctx.shadowOffsetX = subValue(r, shadow, 'offsetX', 0) * shadowScale;
    ctx.shadowOffsetY = subValue(r, shadow, 'offsetY', 0) * shadowScale;
    rule ? ctx.fill(rule) : ctx.fill();
  }
  ctx.restore();
}

function drawStrokes(scope: Scope, r: RNode, strokes: Stroke[]): void {
  const { ctx } = scope;
  for (const stroke of strokes) {
    if (stroke.hidden) continue;
    const savedAlpha = ctx.globalAlpha;
    const savedComposite = ctx.globalCompositeOperation;
    if (stroke.blendMode && stroke.blendMode !== 'sourceOver') ctx.globalCompositeOperation = composite(stroke.blendMode);
    ctx.lineWidth = subValue(r, stroke, 'width', 1);
    ctx.lineJoin = stroke.join ?? 'miter';
    ctx.lineCap = stroke.cap ?? 'butt';
    ctx.miterLimit = stroke.miterLimit ?? 10;
    ctx.globalAlpha = savedAlpha * subValue(r, stroke, 'opacity', 1);
    ctx.strokeStyle = hex(subValue(r, stroke, 'color', 0));
    ctx.stroke();
    ctx.globalCompositeOperation = savedComposite;
    ctx.globalAlpha = savedAlpha;
  }
}

function gradient(ctx: Ctx2D, r: RNode, paint: Extract<Paint, { stops: unknown }>) {
  const { width: w, height: h } = r.values;
  const angle = ((paint.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Tâm giữa hộp; trục gradient là đường ngang qua tâm, xoay theo `rotation`.
  const along = (t: number) => [(0.5 + (t - 0.5) * cos) * w, (0.5 + (t - 0.5) * sin) * h] as const;
  let g;
  if (paint.type === 'linearGradient') {
    const [x0, y0] = along(0);
    const [x1, y1] = along(1);
    g = ctx.createLinearGradient(x0, y0, x1, y1);
  } else {
    const cx = 0.5 * w;
    const cy = 0.5 * h;
    const [ex, ey] = along(1);
    const fx = (0.5 - 0.5 * sin) * w;
    const fy = (0.5 + 0.5 * cos) * h;
    const radius = Math.max(0.0001, Math.hypot(ex - cx, ey - cy), Math.hypot(fx - cx, fy - cy));
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  }
  const stops = paint.stops
    .map((stop) => {
      const raw = subValue(r, stop, 'offset', 0);
      return {
        offset: raw <= 1 ? Math.max(0, raw) : raw % 1,
        color: subValue(r, stop, 'color', 0),
        opacity: subValue(r, stop, 'opacity', 1),
      };
    })
    .sort((a, b) => a.offset - b.offset);
  for (const stop of stops) g.addColorStop(stop.offset, css(stop.color, stop.opacity));
  return g;
}

// ------------------------------------------------------------------ media

/** Giây của nguồn mà node đang phát: kẹp trong cửa sổ `sourceIn … sourceOut`. */
export function sourceSeconds(r: RNode): number {
  const node = r.node as { sourceIn?: number };
  const inFrames = toFrames(node.sourceIn);
  const out = inFrames + Math.round((r.end - r.start) * r.rate);
  return Math.min(Math.max(r.local, inFrames), out) / 30;
}

/**
 * Giây cần tua tới trong một file Lottie dài `length` giây: lặp thì quay vòng,
 * không lặp thì dừng ở khung cuối. Preview (CanvasKit) và export (Skottie của
 * Node) gọi CHUNG hàm này — chép hai nơi là lệch khung ngầm.
 */
export function lottieTime(seconds: number, length: number, fps: number, loop: boolean): number {
  if (!(length > 0)) return 0;
  return loop ? seconds % length : Math.min(seconds, Math.max(0, length - 1 / (fps || 30)));
}

/**
 * `builtin:<tên>` → đường dẫn tương đối trong thư mục `lottie/` (không đuôi),
 * cho phép một cấp thư mục con (`emoji/fire`). Chỉ chữ thường, số, gạch nối —
 * không có đường nào thoát ra ngoài thư mục; null khi không hợp lệ.
 */
export function builtinLottieName(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith('builtin:')) return null;
  const parts = src.slice(8).split('/');
  return parts.length <= 2 && parts.every((part) => /^[a-z0-9-]+$/.test(part)) ? parts.join('/') : null;
}

/** Giây của animation Lottie ở khung này: thời gian cục bộ × tốc độ + offset. */
export function lottieSeconds(r: RNode): number {
  const node = r.node as { speed?: number; offset?: number };
  return Math.max(0, (r.local / 30) * (node.speed ?? 1) + (node.offset ?? 0));
}

/**
 * Lottie: nơi chạy vẽ khung ở đúng số PIXEL của hộp trên canvas (độ phóng lấy
 * từ ma trận), renderer chỉ đặt ảnh vào hộp — như khung video.
 */
function drawLottie(scope: Scope, r: RNode): void {
  const { ctx, media } = scope;
  const node = r.node as { src?: AssetInput; loop?: boolean; shadows?: Shadow[] };
  if (node.src === undefined || !media.lottie) return;
  const { width, height } = r.values;
  // Hai trục phóng riêng: scaleY 3 mà lấy độ phóng trục x thì ảnh bị kéo giãn, nhoè.
  const zoomX = Math.hypot(r.worldMatrix[0], r.worldMatrix[1]) || 1;
  const zoomY = Math.hypot(r.worldMatrix[2], r.worldMatrix[3]) || 1;
  const pixelsW = Math.max(1, Math.min(2048, Math.round(width * zoomX)));
  const pixelsH = Math.max(1, Math.min(2048, Math.round(height * zoomY)));
  const frame = media.lottie(node.src, lottieSeconds(r), pixelsW, pixelsH, node.loop !== false);
  if (frame === null) return;
  if (frame === 'failed') {
    ctx.fillStyle = MISSING;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const shadow = (node.shadows ?? []).find((item) => !item.hidden);
  if (shadow) {
    ctx.save();
    ctx.shadowColor = hex(subValue(r, shadow, 'color', 0));
    ctx.shadowBlur = subValue(r, shadow, 'blur', 0) * scope.shadowScale;
    ctx.shadowOffsetX = subValue(r, shadow, 'offsetX', 0) * scope.shadowScale;
    ctx.shadowOffsetY = subValue(r, shadow, 'offsetY', 0) * scope.shadowScale;
  }
  ctx.drawImage(frame as never, 0, 0, width, height);
  if (shadow) ctx.restore();
}

function drawMedia(scope: Scope, r: RNode, kind: 'image' | 'video', src: AssetInput, fit: string | undefined, position?: [number, number]): void {
  const { ctx, media } = scope;
  const frame = kind === 'image' ? media.image(src) : media.video(src, sourceSeconds(r));
  if (frame === null) return;
  if (frame === 'failed') {
    // Ô đỏ báo file thiếu như DS — nhưng chỉ cho file thật. Khai báo `generate.*`
    // chưa có (đang sinh) hoặc sinh hỏng thì không vẽ gì: trước đây một lượt Veo
    // hỏng để lại khối đỏ 16 giây phủ kín video (UAT production 29/09).
    if (typeof src !== 'string') return;
    ctx.fillStyle = MISSING;
    ctx.fill();
    return;
  }
  const { width: w, height: h } = r.values;
  ctx.save();
  ctx.clip();
  const [dx, dy, dw, dh] = fitBox(fit ?? 'cover', frame, w, h, position);
  // Khoá cache theo cả giây nguồn: decoder của export và thẻ <video> ở preview dùng
  // lại CÙNG một đối tượng cho mọi khung — khoá theo đối tượng thì khung đầu bị lặp mãi.
  // Thẻ <video> còn đang tua thì `currentTime` chưa tới: thêm nó vào khoá để lượt vẽ sau khi tua xong chỉnh lại.
  const shown = (frame as { currentTime?: number }).currentTime;
  const at = kind === 'video' ? `${sourceSeconds(r)}@${shown ?? ''}` : '';
  ctx.drawImage((graded(scope, r, frame, dw, dh, at) ?? frame) as never, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Chữ "footage" (E4, học Palmier TextFillMode): phủ màu chữ lên CẢ khung scene, chừa lỗ đúng
 * hình chữ để thấy những lớp đã vẽ bên dưới. Vẽ trên canvas tạm cỡ canvas đích: matte theo
 * ma trận của scene, rồi `destination-out` chữ theo ma trận của node.
 */
function drawFootageText(scope: Scope, r: RNode, draw: (target: Ctx2D) => void): void {
  const { ctx } = scope;
  const factory = canvasFactory(scope.media);
  let scene: RNode | null = r.parent;
  while (scene && scene.node.kind !== 'scene') scene = scene.parent;
  if (!factory || !scene) {
    draw(ctx);
    return;
  }
  const { width, height } = ctx.canvas;
  const layer = factory(width, height);
  const lctx = layer.getContext('2d') as unknown as Ctx2D | null;
  if (!lctx) return;
  const color = r.values.color === null ? '#000000' : hex(r.values.color);
  lctx.setTransform(...scene.worldMatrix);
  lctx.fillStyle = color;
  lctx.fillRect(0, 0, scene.values.width, scene.values.height);
  lctx.globalCompositeOperation = 'destination-out';
  lctx.setTransform(...r.worldMatrix);
  draw(lctx);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer as never, 0, 0, width, height);
  ctx.restore();
}

const gradeCache = new WeakMap<object, { key: string; canvas: Drawable }>();

/**
 * Khung đã chỉnh màu (E3) ở cỡ min(nguồn, số pixel đang hiện) — preview nhỏ thì tính
 * ít, export thì đủ nét. Cache theo khung: vẽ lại cùng khung không chỉnh lại.
 */
function graded(scope: Scope, r: RNode, frame: Drawable, dw: number, dh: number, at: string): Drawable | null {
  const steps = gradeSteps((r.node as { effects?: Effect[] }).effects, (effect) => subValue(r, effect, 'value', effect.value)).map((step) => {
    if (step.type !== 'lut') return step;
    const cube = step.params.src ? scope.media.lut?.(step.params.src) : null;
    return { ...step, cube: cube && cube !== 'failed' ? cube : null };
  });
  if (!steps.length) return null;
  const factory = canvasFactory(scope.media);
  if (!factory) return null;
  const zoom = Math.hypot(r.worldMatrix[0], r.worldMatrix[1]) || 1;
  const width = Math.max(1, Math.round(Math.min(frame.width, dw * zoom)));
  const height = Math.max(1, Math.round(Math.min(frame.height, dh * zoom)));
  const seed = steps.some((step) => step.type === 'grain') ? r.local : 0;
  const key = `${at}:${width}x${height}:${seed}:${JSON.stringify(steps, (name, value) => (name === 'cube' ? (value ? (value as CubeLut).size : null) : value))}`;
  const hit = gradeCache.get(frame);
  if (hit?.key === key) return hit.canvas;
  let canvas: Drawable | null = null;
  try {
    canvas = gradeFrame(frame, steps, width, height, factory, seed);
  } catch {
    // Khung bị "taint" (nguồn khác origin không CORS): vẽ khung gốc thay vì làm hỏng cả lượt vẽ.
    return null;
  }
  if (canvas) gradeCache.set(frame, { key, canvas });
  return canvas;
}

function canvasFactory(media: MediaHost): CanvasFactory | null {
  if (media.canvas) return (width, height) => media.canvas!(width, height) as PixelCanvas;
  const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => PixelCanvas }).OffscreenCanvas;
  return Offscreen ? (width, height) => new Offscreen(width, height) : null;
}

function fitBox(fit: string, frame: Drawable, w: number, h: number, position?: [number, number]): [number, number, number, number] {
  if (fit === 'fill') return [0, 0, w, h];
  const scale =
    fit === 'contain' ? Math.min(w / frame.width, h / frame.height) : Math.max(w / frame.width, h / frame.height);
  const dw = frame.width * scale;
  const dh = frame.height * scale;
  // `objectPosition` (E5): phần thừa/thiếu chia theo điểm neo; vắng = giữa như cũ.
  const [px, py] = position ?? [0.5, 0.5];
  return [(w - dw) * px, (h - dh) * py, dw, dh];
}

/** Media mà khung này cần — nơi chạy nạp trước rồi mới gọi vẽ. */
export function collectNeeds(root: RNode): MediaNeed[] {
  const needs: MediaNeed[] = [];
  const visit = (r: RNode) => {
    if (!r.visible) return;
    const node = r.node as ClipNode & { src?: AssetInput; paints?: Paint[]; hidden?: boolean };
    if (node.hidden) return;
    if (node.kind === 'image' && node.src !== undefined) needs.push({ kind: 'image', src: node.src });
    if (node.kind === 'video' && node.src !== undefined) needs.push({ kind: 'video', src: node.src, seconds: sourceSeconds(r) });
    if (node.kind === 'lottie' && node.src !== undefined) needs.push({ kind: 'lottie', src: node.src, seconds: lottieSeconds(r) });
    for (const effect of (node as { effects?: Effect[] }).effects ?? []) {
      if (effect.type === 'lut' && !effect.hidden && effect.params?.src) needs.push({ kind: 'lut', src: effect.params.src });
    }
    for (const paint of node.paints ?? []) {
      if (paint.type === 'image') needs.push({ kind: 'image', src: paint.src });
      if (paint.type === 'video') needs.push({ kind: 'video', src: paint.src, seconds: sourceSeconds(r) });
    }
    r.children.forEach(visit);
  };
  visit(root);
  return needs;
}

// ------------------------------------------------------------------ effect

function effectFilter(r: RNode): string | null {
  const parts: string[] = [];
  if (r.values.blur > EPSILON) parts.push(`blur(${r.values.blur}px)`);
  for (const effect of (r.node as { effects?: Effect[] }).effects ?? []) {
    if (effect.hidden) continue;
    const value = subValue(r, effect, 'value', effect.value);
    const unit = Math.min(1, Math.max(0, value));
    switch (effect.type) {
      case 'blur':
        if (Math.max(0, value) > EPSILON) parts.push(`blur(${Math.max(0, value)}px)`);
        break;
      case 'hueRotate':
        if (Math.abs(value) > EPSILON) parts.push(`hue-rotate(${value}deg)`);
        break;
      case 'brightness':
      case 'contrast':
      case 'saturate':
        // Ba loại này là "giảm về": 1 là không đổi.
        if (Math.abs(unit - 1) > EPSILON) parts.push(`${effect.type}(${unit})`);
        break;
      case 'grayscale':
      case 'invert':
      case 'sepia':
        if (unit > EPSILON) parts.push(`${effect.type}(${unit})`);
        break;
      case 'exposure': {
        const stops = Math.min(2, Math.max(-2, value));
        // Một stop = gấp đôi ánh sáng TUYẾN TÍNH; trong sRGB (gamma ~2.2) là nhân 2^(1/2.2).
        if (Math.abs(stops) > EPSILON) parts.push(`brightness(${round4(2 ** (stops / 2.2))})`);
        break;
      }
      case 'vibrance': {
        const amount = Math.min(1, Math.max(-1, value));
        if (Math.abs(amount) > EPSILON) parts.push(`saturate(${round4(1 + amount)})`);
        break;
      }
    }
  }
  return parts.length ? parts.join(' ') : null;
}

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** Màu phủ soft-light của temperature/tint ở mức 1 — đo bằng mắt trên da người, không gắt. */
const WARM = '#FF8A2A';
const COOL = '#2A7BFF';
const MAGENTA = '#FF2AD4';
const GREEN = '#2AFF6A';
const GRADE_STRENGTH = 0.45;

/**
 * Lớp phủ chỉnh màu (học Palmier §C5) vẽ SAU nội dung, trong hộp của node: soft-light
 * cho nhiệt độ/tint (giữ sáng tối, chỉ đẩy màu), multiply cho vignette (chỉ làm tối viền).
 * Cùng Canvas 2D ở trình duyệt và @napi-rs/canvas, nên preview = export.
 */
function gradeOverlays(ctx: Ctx2D, r: RNode): void {
  const effects = ((r.node as { effects?: Effect[] }).effects ?? []).filter((effect) => !effect.hidden);
  if (!effects.length) return;
  const { width, height } = r.values;
  if (!(width > 0 && height > 0)) return;
  for (const effect of effects) {
    const value = subValue(r, effect, 'value', effect.value);
    if (effect.type === 'temperature' || effect.type === 'tint') {
      const amount = Math.min(1, Math.max(-1, value));
      if (Math.abs(amount) <= EPSILON) continue;
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha *= Math.abs(amount) * GRADE_STRENGTH;
      ctx.fillStyle = effect.type === 'temperature' ? (amount > 0 ? WARM : COOL) : amount > 0 ? MAGENTA : GREEN;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    } else if (effect.type === 'vignette') {
      const amount = Math.min(1, Math.max(0, value));
      if (amount <= EPSILON) continue;
      const radius = Math.hypot(width, height) / 2;
      const params = effect.params;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      if (params?.midpoint === undefined && params?.roundness === undefined && params?.feather === undefined) {
        // Không tham số: giữ đúng vignette cũ (ảnh vàng).
        const gradient = ctx.createRadialGradient(width / 2, height / 2, radius * (0.75 - 0.35 * amount), width / 2, height / 2, radius);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, `rgba(0,0,0,${round4(0.85 * amount)})`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      } else {
        // Học Palmier: midpoint = mép bắt đầu tối, roundness 1 tròn / 0 theo khung, feather = độ mềm.
        const midpoint = Math.min(1, Math.max(0, params.midpoint ?? 0.5));
        const roundness = Math.min(1, Math.max(0, params.roundness ?? 1));
        const feather = Math.min(1, Math.max(0, params.feather ?? 0.5));
        const rx = width / Math.SQRT2 + (radius - width / Math.SQRT2) * roundness;
        const ry = height / Math.SQRT2 + (radius - height / Math.SQRT2) * roundness;
        const edge = rx * (0.45 + 0.55 * midpoint);
        // Vẽ phủ rộng sau khi co trục y, nên phải cắt về hộp của node trước.
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        ctx.translate(width / 2, height / 2);
        ctx.scale(1, ry / rx);
        const gradient = ctx.createRadialGradient(0, 0, edge * (1 - 0.95 * feather), 0, 0, edge);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, `rgba(0,0,0,${round4(0.85 * amount)})`);
        ctx.fillStyle = gradient;
        const far = Math.max(width, height) * Math.max(1, rx / ry) * 2;
        ctx.fillRect(-far, -far, far * 2, far * 2);
      }
      ctx.restore();
    }
  }
}

// ------------------------------------------------------------------ chuyển cảnh

function drawTransition(scope: Scope, sequence: RNode, left: RNode): void {
  const right = partnerOf(left);
  if (!right) return;
  const window = transitionWindow(left, right);
  const now = sequence.local;
  if (now < window.start || now >= window.end) return;
  const completion = (now - window.start) / (window.end - window.start);
  const type = (left.node as { transition?: { type?: string } }).transition?.type ?? 'dissolve';
  const { ctx } = scope;
  const { width, height } = sequence.values;
  switch (type) {
    case 'slideFromRight':
    case 'slideFromLeft': {
      drawNode(scope, left);
      ctx.save();
      const direction = type === 'slideFromRight' ? 1 : -1;
      ctx.translate(((1 - completion) ** 2 * width * direction) | 0, 0);
      drawNode(scope, right);
      ctx.restore();
      break;
    }
    case 'fadeToBlack':
    case 'fadeToWhite': {
      drawNode(scope, completion < 0.5 ? left : right);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.closePath();
      ctx.fillStyle = type === 'fadeToBlack' ? '#000000' : '#FFFFFF';
      ctx.globalAlpha = completion < 0.5 ? 2 * completion : 2 * (1 - completion);
      ctx.fill();
      ctx.restore();
      break;
    }
    default: {
      drawNode(scope, left);
      ctx.save();
      ctx.globalAlpha = completion;
      drawNode(scope, right);
      ctx.restore();
    }
  }
  // Cả hai đã vẽ xong trong chuyển cảnh: vòng lặp con của cha bỏ qua chúng.
  left.visible = false;
  right.visible = false;
}
