/**
 * Tính mọi thứ một khung cần trước khi vẽ: node nào hiện, thời gian cục bộ của
 * nó, giá trị sau keyframe + animation, và ma trận.
 *
 * ## Những luật không nhìn thấy trong document
 *
 * - **Pivot là TÂM hộp**: xoay và co giãn quanh (width/2, height/2). Group lấy
 *   hộp từ hợp các con, nhưng pivot vẫn là nửa bề rộng/cao tính từ (0,0) của
 *   group — không cộng độ lệch gốc của hộp.
 * - **Animation dựng sẵn** chạy trong cửa sổ đầu/cuối clip, tiến độ
 *   `(t − đầu) / max(1, dài − 1)` theo frame; ngoài cửa sổ phía trước (vào) hay
 *   phía sau (ra) vẫn giữ giá trị ở mép, để clip không nháy về trạng thái tĩnh.
 * - **Keyframe** thắng animation trên cùng thuộc tính: áp sau.
 * - **Adjustment layer** nhân transform của nó vào clip NGAY DƯỚI nó (anh em đứng
 *   trước); trong sequence thì là thứ nằm dưới cả sequence.
 */

import { alignPaths, morphAligned, parsePath, type Animation, type CaptionsNode, type ClipNode, type PathSegment, type TextNode, type Track } from '@opencmo/clip-doc';

import { captionFrame, placeCaption, stateAt } from './captions.ts';

import { mixColor, parseColor } from './color.ts';
import { curve, easing } from './easing.ts';
import { layoutText, revealChars, revealWords, scramble, type Measurer, type TextLayout } from './text.ts';
import { authored, IDENTITY, multiply, toFrames, type Mat, type RNode, type SubValues, type Values } from './tree.ts';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** `measurer`: canvas để đo chữ. Không có (lúc chỉ hỏi media cần gì) thì hộp chữ là 0. */
export function evaluate(root: RNode, frame: number, view: Mat, measurer?: Measurer, playFrom = 0): void {
  visibility(root, frame);
  transitionPartners(root, frame);
  motion(root, frame, playFrom);
  transforms(root, view, measurer);
  adjustments(root, view);
}

// ------------------------------------------------------------------ thời gian

function visibility(r: RNode, frame: number): void {
  if (r.node.kind === 'scene') {
    r.local = frame;
    r.visible = true;
  } else {
    r.local = Math.round((frame - r.origin) * r.rate);
    r.visible = frame >= r.start && frame < r.end;
  }
  for (const child of r.children) visibility(child, frame);
  for (const mask of r.masks) visibility(mask, frame);
}

/** Khung chuyển cảnh giữa `left` (mang `transition`) và clip nối ngay sau nó. */
export function transitionWindow(left: RNode, right: RNode): { start: number; end: number } {
  const middle = Math.max(Math.floor((left.end + right.start) / 2), left.end);
  const spec = (left.node as { transition?: { duration?: number } | null }).transition;
  const duration = toFrames(spec?.duration ?? 1);
  return { start: middle - duration / 2, end: middle + duration / 2 };
}

export function partnerOf(left: RNode): RNode | null {
  return left.parent?.children.find((sibling) => sibling.start === left.end) ?? null;
}

/** Trong khung chuyển cảnh, cả hai clip đều phải được vẽ dù một bên đã hết giờ. */
function transitionPartners(root: RNode, frame: number): void {
  walk(root, (r) => {
    if (!hasTransition(r) || r.parent?.node.kind !== 'sequence') return;
    const right = partnerOf(r);
    if (!right) return;
    const window = transitionWindow(r, right);
    if (frame >= window.start && frame < window.end) {
      r.visible = true;
      right.visible = true;
    }
  });
}

export const hasTransition = (r: RNode): boolean => {
  const spec = (r.node as { transition?: unknown }).transition;
  return spec !== undefined && spec !== null;
};

// ------------------------------------------------------------------ motion

function motion(root: RNode, frame: number, playFrom: number): void {
  walk(root, (r) => {
    const node = r.node as ClipNode & { hidden?: boolean };
    r.values = authored(r.node);
    r.subs = new Map();
    r.chars = null;
    r.wordFx = null;
    r.caption = null;
    r.shape = null;
    if (!r.visible || node.hidden) return;
    if (node.kind === 'captions' && r.groups) {
      r.caption = captionFrame(node, r.groups, r.local / 30, guineaCount(r, frame, playFrom));
      r.values.color = r.caption.node.color ? parseColor(r.caption.node.color) : null;
    }
    const animations = ((node as { animations?: Animation[] }).animations ?? []) as Animation[];
    for (const animation of animations) applyAnimation(r, animation);
    for (const track of (node as { tracks?: Track[] }).tracks ?? []) applyNodeTrack(r, track);
    for (const [holder, tracks] of subTracks(node)) {
      const values = subAuthored(holder);
      for (const track of tracks) {
        const value = sample(track, r.local);
        if (value !== null) values[track.property] = value;
      }
      r.subs.set(holder, values);
    }
  });
}

/** Mọi thành phần phụ của node, kèm track của chính nó. */
function subTracks(node: ClipNode): [object, Track[]][] {
  const out: [object, Track[]][] = [];
  const record = node as Record<string, unknown>;
  const visit = (items: unknown) => {
    for (const item of (items as { tracks?: Track[]; stops?: unknown[] }[] | undefined) ?? []) {
      out.push([item, item.tracks ?? []]);
      visit(item.stops);
    }
  };
  for (const key of ['paints', 'strokes', 'shadows', 'effects', 'ranges']) visit(record[key]);
  return out;
}

/** Giá trị gốc của thành phần phụ theo tên thuộc tính của track. */
function subAuthored(holder: object): SubValues {
  const h = holder as Record<string, unknown>;
  const out: SubValues = {};
  for (const key of ['opacity', 'offset', 'width', 'blur', 'offsetX', 'offsetY', 'value']) {
    if (typeof h[key] === 'number') out[key] = h[key] as number;
  }
  if (typeof h.color === 'string') out.color = parseColor(h.color);
  return out;
}

export function subValue(r: RNode, holder: object, key: string, fallback: number): number {
  const value = r.subs.get(holder)?.[key];
  if (value !== undefined) return value;
  const own = (holder as Record<string, unknown>)[key];
  if (key === 'color' && typeof own === 'string') return parseColor(own);
  return typeof own === 'number' ? own : fallback;
}

export function sample(track: Track, frame: number): number | null {
  const keyframes = [...track.keyframes]
    .map((keyframe) => ({
      time: toFrames(keyframe.time),
      value: typeof keyframe.value === 'string' ? parseColor(keyframe.value) : keyframe.value,
      easing: keyframe.easing,
    }))
    .sort((a, b) => a.time - b.time);
  if (!keyframes.length) return null;
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  if (keyframes.length === 1 || frame <= first.time) return first.value;
  if (frame >= last.time) return last.value;
  for (let index = 0; index < keyframes.length - 1; index++) {
    const from = keyframes[index]!;
    const to = keyframes[index + 1]!;
    if (frame < from.time || frame > to.time) continue;
    const span = to.time - from.time;
    if (span <= 0) continue;
    let progress = clamp01((frame - from.time) / span);
    const ease = easing(from.easing);
    if (ease) progress = ease(progress);
    return track.property === 'color'
      ? mixColor(from.value, to.value, progress)
      : from.value + (to.value - from.value) * progress;
  }
  return last.value;
}

const CORNERS = ['cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft'];

/**
 * Cặp đường đã căn cho morph, theo hai chuỗi `d`. Căn là phần đắt (chia cubic);
 * trong một đoạn morph cặp không đổi giữa các khung.
 */
const ALIGNED = new Map<string, ReturnType<typeof alignPaths>>();

/** Hình của path ở khung `frame` theo track `d`: nội suy giữa hai mốc kề nhau, có easing. */
function samplePath(track: Track, frame: number): PathSegment[] | null {
  const keyframes = track.keyframes
    .filter((keyframe) => typeof keyframe.value === 'string')
    .map((keyframe) => ({ time: toFrames(keyframe.time), d: keyframe.value as string, easing: keyframe.easing }))
    .sort((a, b) => a.time - b.time);
  if (!keyframes.length) return null;
  const parse = (d: string) => {
    try {
      return parsePath(d);
    } catch {
      return null;
    }
  };
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  if (keyframes.length === 1 || frame <= first.time) return parse(first.d);
  if (frame >= last.time) return parse(last.d);
  for (let index = 0; index < keyframes.length - 1; index++) {
    const from = keyframes[index]!;
    const to = keyframes[index + 1]!;
    if (frame < from.time || frame > to.time || to.time <= from.time) continue;
    let progress = clamp01((frame - from.time) / (to.time - from.time));
    const ease = easing(from.easing);
    if (ease) progress = ease(progress);
    const key = `${from.d}\u0000${to.d}`;
    let aligned = ALIGNED.get(key);
    if (!aligned) {
      const a = parse(from.d);
      const b = parse(to.d);
      if (!a || !b) return a ?? b;
      aligned = alignPaths(a, b);
      if (ALIGNED.size >= 256) ALIGNED.delete(ALIGNED.keys().next().value!);
      ALIGNED.set(key, aligned);
    }
    return morphAligned(aligned, progress);
  }
  return parse(last.d);
}

function applyNodeTrack(r: RNode, track: Track): void {
  if (track.property === 'd') {
    if (r.node.kind === 'path') r.shape = samplePath(track, r.local);
    return;
  }
  const value = sample(track, r.local);
  if (value === null) return;
  const v = r.values;
  switch (track.property) {
    case 'x':
    case 'y':
    case 'offsetX':
    case 'offsetY':
    case 'rotation':
    case 'scaleX':
    case 'scaleY':
    case 'width':
    case 'height':
    case 'opacity':
    case 'cornerRadius':
    case 'blur':
    case 'volume':
    case 'trimStart':
    case 'trimEnd':
    case 'dashOffset':
    case 'cameraPhi':
    case 'cameraTheta':
    case 'cameraDistance':
      v[track.property] = value;
      break;
    case 'scale':
      v.scaleX = value;
      v.scaleY = value;
      break;
    case 'color':
      v.color = value;
      break;
    default: {
      const corner = CORNERS.indexOf(track.property);
      if (corner >= 0 && v.corners) v.corners[corner] = value;
    }
  }
}

/** Cửa sổ của node theo thời gian cục bộ của chính nó. */
function localWindow(r: RNode): { in: number; out: number } {
  return { in: Math.round((r.start - r.origin) * r.rate), out: Math.round((r.end - r.origin) * r.rate) };
}

const SOFT = curve(0.1, 0.7, 0.5, 1);
const GAIN = curve(0.4, 0.095, 0.546, 0.875);

/** Số từ của chữ đang có (text hay phụ đề) — độ dài mặc định của animation theo từ. */
function wordCount(r: RNode): number {
  const text = r.caption ? r.caption.text : (r.node as { text?: string }).text;
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean).length : 0;
}

const PER_WORD = new Set(['typewriter', 'wordSlide', 'highlightPop']);
/** Màu nhấn mặc định của highlightPop (cùng Palmier). */
const HIGHLIGHT = '#FFD900';

function applyAnimation(r: RNode, animation: Animation): void {
  const perWord = PER_WORD.has(animation.type) ? toFrames(animation.perWord ?? 0.2) : 0;
  const duration = animation.duration !== undefined || !perWord ? toFrames(animation.duration ?? 1) : Math.max(1, perWord * Math.max(1, wordCount(r)));
  if (duration <= 0) return;
  const delay = toFrames(animation.delay ?? 0);
  const out = animation.phase === 'out';
  const window = localWindow(r);
  const from = out ? window.out - duration - delay : window.in + delay;
  if (out ? r.local < from : r.local >= from + duration) return;
  const progress = clamp01((r.local - from) / Math.max(1, duration - 1));
  const v = r.values;
  // t: 1 = trạng thái "xa" nhất của preset, 0 = trạng thái tĩnh của node.
  const eased = (fn: (x: number) => number) => clamp01(fn(progress));
  const toward = (e: number) => (out ? e : 1 - e);
  switch (animation.type) {
    case 'fade': {
      const e = eased(SOFT);
      v.opacity = out ? 1 - e : e;
      break;
    }
    case 'grow':
    case 'shrink': {
      const t = toward(eased(SOFT));
      const scale = animation.type === 'grow' ? 1 - 0.5 * t : 1 + 0.5 * t;
      v.scaleX = scale;
      v.scaleY = scale;
      break;
    }
    case 'blur': {
      const e = eased(out ? curve(0.4, 0, 1, 1) : curve(0.33, 0, 0.2, 1));
      v.blur = out ? 24 * e : 24 * (1 - e);
      break;
    }
    case 'slideLeft':
    case 'slideRight':
    case 'slideUp':
    case 'slideDown': {
      const t = toward(eased(SOFT));
      const sign = out ? -1 : 1;
      if (animation.type === 'slideLeft') v.offsetX = sign * 100 * t;
      if (animation.type === 'slideRight') v.offsetX = sign * -100 * t;
      if (animation.type === 'slideUp') v.offsetY = sign * 100 * t;
      if (animation.type === 'slideDown') v.offsetY = sign * -100 * t;
      v.opacity = 1 - t;
      break;
    }
    case 'spin': {
      const t = toward(eased(curve(0.44, 0.02, 0.252, 0.992)));
      v.scaleX = 1 - t;
      v.scaleY = 1 - t;
      v.rotation = -45 * t;
      break;
    }
    case 'twist': {
      const t = toward(eased(SOFT));
      v.scaleX = 1 + t;
      v.scaleY = 1 + t;
      v.rotation = -10 * t;
      v.offsetX = -30 * t;
      v.offsetY = -30 * t;
      break;
    }
    // Chữ hiện dần: tiến độ KHÔNG qua easing.
    case 'appearWord':
    case 'appearChar':
    case 'scramble': {
      const text = r.caption ? r.caption.text : (r.node as { text?: string }).text;
      if (typeof text !== 'string') break;
      const shown = 1 - (out ? progress : 1 - progress);
      r.chars = (animation.type === 'appearWord' ? revealWords : animation.type === 'appearChar' ? revealChars : scramble)(
        text,
        shown,
      );
      break;
    }
    // Gõ chữ: hiện dần từng ký tự, con trỏ "|" ở cuối khi còn đang gõ.
    case 'typewriter': {
      const text = r.caption ? r.caption.text : (r.node as { text?: string }).text;
      if (typeof text !== 'string') break;
      const shown = out ? 1 - progress : progress;
      const typed = revealChars(text, shown);
      r.chars = shown < 1 ? `${typed.trimEnd()}|` : typed;
      break;
    }
    // Theo từ: `drawText` dời/phóng từng từ theo `t` (khung kể từ đầu animation).
    case 'wordSlide':
    case 'highlightPop':
      r.wordFx = { type: animation.type, t: r.local - from, per: Math.max(1, perWord), out, color: animation.color ?? HIGHLIGHT };
      break;
    // Bật lên: scale 0.6 → 1 có vượt nhẹ (back-out) + hiện dần; ra thì ngược lại.
    case 'pop': {
      // Không qua `eased`: nó kẹp 0–1 và mất đoạn vượt quá 1 của back-out.
      const t = out ? 1 - curve(0.36, 0, 0.66, -0.56)(progress) : curve(0.34, 1.56, 0.64, 1)(progress);
      v.scaleX = 0.6 + 0.4 * t;
      v.scaleY = 0.6 + 0.4 * t;
      v.opacity = Math.min(1, Math.max(0, out ? 1 - progress : progress * 2));
      break;
    }
    // Fade tiếng: CỘNG dB của biên độ vào âm lượng; biên độ 0 là câm hẳn.
    case 'gain': {
      const e = eased(GAIN);
      const amplitude = out ? 1 - e : e;
      v.volume += amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude);
      break;
    }
    default:
      break;
  }
}

/**
 * Guinea đổi màu nhấn mỗi lần nhóm hoặc dòng đổi, nên màu phụ thuộc cái đã phát
 * trước đó. Định nghĩa: phát LIÊN TỤC từ `playFrom` (đầu bản xuất), mỗi khung
 * đang hiện đọc trạng thái, và mỗi lần bước vào một trạng thái mới thì cộng 1
 * (kể cả quay lại đúng nhóm cũ sau một quãng im). Đếm tiếp từ lần trước, chỉ
 * đếm lại từ đầu khi tua lùi.
 */
function guineaCount(r: RNode, frame: number, playFrom: number): number {
  const node = r.node as CaptionsNode;
  if (node.preset !== 'guinea' || !r.groups) return 0;
  const first = Math.max(r.start, playFrom);
  if (!r.history || r.history.frame > frame) r.history = { frame: first - 1, state: null, count: 0 };
  const history = r.history;
  for (let at = history.frame + 1; at <= frame; at++) {
    if (at < r.start || at >= r.end) {
      history.state = null;
      continue;
    }
    const state = stateAt(node, r.groups, Math.round((at - r.origin) * r.rate) / 30);
    if (state !== null && state !== history.state) history.count++;
    history.state = state;
  }
  history.frame = frame;
  return history.count;
}

// ------------------------------------------------------------------ transform

function localMatrix(v: Values, width: number, height: number, tilt?: { x: number; y: number }): Mat {
  const px = width / 2;
  const py = height / 2;
  const radians = (v.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let m: Mat = [1, 0, 0, 1, v.x + v.offsetX + px, v.y + v.offsetY + py];
  m = multiply(m, [cos, sin, -sin, cos, 0, 0]);
  m = multiply(m, [v.scaleX, 0, 0, v.scaleY, 0, 0]);
  // Nghiêng phối cảnh của chữ (E4, học Palmier rotationX/Y): Canvas 2D không có phối cảnh,
  // nên co theo cos góc + xô nhẹ (0.2 × sin) cho cảm giác mặt phẳng ngả ra sau.
  if (tilt && (tilt.x || tilt.y)) {
    const ax = (tilt.x * Math.PI) / 180;
    const ay = (tilt.y * Math.PI) / 180;
    m = multiply(m, [Math.cos(ay), 0.2 * Math.sin(ay), -0.2 * Math.sin(ax), Math.cos(ax), 0, 0]);
  }
  return multiply(m, [1, 0, 0, 1, -px, -py]);
}

/** Hộp trục của một hộp w×h sau ma trận m. */
function bounds(m: Mat, w: number, h: number) {
  const xs = [0, w].flatMap((x) => [0, h].map((y) => m[0] * x + m[2] * y + m[4]));
  const ys = [0, w].flatMap((x) => [0, h].map((y) => m[1] * x + m[3] * y + m[5]));
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const SPATIAL = new Set<ClipNode['kind']>(['rect', 'path', 'scene3d', 'lottie', 'text', 'video', 'image', 'audio', 'group', 'sequence', 'captions']);

// Lề an toàn hai bên khung và số dòng tối đa của phụ đề khi phải ngắt.
const CAPTION_SAFE = 0.05;
const CAPTION_LINES = 3;

/**
 * Dàn phụ đề, rồi kéo nó vào trong khung nếu tràn.
 *
 * DS không ngắt dòng phụ đề: nhóm từ của preset vốn ngắn. Nhưng transcript lấy
 * từ phụ đề có sẵn không có word timing, mỗi "từ" là cả một dòng, và một dòng
 * Stark cỡ 70 dài gấp rưỡi khung 1080 — bị cắt cả hai mép trong MP4 export
 * (UAT production 29/09). Ngưỡng là max(hộp preset, khung trừ lề): dòng nào
 * vừa hộp của DS thì không bao giờ bị đụng, nên ảnh vàng giữ nguyên. Tràn thì
 * ngắt dòng trước, vẫn tràn (một từ quá dài, quá nhiều dòng) mới thu cỡ chữ.
 */
function fitCaption(
  measurer: Measurer,
  r: RNode,
  chars: string,
  node: TextNode,
  box: { x: number; width: number },
  frameWidth: number,
) {
  const margin = frameWidth * CAPTION_SAFE;
  // Căn trái (cascade) bắt đầu ở box.x; các preset khác căn giữa khung.
  const room = node.textAlign === 'left' ? frameWidth - box.x - margin : frameWidth - 2 * margin;
  const limit = Math.max(box.width, room);
  const first = layoutText(measurer, r, chars, node);
  if (!(frameWidth > 0) || widest(first) <= limit) return first;

  let fitted: TextNode = { ...node, width: limit };
  let layout = layoutText(measurer, r, chars, fitted);
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = widest(layout);
    if (width <= limit && lineCount(layout) <= CAPTION_LINES) break;
    const scale = Math.min(0.9, width > limit ? limit / width : 0.9);
    fitted = {
      ...fitted,
      fontSize: (fitted.fontSize ?? 16) * scale,
      ...(fitted.ranges
        ? { ranges: fitted.ranges.map((range) => (range.fontSize ? { ...range, fontSize: range.fontSize * scale } : range)) }
        : {}),
    };
    layout = layoutText(measurer, r, chars, fitted);
  }
  return layout;
}

function lines(layout: TextLayout): Map<number, number> {
  const out = new Map<number, number>();
  for (const word of layout.words) out.set(word.y, (out.get(word.y) ?? 0) + word.width);
  return out;
}

const widest = (layout: TextLayout) => Math.max(0, ...lines(layout).values());
const lineCount = (layout: TextLayout) => lines(layout).size;

function transforms(root: RNode, view: Mat, measurer?: Measurer): void {
  const local = (r: RNode) => {
    for (const child of r.children) local(child);
    for (const mask of r.masks) local(mask);
    const v = r.values;
    r.layout = null;
    if (r.node.kind === 'captions') {
      // Khung cha của phụ đề: bỏ qua sequence (nó mượn khung của cha nó).
      let parent = r.parent;
      while (parent && parent.node.kind === 'sequence') parent = parent.parent;
      const frameBox = parent ? parent.values : { width: 0, height: 0 };
      const box = placeCaption(r.node, frameBox);
      Object.assign(v, box);
      if (r.caption && measurer) {
        r.layout = fitCaption(measurer, r, r.chars ?? r.caption.text, r.caption.node, box, frameBox.width);
      }
    }
    if (r.node.kind === 'text' && measurer) {
      // Hộp chữ phải có TRƯỚC ma trận: pivot là tâm hộp, và group bao cả nó.
      r.layout = layoutText(measurer, r, r.chars ?? r.node.text, r.node as TextNode);
    }
    if (r.node.kind === 'sequence' && r.parent) {
      // Sequence không có không gian riêng: khung của cha, không dời, không xoay.
      v.width = r.parent.values.width;
      v.height = r.parent.values.height;
      r.originX = r.parent.originX;
      r.originY = r.parent.originY;
      v.x = v.y = v.offsetX = v.offsetY = v.rotation = 0;
      v.scaleX = v.scaleY = 1;
    } else if (r.node.kind === 'group') {
      const boxes = r.children
        .filter((child) => SPATIAL.has(child.node.kind) && !(child.node as { hidden?: boolean }).hidden)
        .map((child) => bounds(child.localMatrix, child.values.width, child.values.height));
      if (boxes.length) {
        const minX = Math.min(...boxes.map((box) => box.minX));
        const minY = Math.min(...boxes.map((box) => box.minY));
        v.width = Math.max(0, Math.max(...boxes.map((box) => box.maxX)) - minX);
        v.height = Math.max(0, Math.max(...boxes.map((box) => box.maxY)) - minY);
        r.originX = minX;
        r.originY = minY;
      } else {
        v.width = v.height = 0;
      }
    }
    const node = r.node as { kind: string; tiltX?: number; tiltY?: number };
    r.localMatrix = localMatrix(v, v.width, v.height, node.kind === 'text' ? { x: node.tiltX ?? 0, y: node.tiltY ?? 0 } : undefined);
  };
  // Sequence đọc khung của cha, nên cha phải có kích thước trước: scene có sẵn,
  // group thì lượt đầu tính con rồi mới tới nó.
  local(root);
  // Scene nằm ở gốc của khung xuất: bỏ dời của chính nó.
  root.localMatrix = [...root.localMatrix.slice(0, 4), 0, 0] as Mat;
  world(root, view);
}

function world(r: RNode, parent: Mat): void {
  r.worldMatrix = multiply(parent, r.localMatrix);
  for (const child of r.children) world(child, r.worldMatrix);
  for (const mask of r.masks) world(mask, r.worldMatrix);
}

function adjustments(root: RNode, view: Mat): void {
  walk(root, (layer) => {
    if (layer.node.kind !== 'adjustmentLayer' || !layer.visible) return;
    if ((layer.node as { hidden?: boolean }).hidden) return;
    let slot = layer;
    let parent = slot.parent;
    while (parent && parent.node.kind === 'sequence') {
      slot = parent;
      parent = slot.parent;
    }
    if (!parent) return;
    const index = parent.children.indexOf(slot);
    if (index <= 0) return;
    const target = parent.children[index - 1]!;
    target.localMatrix = multiply(layer.localMatrix, target.localMatrix);
    world(target, parent === root ? multiply(view, root.localMatrix) : parent.worldMatrix);
  });
}

export function walk(r: RNode, visit: (r: RNode) => void): void {
  visit(r);
  for (const child of r.children) walk(child, visit);
  for (const mask of r.masks) walk(mask, visit);
}

export { IDENTITY };
