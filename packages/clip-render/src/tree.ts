/**
 * Cây vẽ của một scene: node của document kèm thời gian đã giải (theo FRAME,
 * 30 fps) và chỗ chứa giá trị tính lại mỗi khung.
 *
 * ## Thời gian
 *
 * Mọi mốc quy về frame nguyên (`round(giây · 30)`) trước khi so, vì đó là cách
 * người dùng đang thấy trong fork: hai clip cách nhau nửa frame vẫn nối khít.
 *
 * - `origin`: frame của scene ứng với giây 0 của NGUỒN node — cha cộng
 *   `start − sourceIn / rate`. Giữ phần lẻ để tiếng không trượt nửa frame.
 * - `start`/`end`: khoảng node hiện trên timeline, frame nguyên.
 * - Group, scene và sequence không có `end` riêng thì bao trọn các con; có `end`
 *   thì cắt con.
 * - Node có nguồn video/âm thanh mà không có `end`/`sourceOut` thì dài bằng nguồn;
 *   không biết độ dài nguồn (ảnh, rect…) thì 16 giây.
 */

import type { ClipNode, PathSegment, SceneNode } from '@opencmo/clip-doc';

import { parseColor } from './color.ts';
import { censorTranscript } from './profanity.ts';
import { groupPhrases, groupWords, presetOf, transcriptEnd, type CaptionFrame, type TranscriptWord } from './captions.ts';
import type { TextLayout } from './text.ts';
import type { MediaHost } from './types.ts';

export const FPS = 30;
export const DEFAULT_FRAMES = 16 * FPS;

export const toFrames = (seconds: number | undefined): number => Math.round((seconds ?? 0) * FPS);

/** Ma trận affine theo thứ tự của canvas: [a, b, c, d, e, f]. */
/** `t`: khung đã chạy kể từ đầu animation; `per`: số khung mỗi từ. */
export type WordFx = { type: 'wordSlide' | 'highlightPop'; t: number; per: number; out: boolean; color: string };

export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Giá trị tính lại mỗi khung (motion ghi đè lên giá trị đã viết). */
export type Values = {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  opacity: number;
  blur: number;
  /** dB; −Infinity = câm. Chỉ export đọc (trộn tiếng). */
  volume: number;
  color: number | null;
  cornerRadius: number;
  corners: [number, number, number, number] | null;
  /** Path: phần đường được vẽ (0–1) và độ lệch dash, px của hộp. */
  trimStart: number;
  trimEnd: number;
  dashOffset: number;
  /** scene3d: camera theo keyframe; NaN = theo khai báo `camera` của node. */
  cameraPhi: number;
  cameraTheta: number;
  cameraDistance: number;
};

/** Giá trị của thành phần phụ (paint, stop, stroke, shadow, effect). */
export type SubValues = Record<string, number>;

export type RNode = {
  node: ClipNode;
  parent: RNode | null;
  children: RNode[];
  masks: RNode[];
  /** Group-like: bao con theo thời gian (group, scene, sequence không có `end`). */
  fits: boolean;
  origin: number;
  start: number;
  end: number;
  rate: number;
  // ---- mỗi khung
  visible: boolean;
  local: number;
  values: Values;
  subs: Map<object, SubValues>;
  /** Hộp của group: gốc lệch khỏi (0,0) khi con không bắt đầu ở góc. */
  originX: number;
  originY: number;
  localMatrix: Mat;
  worldMatrix: Mat;
  /** Chữ đang hiện (animation chữ cắt bớt); null = nguyên văn của node. */
  chars: string | null;
  /** Animation theo từ (E4): tiến độ để `drawText` dời/phóng/đổi màu từng từ. */
  wordFx: WordFx | null;
  layout: TextLayout | null;
  /** Path đang morph (track `d`): hình của khung này, toạ độ của `d`; null = `node.d`. */
  shape: PathSegment[] | null;
  /** Phụ đề: nhóm từ (tính một lần) và `<text>` ảo của khung này. */
  groups: TranscriptWord[][] | null;
  caption: CaptionFrame | null;
  /** Guinea: đã đếm tới khung nào, trạng thái lúc đó, và số lần đổi. */
  history: { frame: number; state: string | null; count: number } | null;
};

const DEFAULT_SIZE: Partial<Record<ClipNode['kind'], [number, number]>> = {
  scene: [1920, 1080],
  rect: [100, 100],
  path: [100, 100],
  scene3d: [1080, 1080],
  lottie: [512, 512],
  video: [1920, 1080],
  image: [1920, 1080],
  audio: [500, 150],
  adjustmentLayer: [1920, 1080],
};

const GROUP_LIKE = new Set<ClipNode['kind']>(['scene', 'group', 'sequence']);

export function buildTree(scene: SceneNode, media: MediaHost): RNode {
  const make = (node: ClipNode, parent: RNode | null): RNode => {
    const r: RNode = {
      node,
      parent,
      children: [],
      masks: [],
      fits: false,
      origin: 0,
      start: 0,
      end: 0,
      rate: 1,
      visible: false,
      local: 0,
      values: authored(node),
      subs: new Map(),
      originX: 0,
      originY: 0,
      localMatrix: IDENTITY,
      worldMatrix: IDENTITY,
      chars: null,
      wordFx: null,
      layout: null,
      shape: null,
      groups: null,
      caption: null,
      history: null,
    };
    if (node.kind === 'captions' && node.src !== undefined) {
      const raw = media.transcript?.(node.src) ?? null;
      const transcript = raw && node.censor ? censorTranscript(raw) : raw;
      // Có trần dòng (maxWords/maxChars) thì ngắt theo câu → mệnh đề → giữa; không thì luật nhóm của preset DS.
      r.groups = !transcript
        ? []
        : node.maxWords || node.maxChars
          ? groupPhrases(transcript, { maxWords: node.maxWords, maxChars: node.maxChars })
          : groupWords(transcript, presetOf(node).limit);
    }
    const record = node as { children?: ClipNode[]; masks?: ClipNode[] };
    r.children = (record.children ?? []).map((child) => make(child, r));
    r.masks = (record.masks ?? []).map((mask) => make(mask, r));
    return r;
  };
  const root = make(scene, null);
  resolveTime(root, 0, media);
  return root;
}

function resolveTime(r: RNode, parentOrigin: number, media: MediaHost): void {
  const node = r.node as Partial<Record<'start' | 'end' | 'sourceIn' | 'sourceOut' | 'playbackRate', number>> & ClipNode;
  const rate = node.playbackRate || 1;
  const startFrames = toFrames(node.start);
  const inFrames = toFrames(node.sourceIn);
  let trimEnd: number | null = null;
  if (node.end !== undefined) trimEnd = inFrames + (toFrames(node.end) - startFrames) * rate;
  if (node.sourceOut !== undefined) {
    trimEnd = trimEnd === null ? toFrames(node.sourceOut) : Math.min(trimEnd, toFrames(node.sourceOut));
  }

  // Scene nằm ngoài mọi dòng thời gian: gốc của nó là 0.
  const origin = r.node.kind === 'scene' ? 0 : parentOrigin + startFrames - inFrames / rate;
  const start = Math.round(origin + inFrames / rate);
  r.origin = origin;
  r.rate = rate;

  for (const child of r.children) resolveTime(child, origin, media);
  for (const mask of r.masks) resolveTime(mask, origin, media);

  r.fits = GROUP_LIKE.has(r.node.kind) && trimEnd === null;
  if (r.fits) {
    if (r.children.length === 0) {
      r.start = start;
      r.end = start + DEFAULT_FRAMES;
    } else {
      r.start = Math.min(...r.children.map((child) => child.start));
      r.end = Math.max(...r.children.map((child) => child.end));
    }
    return;
  }

  if (r.node.kind === 'captions') {
    // Phụ đề không có end: dài bằng transcript; chưa đọc được transcript thì bằng khoảng còn lại của cha.
    let out = trimEnd;
    if (out === null && r.node.src !== undefined) {
      const transcript = media.transcript?.(r.node.src);
      const end = transcript ? transcriptEnd(transcript) : null;
      if (end !== null) out = toFrames(end);
    }
    if (out === null) {
      const span = r.parent ? (r.parent.end - origin) * rate : NaN;
      out = Number.isFinite(span) && span > 0 ? span : DEFAULT_FRAMES;
    }
    out = Math.max(inFrames, out);
    r.start = start;
    r.end = Math.max(start, Math.round(origin + out / rate));
    return;
  }

  let out = trimEnd ?? Infinity;
  const duration = sourceDuration(r.node, media);
  if (duration !== null) out = Math.min(out, toFrames(duration));
  if (out === Infinity) out = DEFAULT_FRAMES;
  out = Math.max(inFrames, out);
  r.start = start;
  r.end = Math.max(start, Math.round(origin + out / rate));
}

/** Độ dài nguồn có thời gian: video/âm thanh của chính node, hoặc paint video đầu tiên. */
function sourceDuration(node: ClipNode, media: MediaHost): number | null {
  if (node.kind === 'video' || node.kind === 'audio') return media.duration(node.src);
  const paints = (node as { paints?: { type: string; src?: unknown }[] }).paints ?? [];
  for (const paint of paints) {
    if (paint.type === 'video') return media.duration(paint.src as never);
  }
  return null;
}

/**
 * Giá trị đã viết trong document, trước motion.
 *
 * `scale` cùng `scaleX`/`scaleY`: fork ghi giá trị theo THỨ TỰ prop được đặt khi
 * node đứng yên (prop sau thắng, `scaleX` một mình kéo trục kia về 1), nhưng khi
 * node có keyframe/animation thì `scale` luôn thắng. Document in prop theo thứ tự
 * cố định (`scale` trước `scaleX`), nên luật tương đương là nhánh dưới đây.
 */
export function authored(node: ClipNode): Values {
  const n = node as Partial<Record<string, unknown>>;
  const num = (key: string, fallback: number) => (typeof n[key] === 'number' ? (n[key] as number) : fallback);
  const [width, height] = DEFAULT_SIZE[node.kind] ?? [0, 0];
  const moving = Boolean((n.animations as unknown[] | undefined)?.length || (n.tracks as unknown[] | undefined)?.length);
  const perAxis = typeof n.scaleX === 'number' || typeof n.scaleY === 'number';
  const uniform = typeof n.scale === 'number' && (moving || !perAxis) ? (n.scale as number) : null;
  const corner = (key: string) => (typeof n[key] === 'number' ? (n[key] as number) : null);
  const radius = num('cornerRadius', 0);
  const own = ['cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft'].map(corner);
  const fill = node.kind === 'rect' || node.kind === 'scene' || node.kind === 'path' ? n.fill : node.kind === 'text' ? n.color : undefined;
  return {
    x: num('x', 0),
    y: num('y', 0),
    offsetX: num('offsetX', 0),
    offsetY: num('offsetY', 0),
    rotation: num('rotation', 0),
    scaleX: uniform ?? num('scaleX', 1),
    scaleY: uniform ?? num('scaleY', 1),
    width: num('width', width),
    height: num('height', height),
    opacity: num('opacity', 1),
    blur: 0,
    volume: n.volume === '-Infinity' ? -Infinity : num('volume', 0),
    color: typeof fill === 'string' ? parseColor(fill) : null,
    cornerRadius: radius,
    corners: own.some((value) => value !== null)
      ? (own.map((value) => value ?? radius) as [number, number, number, number])
      : null,
    trimStart: num('trimStart', 0),
    trimEnd: num('trimEnd', 1),
    dashOffset: num('dashOffset', 0),
    cameraPhi: NaN,
    cameraTheta: NaN,
    cameraDistance: NaN,
  };
}
