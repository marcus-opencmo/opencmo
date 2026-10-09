/**
 * Phụ đề và cắt bằng chữ trên document của clip.
 *
 * ## Trạng thái nằm trong document
 *
 * Cắt biến video master thành một `sequence` gồm các đoạn giữ lại. Thứ cần để
 * tính lại lượt cắt — transcript NGUỒN, cửa sổ nguồn, các khoảng đã xoá — là
 * mark `text-cut` của chính sequence đó:
 *
 *     { kind: 'sequence', marks: { 'text-cut': { transcript, window, removed } }, children: [video…] }
 *
 * Nằm trong document nghĩa là nó đi cùng mọi đường document đi qua: autosave và
 * khoá lạc quan, revision export, reset, khôi phục bản cũ. (Trong TSX của fork,
 * mark là comment `opencmo:text-cut` ở đầu sequence.)
 *
 * ## Keyframe không cần cắt
 *
 * `time` của keyframe tính theo NGUỒN, nên mỗi đoạn mang nguyên track của video
 * gốc và chỉ phát phần của nó.
 */

import type { CaptionsNode, ClipDocument, ClipNode, SequenceNode, TextCutMark, VideoNode } from '@opencmo/clip-doc';
import { FPS } from '@opencmo/clip-render';

import { activeView, assign, clone, isMaster, nodes, sceneOf, walk, type Entity } from './doc';
import { rebuildLayout } from './layout';
import { keptDuration, keptRanges, round, type Range } from './transcript';

export type CaptionState = {
  /** `src` của transcript NGUỒN — cái panel sửa; null khi clip không có `<captions>`. */
  base: string | null;
  /** Cửa sổ nguồn của clip: `sourceIn`/`sourceOut` của video trước khi cắt. */
  window: Range | null;
  /** Các khoảng nguồn đã xoá khỏi video. Rỗng là chưa cắt. */
  removed: Range[];
};

/**
 * J/L-cut (học Palmier `manage_clip_links`): dời điểm cắt TIẾNG ở một chỗ cắt, hình
 * giữ nguyên. Khoá = giây nguồn đầu đoạn SAU chỗ cắt (bền qua lượt cắt lại — đoạn còn
 * thì roll còn); giá trị d giây: d > 0 = L-cut (tiếng đoạn trước kéo sang hình đoạn
 * sau), d < 0 = J-cut (tiếng đoạn sau vào sớm, dưới hình đoạn trước).
 */
export type AudioRoll = Record<string, number>;

type CutMark = TextCutMark;

/** Khoá roll của chỗ cắt TRƯỚC đoạn bắt đầu ở giây nguồn `start`. */
export const rollKey = (start: number): string => String(round(start));

/** Đoạn giữ lại ngắn nhất còn lại sau khi dời tiếng (giây). */
const ROLL_KEEP = 0.1;

/**
 * Roll hợp lệ cho các đoạn `kept`: bỏ khoá không còn chỗ cắt (đoạn đã bị cắt mất), kẹp
 * để tiếng không vượt cửa sổ nguồn và không nuốt trọn một đoạn.
 */
export function activeRoll(kept: Range[], window: Range, roll: AudioRoll | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!roll) return out;
  for (let index = 1; index < kept.length; index++) {
    const value = roll[rollKey(kept[index]!.start)];
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    const before = kept[index - 1]!;
    const after = kept[index]!;
    const limit =
      value > 0
        ? Math.min(after.end - after.start - ROLL_KEEP, window.end - before.end)
        : Math.min(before.end - before.start - ROLL_KEEP, after.start - window.start);
    const clamped = Math.sign(value) * Math.min(Math.abs(value), Math.max(0, limit));
    if (Math.abs(clamped) >= 1 / FPS) out.set(index, round(clamped));
  }
  return out;
}

/**
 * Phụ đề của một voiceover (mark `voiceover`): đọc transcript của GIỌNG MỚI, không
 * phải của video. Cắt bằng chữ, sửa từ, dời mốc chỉ đụng phụ đề của video
 * (spec voiceover §3) — nhầm hai thứ là cắt video theo chữ của giọng đọc.
 */
export const isVoiceoverCaptions = (node: ClipNode): boolean =>
  node.kind === 'captions' && Boolean((node as { marks?: Record<string, unknown> }).marks?.voiceover);

/** Phụ đề của video (không phải của voiceover). */
const isVideoCaptions = (node: ClipNode): node is CaptionsNode => node.kind === 'captions' && !isVoiceoverCaptions(node);

function cutMark(node: ClipNode): CutMark | null {
  if (node.kind !== 'sequence') return null;
  const mark = node.marks?.['text-cut'] as Partial<CutMark> | undefined;
  return mark && typeof mark.transcript === 'string' && mark.window && Array.isArray(mark.removed)
    ? (mark as CutMark)
    : null;
}

const videosIn = (root: ClipNode): VideoNode[] => {
  const out: VideoNode[] = [];
  const visit = (node: ClipNode) => {
    if (isMaster(node)) out.push(node as VideoNode);
    for (const child of [...((node as { masks?: ClipNode[] }).masks ?? []), ...((node as { children?: ClipNode[] }).children ?? [])]) {
      visit(child);
    }
  };
  for (const child of (root as { children?: ClipNode[] }).children ?? []) visit(child);
  return out;
};

type Located = {
  /** Node bị thay: sequence đã cắt, hoặc video master đơn. */
  target: ClipNode;
  /** Video làm mẫu cho mọi đoạn. */
  template: VideoNode;
  mark: CutMark | null;
  window: Range | null;
  captions: CaptionsNode | undefined;
};

function locate(document: ClipDocument): Located | null {
  const all = nodes(document);
  const captions = all.find(isVideoCaptions);
  for (const node of all) {
    const mark = cutMark(node);
    if (!mark) continue;
    const template = videosIn(node)[0];
    if (!template) return null;
    return { target: node, template, mark, window: mark.window, captions };
  }
  const video = all.find(isMaster) as VideoNode | undefined;
  if (!video) return null;
  const start = typeof video.sourceIn === 'number' ? video.sourceIn : 0;
  const end = video.sourceOut;
  return {
    target: video,
    template: video,
    mark: null,
    window: typeof end === 'number' ? { start, end } : null,
    captions,
  };
}

/** Phụ đề của video gốc (lớp mà Transcript và cắt bằng chữ sửa); không có thì null. */
export function masterCaptions(document: ClipDocument): CaptionsNode | null {
  return locate(document)?.captions ?? null;
}

/** J/L-cut đang lưu trong mark cắt (rỗng khi chưa có). */
export function readCutRoll(document: ClipDocument): AudioRoll {
  return locate(document)?.mark?.roll ?? {};
}

/** Mốc CLIP bắt đầu của từng đoạn giữ lại (cùng phép cộng theo frame như khi dựng). */
export function segmentStarts(kept: Range[]): number[] {
  return kept.map((_, index) => round(segmentStart(kept, index)));
}

/** Trạng thái phụ đề và cắt; không có video master thì null. */
export function readCaptionState(document: ClipDocument): CaptionState | null {
  const found = locate(activeView(document));
  if (!found) return null;
  const src = found.captions?.src;
  const base = found.mark?.transcript ?? (typeof src === 'string' ? src : null);
  return { base, window: found.window, removed: found.mark?.removed ?? [] };
}

/**
 * Một đoạn của video mẫu. Bỏ `id` trên video VÀ mọi thành phần phụ của nó: nhân
 * bản id là hai phần tử cùng tên, và lượt sửa kế tiếp theo tên đó trượt lặng lẽ.
 * Lượt stamp sau đặt tên mới.
 */
function segment(template: VideoNode, range: Range, start: number): VideoNode {
  const copy = structuredClone(template) as unknown as Entity;
  const strip = (value: unknown, key?: string): void => {
    if (key === 'src' || key === 'marks') return;
    if (Array.isArray(value)) return value.forEach((item) => strip(item));
    if (!value || typeof value !== 'object') return;
    delete (value as Entity).id;
    for (const [inner, item] of Object.entries(value)) strip(item, inner);
  };
  strip(copy);
  copy.sourceIn = round(range.start);
  copy.sourceOut = round(range.end);
  // `sequence` không tự xếp các con nối đuôi: thiếu `start` thì mọi đoạn cùng
  // bắt đầu ở 0 và chỉ đoạn cuối còn thấy được.
  copy.start = round(start);
  return copy as unknown as VideoNode;
}

const withoutMute = (video: VideoNode): VideoNode => {
  const copy = { ...video } as VideoNode & { muted?: boolean };
  delete copy.muted;
  return copy;
};

/**
 * Đoạn TIẾNG thứ `index` khi có J/L-cut: cùng nguồn với đoạn hình, hai đầu dời theo
 * roll của chỗ cắt trước/sau. Mang âm lượng, khử ồn và track `volume` của video mẫu
 * (mốc keyframe theo giây nguồn nên dùng chung được); `muted` thì không — video mẫu
 * câm vì CHÍNH J/L-cut này.
 */
function soundSegment(template: VideoNode, range: Range, kept: Range[], index: number, rolls: Map<number, number>): ClipNode {
  const lead = rolls.get(index) ?? 0;
  const trail = rolls.get(index + 1) ?? 0;
  const source = template as unknown as Entity;
  const tracks = ((source.tracks as Entity[] | undefined) ?? []).filter((track) => track.property === 'volume');
  const node: Entity = {
    kind: 'audio',
    src: source.src,
    start: round(segmentStart(kept, index) + lead),
    sourceIn: round(range.start + lead),
    sourceOut: round(range.end + trail),
    marks: { 'cut-audio': true },
  };
  for (const key of ['volume', 'denoise', 'playbackRate']) if (source[key] !== undefined) node[key] = source[key];
  if (tracks.length) node.tracks = structuredClone(tracks);
  return node as unknown as ClipNode;
}

export type WriteCaptionState = {
  /** Transcript NGUỒN mà panel đang giữ (đường dẫn thư viện). */
  base: string | null;
  removed: Range[];
  /** J/L-cut; bỏ qua = giữ roll đang có (lượt cắt chữ không làm mất J/L-cut). */
  roll?: AudioRoll | null;
  /** Transcript theo thang OUTPUT cho `<captions>` khi có cắt, đã lưu. */
  cutTranscript?: string;
};

/** Thay `target` bằng `next` tại đúng chỗ của nó trong cây. */
function replaceNode(document: ClipDocument, target: ClipNode, next: ClipNode): void {
  walk(document, ({ entity, list }) => {
    if (entity === (target as unknown) && list) list[list.indexOf(entity)] = next as unknown as Entity;
  });
}

/**
 * Mốc bắt đầu của đoạn thứ `index`, cộng dồn THEO FRAME đúng như renderer đo
 * đuôi đoạn trước (`toFrames(sourceOut) − toFrames(sourceIn)`). Cộng dồn theo
 * giây rồi làm tròn từng mốc thì hai đoạn có thể hở nhau đúng một frame — một
 * chớp đen trong bản xuất mà không ai thấy trên timeline (eval AE0 bắt được).
 */
function segmentStart(kept: Range[], index: number): number {
  let frames = 0;
  for (const range of kept.slice(0, index)) frames += Math.round(round(range.end) * FPS) - Math.round(round(range.start) * FPS);
  // Mốc theo giây rơi đúng frame thì giữ nguyên (document không đổi so với trước).
  const seconds = keptDuration(kept.slice(0, index));
  return Math.round(round(seconds) * FPS) === frames ? seconds : frames / FPS;
}

/**
 * Ghi trạng thái phụ đề/cắt. Luôn dựng lại từ cửa sổ nguồn và danh sách khoảng
 * xoá, nên cùng đầu vào ra cùng một document.
 */
export function writeCaptionState(input: ClipDocument, state: WriteCaptionState): ClipDocument {
  const document = clone(input);
  const found = locate(document);
  if (!found?.window) throw new Error('This project has no clip video to edit.');
  const window = found.window;
  const kept = keptRanges(window, state.removed);
  if (!kept.length) throw new Error('That would remove the whole clip.');
  const cut = state.removed.length > 0;

  const rolls = cut ? activeRoll(kept, window, state.roll === undefined ? found.mark?.roll : (state.roll ?? undefined)) : new Map<number, number>();
  const roll: AudioRoll = Object.fromEntries([...rolls].map(([index, value]) => [rollKey(kept[index]!.start), value]));
  // Lượt trước có J/L-cut thì video mẫu câm vì CHÍNH nó (không phải người dùng tắt
  // tiếng): dựng lại từ một mẫu không câm, rồi câm lại nếu J/L-cut vẫn còn.
  const template = found.mark?.roll && Object.keys(found.mark.roll).length ? withoutMute(found.template) : found.template;
  const videos = kept.map((range, index) => segment(template, range, segmentStart(kept, index)));
  // Có J/L-cut: hình câm, tiếng đi bằng các đoạn `audio` cùng nguồn với điểm cắt đã dời.
  const sounds = rolls.size ? kept.map((range, index) => soundSegment(template, range, kept, index, rolls)) : [];
  if (rolls.size) for (const video of videos) (video as { muted?: boolean }).muted = true;
  const replacement: ClipNode = cut
    ? ({
        kind: 'sequence',
        marks: {
          'text-cut': { transcript: state.base ?? '', window, removed: state.removed, ...(rolls.size ? { roll } : {}) },
        },
        children: [...videos, ...sounds],
      } satisfies SequenceNode)
    : segment(template, window, 0);
  replaceNode(document, found.target, replacement);

  // Sau khi cắt, phụ đề đọc transcript OUTPUT từ giây 0 tới hết phần giữ lại;
  // chưa cắt thì đọc transcript nguồn đúng cửa sổ của video.
  // Theo frame như các đoạn: phụ đề và vùng xuất dài hơn đoạn cuối một frame là một frame đen ở cuối bản xuất.
  const duration = cut ? segmentStart(kept, kept.length) : round(window.end - window.start);
  const captions = nodes(document).find(isVideoCaptions) as Entity | undefined;
  if (captions) {
    const src = cut ? state.cutTranscript : state.base;
    if (src) captions.src = src;
    captions.start = 0;
    captions.sourceIn = cut ? 0 : round(window.start);
    captions.sourceOut = cut ? duration : round(window.end);
  }
  // Workarea quyết định khoảng được export: không đổi thì file ra dài bằng clip cũ.
  const scene = sceneOf(document) as Entity | undefined;
  if (scene?.workarea) scene.workarea = [0, duration];
  // Panel của bố cục chia đôi phủ đúng độ dài clip mới.
  return rebuildLayout(document);
}

/**
 * Kiểu chữ của phụ đề — chung cho MỌI `<captions>` của clip (video, voiceover):
 * người dùng muốn một kiểu phụ đề, không phải mỗi lớp một kiểu. Vị trí
 * (verticalAlign/offset) không thuộc kiểu: phụ đề voiceover overlay cố ý nằm chỗ khác.
 */
export type CaptionStyle = {
  preset: string | null;
  colors: string[] | null;
  color?: string | null;
  fontFamily?: string | null;
  fontWeight?: number | null;
  fontScale?: number | null;
};

const STYLE_KEYS = ['color', 'fontFamily', 'fontWeight', 'fontScale'] as const;

/** Kiểu của `<captions>` (phụ đề video trước); null khi project không có phụ đề. */
export function readCaptionStyle(document: ClipDocument): CaptionStyle | null {
  const all = nodes(document);
  const captions = all.find(isVideoCaptions) ?? all.find((node): node is CaptionsNode => node.kind === 'captions');
  if (!captions) return null;
  const style: CaptionStyle = { preset: captions.preset ?? null, colors: captions.colors ? [...captions.colors] : null };
  for (const key of STYLE_KEYS) if (captions[key] !== undefined) (style as Record<string, unknown>)[key] = captions[key];
  return style;
}

/**
 * Đặt kiểu cho mọi `<captions>` (video và voiceover cùng một kiểu) và CHỈ thế —
 * áp brand không được đè nội dung. `preset`/`colors` luôn ghi; các khoá còn lại
 * chỉ ghi khi có mặt (null = về mặc định của preset, thiếu = giữ nguyên).
 * Project không có phụ đề thì trả nguyên document.
 */
export function writeCaptionStyle(input: ClipDocument, style: CaptionStyle): ClipDocument {
  const document = clone(input);
  const all = nodes(document).filter((node) => node.kind === 'captions') as unknown as Entity[];
  if (!all.length) return input;
  for (const captions of all) {
    assign(captions, 'preset', style.preset ?? undefined);
    assign(captions, 'colors', style.colors?.length ? [...style.colors] : undefined);
    for (const key of STYLE_KEYS) if (key in style) assign(captions, key, style[key] ?? undefined);
  }
  return document;
}


/**
 * Chỗ cắt của video chính theo giây CLIP, kèm J/L-cut đang có (giây; + = L, − = J) —
 * thứ agent cần để gọi `set_audio_roll`. Chưa cắt thì rỗng.
 */
export function cutPoints(document: ClipDocument): { at: number; roll: number }[] {
  const state = readCaptionState(document);
  if (!state?.window) return [];
  const kept = keptRanges(state.window, state.removed);
  if (kept.length < 2) return [];
  const starts = segmentStarts(kept);
  const roll = activeRoll(kept, state.window, readCutRoll(document));
  return kept.slice(1).map((_, offset) => ({ at: starts[offset + 1]!, roll: roll.get(offset + 1) ?? 0 }));
}
