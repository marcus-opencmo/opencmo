/**
 * `@opencmo/clip-render` — vẽ document của clip ra Canvas 2D, cùng một mã trong
 * trình duyệt (preview, chụp khung) và trong Node (export trên Modal, qua
 * `@napi-rs/canvas`). Spec: `docs/specs/2026-09-24-editor-rewrite.md` §4, §7.
 *
 *   const renderer = createRenderer(document, media);   // media biết độ dài nguồn
 *   const frame = renderer.exportFrame(t);                // hoặc frame của playhead
 *   for (const need of renderer.needs(frame)) await host.load(need);
 *   renderer.render(ctx, frame);                          // đồng bộ, tất định
 */

import type { AssetInput, ClipDocument, ClipNode, SceneNode } from '@opencmo/clip-doc';

import { audioClips, audioGain, type AudioClip } from './audio.ts';
import { collectNeeds, drawTree } from './draw.ts';
import { evaluate } from './frame.ts';
/**
 * Giá trị của một track keyframe ở frame CỤC BỘ của node (thời gian nguồn) —
 * cùng hàm renderer dùng. Màu trả về số RGBA đóng gói, không phải chuỗi.
 */
export { sample as sampleTrack } from './frame.ts';
export { builtinLottieName, lottieTime } from './draw.ts';
import { buildTree, FPS, IDENTITY, type Mat, type RNode, type Values } from './tree.ts';
export { toFrames } from './tree.ts';
import type { Measurer } from './text.ts';
export type { Measurer } from './text.ts';
import type { Transcript } from './captions.ts';
export { parseSubtitles, readTranscriptText, subtitleMime, SUBTITLE_TYPES } from './subtitles.ts';
import type { Ctx2D, MediaHost, MediaNeed } from './types.ts';

export type { Ctx2D, Drawable, MediaHost, MediaNeed, MediaResult } from './types.ts';
export { applyTable, bakeTable, colorFunction, colorTable, curveTable, gradeFrame, gradeSteps, GRADE_TYPES, parseCube, scopeStats, type CubeLut, type GradeStep, type ScopeStats } from './grade.ts';
export { FPS, IDENTITY, multiply, type Mat, type Values } from './tree.ts';
export { FONTS, type FontFamily } from './fonts.ts';
export type { Transcript, TranscriptWord } from './captions.ts';
export { captionPresetText } from './captions.ts';
export type { AudioClip } from './audio.ts';

export type RenderOptions = {
  /** Scene cần vẽ: chỉ số hoặc id. Mặc định scene `active`, không có thì scene đầu. */
  scene?: number | string;
  /** Nhân cho blur/offset của bóng khi canvas lớn hơn scene (export độ phân giải khác). */
  shadowScale?: number;
  /**
   * Vẽ phóng theo tỉ lệ này (export 720p/1080p của một scene cỡ khác). Bóng phóng
   * theo cùng tỉ lệ, trừ khi `shadowScale` ghi rõ.
   */
  scale?: number;
};

/** Cỡ bản xuất: cạnh ngắn = `resolution`, hai cạnh làm tròn về số chẵn (H.264). */
export function outputSize(scene: SceneNode, resolution?: number) {
  const short = Math.min(scene.width, scene.height);
  const scale = Math.round(((resolution ?? short) * 1e6) / short) / 1e6;
  return {
    scale,
    width: Math.round((scene.width * scale) / 2) * 2,
    height: Math.round((scene.height * scale) / 2) * 2,
  };
}

export type Renderer = {
  scene: SceneNode;
  /**
   * Frame của scene ứng với giây `t` của BẢN XUẤT: export bắt đầu ở đầu
   * `workarea`, nên t = 0 là `round(workarea[0] · 30)`. Hai phép làm tròn tách
   * riêng như fork, không gộp thành `round((w + t) · 30)`.
   */
  exportFrame(seconds: number): number;
  /** Khung đầu và số khung của bản xuất: `workarea`, kẹp trong độ dài scene. */
  range: { start: number; frames: number };
  /** Độ dài cả scene, frame — playhead của editor đi trong `[0, end)`, không chỉ vùng xuất. */
  end: number;
  needs(frame: number): MediaNeed[];
  render(ctx: Ctx2D, frame: number): void;
  /** Mọi nguồn tiếng của scene, cố định cho cả bản xuất. */
  audio: AudioClip[];
  /** Biên độ của từng clip trong `audio` ở `frame` (cùng thứ tự). */
  gains(frame: number): number[];
  /**
   * Hộp của mọi node ở `frame`, toạ độ scene (không phóng theo `scale`), cha
   * trước con theo thứ tự vẽ. Canvas của editor chọn/kéo/đổi cỡ bằng nó, và op
   * cần hình học (bọc vào scene, bỏ nhóm, nhích) đọc giá trị đang vẽ từ nó.
   */
  layout(frame: number, measurer?: Measurer): LayoutBox[];
};

export type LayoutBox = {
  node: ClipNode;
  parent: ClipNode | null;
  /** Trong khoảng thời gian của nó ở `frame` (và cha nó cũng vậy). */
  visible: boolean;
  /** Ma trận từ khung của node ra toạ độ scene. */
  matrix: Mat;
  /** Ma trận của node trong khung của cha (cái `x`/`y`/xoay/phóng viết ra). */
  local: Mat;
  /** Hộp của node trong khung của chính nó: `[originX, originY, width, height]`. */
  box: [number, number, number, number];
  /** Giá trị đang vẽ (sau keyframe và animation). */
  values: Values;
  start: number;
  end: number;
  /** Frame CỤC BỘ của node ở `frame` (thời gian nguồn) — keyframe đo theo nó. */
  localFrame: number;
  /** Phụ đề: chữ nhóm đang hiện (trước animation chữ); null ở node khác hay khi không ai nói. Xuất SRT/VTT đọc nó. */
  caption: string | null;
};

export function pickScene(document: ClipDocument, which?: number | string): SceneNode {
  const scenes = document.stage.children.filter((node): node is SceneNode => node.kind === 'scene');
  const found =
    typeof which === 'number' ? scenes[which]
    : typeof which === 'string' ? scenes.find((scene) => scene.id === which)
    : (scenes.find((scene) => scene.active) ?? scenes[0]);
  if (!found) throw new Error('document has no scene to render');
  return found;
}

export function createRenderer(document: ClipDocument, media: MediaHost, options: RenderOptions = {}): Renderer {
  const scene = pickScene(document, options.scene);
  const tree = buildTree(scene, media);
  const sceneEnd = tree.end;
  const workStart = Math.max(0, Math.min(sceneEnd, Math.round((scene.workarea?.[0] ?? 0) * FPS)));
  const workEnd = scene.workarea
    ? Math.max(workStart, Math.min(sceneEnd, Math.round(scene.workarea[1] * FPS) || sceneEnd))
    : sceneEnd;
  const exportFrame = (seconds: number) => workStart + Math.max(0, Math.round(seconds * FPS));
  const scale = options.scale ?? 1;
  const view: Mat = [scale, 0, 0, scale, 0, 0];
  const audio = audioClips(tree);
  let evaluated: number | null = null;
  const at = (frame: number, measurer?: Measurer): RNode => {
    if (evaluated !== frame) {
      evaluate(tree, frame, view, measurer, workStart);
      evaluated = frame;
    }
    return tree;
  };
  return {
    scene,
    exportFrame,
    range: { start: workStart, frames: workEnd - workStart },
    end: sceneEnd,
    audio,
    gains(frame) {
      at(frame);
      return audio.map(audioGain);
    },
    needs: (frame) => collectNeeds(at(frame)),
    layout(frame, measurer) {
      evaluate(tree, frame, IDENTITY, measurer, workStart);
      // Lượt vẽ kế tiếp tính lại với khung nhìn của nó.
      evaluated = null;
      const out: LayoutBox[] = [];
      const visit = (r: RNode, shown: boolean) => {
        const visible = shown && r.visible;
        if (r.parent) {
          out.push({
            node: r.node,
            parent: r.parent.node,
            visible,
            matrix: r.worldMatrix,
            local: r.localMatrix,
            // Phụ đề: hộp preset là cố định, chữ thật ngắt dòng/tràn ra ngoài nó. Có
            // measurer thì báo vùng chữ đang hiện, để editor bấm và kéo trúng chỗ
            // người dùng nhìn thấy; khung không có nhóm từ nào thì giữ hộp preset.
            box: r.node.kind === 'captions' && r.layout?.words.length ? r.layout.bounds : [r.originX, r.originY, r.values.width, r.values.height],
            values: { ...r.values },
            start: r.start,
            end: r.end,
            localFrame: r.local,
            caption: r.node.kind === 'captions' && r.caption?.text ? r.caption.text : null,
          });
        }
        for (const child of r.children) visit(child, visible);
      };
      visit(tree, true);
      return out;
    },
    render(ctx, frame) {
      // Chuyển cảnh đánh dấu hai clip đã vẽ lên cây: vẽ lại luôn tính lại từ đầu.
      evaluated = null;
      drawTree({ ctx, media, view, shadowScale: options.shadowScale ?? scale }, at(frame, ctx as unknown as Measurer));
    },
  };
}

/** Thời gian đã giải của một node (frame của scene), cho timeline và op sửa thời gian. */
export type TimeNode = {
  node: ClipNode;
  parent: TimeNode | null;
  children: TimeNode[];
  masks: TimeNode[];
  /** Frame của scene ứng với giây 0 của nguồn node (có thể lẻ). */
  origin: number;
  start: number;
  end: number;
  rate: number;
  /** Group-like không có `end` riêng: bao trọn các con. */
  fits: boolean;
};

/**
 * Cây thời gian của một scene — CÙNG luật với lúc vẽ (`buildTree`), nên timeline
 * đặt clip đúng chỗ preview và export phát nó. Chỉ cần độ dài nguồn và
 * transcript; không cần ảnh hay khung video.
 */
export function resolveTimes(
  scene: SceneNode,
  media: { duration(src: AssetInput): number | null; transcript?(src: string): Transcript | null },
): TimeNode {
  return buildTree(scene, { image: () => null, video: () => null, ...media }) as TimeNode;
}

/** Mọi nguồn media trong document — để nạp độ dài và file trước khi dựng renderer. */
export function mediaSources(
  document: ClipDocument,
): { kind: 'image' | 'video' | 'audio' | 'transcript' | 'lottie' | 'lut'; src: AssetInput }[] {
  const out: { kind: 'image' | 'video' | 'audio' | 'transcript' | 'lottie' | 'lut'; src: AssetInput }[] = [];
  const visit = (node: ClipNode) => {
    if (node.kind === 'captions' && node.src !== undefined) out.push({ kind: 'transcript', src: node.src });
    const record = node as ClipNode & { src?: AssetInput; paints?: { type: string; src?: AssetInput }[] };
    if ((node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') && record.src !== undefined) {
      out.push({ kind: node.kind, src: record.src });
    }
    // `builtin:` là bộ có sẵn, đọc từ thư mục cài đặt — không phải tải.
    if (node.kind === 'lottie' && !(typeof record.src === 'string' && record.src.startsWith('builtin:'))) {
      out.push({ kind: 'lottie', src: record.src! });
    }
    for (const effect of (node as { effects?: { type: string; hidden?: boolean; params?: { src?: string } }[] }).effects ?? []) {
      if (effect.type === 'lut' && !effect.hidden && effect.params?.src) out.push({ kind: 'lut', src: effect.params.src });
    }
    for (const paint of record.paints ?? []) {
      if ((paint.type === 'image' || paint.type === 'video') && paint.src !== undefined) {
        out.push({ kind: paint.type, src: paint.src });
      }
    }
    for (const child of [...((node as { children?: ClipNode[] }).children ?? []), ...((node as { masks?: ClipNode[] }).masks ?? [])]) {
      visit(child);
    }
  };
  document.stage.children.forEach(visit);
  return out;
}
export { censorTranscript, censorWord } from './profanity.ts';
