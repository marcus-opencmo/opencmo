/**
 * Op trên khung, kiểu phụ đề và từng phần tử của clip — trên document.
 */

import { z } from 'zod';

import { CAPTION_PRESETS, DocumentSchema, type AssetDeclaration, type ClipDocument, type ClipNode } from '@opencmo/clip-doc';
import { FONTS as RENDER_FONTS, type FontFamily } from '@opencmo/clip-render';

import { readCaptionStyle, writeCaptionStyle } from '../captions';
import { MASTER_SRC, assign, byId, clone, isMaster, nodes, sceneOf, type Entity } from '../doc';
import { LAYOUT_ANCHORS, LAYOUT_MODES, layoutDefaults, MIN_RANGE, mergeLayout, readLayout, writeLayout, type LayoutAnchor, type LayoutMode } from '../layout';
import { readFrame, writeFrame, type FrameMode } from '../reframe';
import { round } from '../transcript';
import { aiModel } from '../generate';
import { placeInRow } from '../tracks';
import { OpFailure, type OpContext } from './context';
import { quoteRange } from './visuals';

// ---------------------------------------------------------------------------
// Khung

type SetFrame = { width: number; height: number; mode?: FrameMode };

export const setFrame = {
  name: 'set_frame',
  input: z.object({
    op: z.literal('set_frame'),
    width: z.number().int().min(64).max(7680),
    height: z.number().int().min(64).max(7680),
    mode: z.enum(['fill', 'fit']).optional(),
  }),
  describe: (input: SetFrame) =>
    `Change the frame to ${input.width}×${input.height}${input.mode ? ` (${input.mode})` : ''}`,
  async apply(document: ClipDocument, input: SetFrame, ctx: OpContext) {
    const current = readFrame(document);
    if (!current) throw new OpFailure('This project has no frame to resize.');
    const hasMaster = nodes(document).some(isMaster);
    if (hasMaster && !ctx.master) throw new OpFailure('The clip video is not ready yet. Try again in a moment.');
    const next = { width: input.width, height: input.height, mode: input.mode ?? current.mode };
    if (next.width === current.width && next.height === current.height && next.mode === current.mode) return document;
    try {
      // Không có video người nói (New edit, cảnh đồ hoạ): cỡ master chỉ dùng để đặt hộp video
      // đó — đưa chính khung mới, các lớp khác co giãn theo khung như thường.
      return writeFrame(document, next, ctx.master ?? { width: next.width, height: next.height }, ctx.viewport);
    } catch (error) {
      throw new OpFailure((error as Error).message);
    }
  },
};

// ---------------------------------------------------------------------------
// Cài đặt timeline (E2-b, học Palmier `set_project_settings`)

const FPS_CHOICES = [24, 25, 30, 50, 60] as const;
const QUALITY_EDGE = { '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160 } as const;
type Quality = keyof typeof QUALITY_EDGE;
type SetProjectSettings = { fps?: (typeof FPS_CHOICES)[number]; width?: number; height?: number; aspectRatio?: string; quality?: Quality };

/** Cạnh chẵn: bộ mã hoá H.264 4:2:0 không nhận cạnh lẻ. */
const even = (value: number) => Math.max(64, Math.min(7680, Math.round(value / 2) * 2));

/** Cỡ mới từ `width`/`height`, hoặc `aspectRatio` (giữ cạnh ngắn) và/hoặc `quality` (cạnh ngắn mới). */
export function settingsSize(current: { width: number; height: number }, input: SetProjectSettings): { width: number; height: number } | null {
  if (input.width !== undefined || input.height !== undefined) {
    if (input.width === undefined || input.height === undefined) throw new OpFailure('Give both width and height.');
    if (input.aspectRatio || input.quality) throw new OpFailure('Use width and height, or aspectRatio/quality — not both.');
    return { width: even(input.width), height: even(input.height) };
  }
  if (!input.aspectRatio && !input.quality) return null;
  let ratio = current.width / current.height;
  if (input.aspectRatio) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(input.aspectRatio.trim());
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new OpFailure('aspectRatio looks like "16:9" or "2.39:1".');
    ratio = Number(match[1]) / Number(match[2]);
    if (ratio < 0.2 || ratio > 5) throw new OpFailure('That aspect ratio is too extreme.');
  }
  const short = input.quality ? QUALITY_EDGE[input.quality] : Math.min(current.width, current.height);
  return ratio >= 1 ? { width: even(short * ratio), height: even(short) } : { width: even(short), height: even(short / ratio) };
}

export const setProjectSettings = {
  name: 'set_project_settings',
  input: z.object({
    op: z.literal('set_project_settings'),
    fps: z.union(FPS_CHOICES.map((value) => z.literal(value)) as unknown as [z.ZodLiteral<24>, z.ZodLiteral<25>, ...z.ZodLiteral<number>[]]).optional(),
    width: z.number().int().min(64).max(7680).optional(),
    height: z.number().int().min(64).max(7680).optional(),
    aspectRatio: z.string().max(12).optional(),
    quality: z.enum(['720p', '1080p', '2K', '4K']).optional(),
  }),
  describe: (input: SetProjectSettings) => {
    const parts = [
      input.fps ? `${input.fps} fps` : null,
      input.width && input.height ? `${input.width}×${input.height}` : null,
      input.aspectRatio ?? null,
      input.quality ?? null,
    ].filter(Boolean);
    return `Change the timeline settings${parts.length ? ` (${parts.join(', ')})` : ''}`;
  },
  async apply(document: ClipDocument, input: SetProjectSettings, ctx: OpContext) {
    const scene = sceneOf(document);
    if (!scene) throw new OpFailure('This project has no timeline.');
    const size = settingsSize({ width: scene.width, height: scene.height }, input);
    let next = document;
    if (size && (size.width !== scene.width || size.height !== scene.height)) {
      const frame = readFrame(document);
      // Có video chính: đi đường set_frame (khung bám người nói, hộp video không méo).
      if (frame && ctx.master && nodes(document).some(isMaster)) {
        try {
          next = writeFrame(document, { width: size.width, height: size.height, mode: frame.mode }, ctx.master, ctx.viewport);
        } catch (error) {
          throw new OpFailure((error as Error).message);
        }
      }
      if (next === document) {
        // Timeline không có video chính (timeline trống, cảnh đồ hoạ): chỉ đổi cỡ khung.
        next = clone(document);
        const target = sceneOf(next) as unknown as Entity;
        target.width = size.width;
        target.height = size.height;
      }
    }
    if (input.fps !== undefined) {
      const target = sceneOf(next) as unknown as Entity;
      const current = (target.fps as number | undefined) ?? 30;
      if (current !== input.fps) {
        if (next === document) next = clone(document);
        const edited = sceneOf(next) as unknown as Entity;
        if (input.fps === 30) delete edited.fps;
        else edited.fps = input.fps;
      }
    }
    return next;
  },
};

// ---------------------------------------------------------------------------
// Bố cục người nói + visual (`layout.ts`)

type SetLayout = { op: 'set_layout'; mode: LayoutMode; start?: number; end?: number; ratio?: number; anchor?: LayoutAnchor; quote?: string };

export const setLayout = {
  name: 'set_layout',
  input: z.object({
    op: z.literal('set_layout'),
    /**
     * split-bottom: người nói ở dưới, visual ở trên; split-top ngược lại; visual-only: cảnh visual riêng;
     * pip: visual phủ khung, người nói trong ô bo góc ở một góc; side-by-side: người nói một cột, visual cột kia; full: bỏ.
     */
    mode: z.enum(LAYOUT_MODES),
    start: z.number().finite().min(0).optional(),
    end: z.number().finite().min(0).optional(),
    /** split: phần chiều cao dải người nói (0.3–0.7); pip: cạnh ô theo bề ngang (0.2–0.5); side-by-side: phần bề ngang cột người nói (0.3–0.7). */
    ratio: z.number().min(0.2).max(0.7).optional(),
    /** pip: góc (top-left, top-right, bottom-left, bottom-right); side-by-side: left hoặc right. */
    anchor: z.enum(LAYOUT_ANCHORS).optional(),
    /** Câu người nói mở đầu phần giải thích; thiếu start/end thì bố cục bám theo câu này. */
    quote: z.string().trim().min(2).max(300).optional(),
  }),
  describe: (input: SetLayout) =>
    input.mode === 'full'
      ? 'Show the speaker full frame'
      : input.mode === 'visual-only'
        ? 'Cut away to a visual-only scene'
        : input.mode === 'pip'
          ? `Show the speaker picture-in-picture, ${(input.anchor ?? 'bottom-right').replace('-', ' ')}`
          : input.mode === 'side-by-side'
            ? `Put the speaker side by side with the visual, on the ${input.anchor === 'right' ? 'right' : 'left'}`
            : `Split the frame, speaker ${input.mode === 'split-bottom' ? 'at the bottom' : 'on top'}`,
  async apply(document: ClipDocument, input: SetLayout, ctx?: OpContext) {
    const scene = sceneOf(document);
    if (!scene || !scene.width || !scene.height) throw new OpFailure('This project has no frame to lay out.');
    const workarea = scene.workarea as [number, number] | undefined;
    const duration = workarea?.[1];
    // Chia khung cho cả đoạn giải thích: dài hơn một visual (tới 15 giây).
    const anchored = input.quote && (input.start === undefined || input.end === undefined) ? await quoteRange(document, ctx, input.quote, { min: 3, max: 15 }) : null;
    const start = input.start ?? anchored?.start ?? 0;
    const end = Math.min(input.end ?? anchored?.end ?? duration ?? start, duration ?? Infinity);
    if (!(end - start >= MIN_RANGE)) throw new OpFailure(`A layout needs at least ${MIN_RANGE} seconds inside the clip.`);
    const defaults = layoutDefaults(input.mode);
    const ratio = input.ratio ?? defaults.ratio;
    if (input.mode === 'pip' ? ratio > 0.5 : input.mode !== 'full' && input.mode !== 'visual-only' && ratio < 0.3) {
      throw new OpFailure(input.mode === 'pip' ? 'A picture-in-picture ratio is between 0.2 and 0.5.' : 'This layout ratio is between 0.3 and 0.7.');
    }
    const anchor = input.anchor ?? defaults.anchor;
    if (anchor && input.mode === 'pip' && (anchor === 'left' || anchor === 'right')) throw new OpFailure('Picture-in-picture goes in a corner: top-left, top-right, bottom-left or bottom-right.');
    if (anchor && input.mode === 'side-by-side' && anchor !== 'left' && anchor !== 'right') throw new OpFailure('Side by side puts the speaker on the left or the right.');
    const ranges = mergeLayout(readLayout(document), { start, end, mode: input.mode, ratio, anchor });
    return checked(writeLayout(document, ranges), 'That layout cannot be applied');
  },
};

// ---------------------------------------------------------------------------
// Kiểu phụ đề

/** Bảy preset của `<captions>` — một nguồn ở `@opencmo/clip-doc` (R4). */
export { CAPTION_PRESETS };

const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Colors are hex, like #FFD400.');
type SetCaptionStyle = {
  preset: (typeof CAPTION_PRESETS)[number] | null;
  colors?: string[] | null;
  color?: string | null;
  font?: FontFamily | null;
  weight?: number | null;
  highlight?: 'block' | 'pop' | null;
};

export const setCaptionStyle = {
  name: 'set_caption_style',
  input: z.object({
    op: z.literal('set_caption_style'),
    preset: z.enum(CAPTION_PRESETS).nullable(),
    colors: z.array(color).max(8).nullable().optional(),
    // Áp cho MỌI lớp phụ đề (video + voiceover). Thiếu = giữ nguyên; null = về preset.
    color: color.nullable().optional().describe('Main text color of the captions; null = the preset color.'),
    font: z
      .enum(Object.keys(RENDER_FONTS) as [FontFamily, ...FontFamily[]])
      .nullable()
      .optional()
      .describe('Font family of the captions; null = the preset font.'),
    weight: z.number().int().min(100).max(900).nullable().optional().describe('Font weight 100-900; null = the preset weight.'),
    highlight: z
      .enum(['block', 'pop'])
      .nullable()
      .optional()
      .describe('block = a rounded box in the first accent color behind the word being spoken; pop = the spoken word grows a little and turns the first accent color; null = off.'),
  }),
  // Thẻ duyệt ở trang project đọc câu này: màu phải có mặt, không thì người
  // dùng duyệt một thay đổi họ không thấy hết.
  describe: (input: SetCaptionStyle) => {
    const base = input.preset ? `Use the "${input.preset}" caption style` : 'Reset the caption style';
    const extra = [
      input.colors?.length ? `colors ${input.colors.join(', ')}` : '',
      input.color ? `text ${input.color}` : '',
      input.font ? `font ${input.font}` : '',
      input.weight ? `weight ${input.weight}` : '',
      input.highlight === 'block' ? 'a highlight box on the spoken word' : input.highlight === 'pop' ? 'the spoken word popping in the accent color' : '',
    ].filter(Boolean);
    return extra.length ? `${base} with ${extra.join(', ')}` : base;
  },
  /** Clip không có phụ đề thì không đổi gì, không lỗi: "áp cho mọi clip" gặp clip im lặng là thường. */
  async apply(document: ClipDocument, input: SetCaptionStyle) {
    if (!readCaptionStyle(document)) return document;
    const styled = writeCaptionStyle(document, {
      preset: input.preset,
      colors: input.colors ?? null,
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.font !== undefined ? { fontFamily: input.font } : {}),
      ...(input.weight !== undefined ? { fontWeight: input.weight } : {}),
    });
    if (input.highlight === undefined) return styled;
    const next = clone(styled);
    const visit = (entity: Entity) => {
      if (entity.kind === 'captions') {
        if (input.highlight) entity.highlight = input.highlight;
        else delete entity.highlight;
      }
      for (const key of ['children', 'masks']) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
    };
    for (const node of next.stage.children) visit(node as unknown as Entity);
    return next;
  },
};

// ---------------------------------------------------------------------------
// Scene

function sceneFor(document: ClipDocument) {
  const scene = sceneOf(document);
  if (!scene || !scene.width || !scene.height) throw new OpFailure('This project has no scene to edit.');
  const workarea = scene.workarea;
  return { scene, width: scene.width, height: scene.height, duration: workarea ? workarea[1] : null };
}

/** Thêm một node làm con cuối của scene. */
function append(document: ClipDocument, node: ClipNode): ClipDocument {
  const next = clone(document);
  const scene = sceneOf(next)!;
  scene.children = [...(scene.children ?? []), node];
  return next;
}

// ---------------------------------------------------------------------------
// Media sinh bằng AI

/** Kích thước 1080p của từng tỉ lệ — cùng bảng của ô Generate. */
const GENERATED_SIZE: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
};
const AUDIO_BOX = { width: 500, height: 150 };

type AddGenerated = {
  kind: 'image' | 'video' | 'voice' | 'audio';
  model: string;
  prompt: string;
  seed: number;
  aspect_ratio?: string;
  duration?: number;
  voice?: string;
  start?: number;
  resolution?: string;
  audio?: boolean;
  start_frame?: string;
  end_frame?: string;
  refs?: string[];
  length?: number;
  muted?: boolean;
  fit?: boolean;
  source_video?: string;
  source_start?: number;
  volume?: number;
};

const KIND_NOUNS: Record<AddGenerated['kind'], string> = {
  image: 'an image',
  video: 'a video',
  voice: 'a voice-over',
  audio: 'a sound effect',
};

/** Tên lớp = đầu prompt, cắt ở ranh giới từ trước ký tự thứ 40. */
function layerName(prompt: string): string {
  const label = prompt.replace(/\s+/g, ' ').trim();
  if (label.length <= 40) return label;
  const cut = label.lastIndexOf(' ', 40);
  return `${label.slice(0, cut > 0 ? cut : 40)}…`;
}

/**
 * Chèn một phần tử mà nguồn là khai báo `generate.*` — đúng dạng ô Generate
 * viết ra. Editor phân giải khai báo qua `/api/v1/generations`; cùng spec trong
 * cùng project thì server trả lại lượt đã có, nên op không tạo lượt sinh nào.
 *
 * `agent: false`: Assistant đi qua tool `generate_media` (người dùng duyệt giá
 * trước), không gọi thẳng op này.
 */
export const addGenerated = {
  name: 'add_generated',
  agent: false,
  input: z.object({
    op: z.literal('add_generated'),
    kind: z.enum(['image', 'video', 'voice', 'audio']),
    model: z.string().min(1).max(100),
    prompt: z.string().trim().min(1).max(5000),
    seed: z.number().int().min(0).max(2_147_483_647),
    aspect_ratio: z.enum(Object.keys(GENERATED_SIZE) as [string, ...string[]]).optional(),
    duration: z.number().int().min(1).max(60).optional(),
    voice: z.string().min(1).max(100).optional(),
    start: z.number().finite().min(0).optional(),
    /** Độ phân giải của model (plan Palmier P1). */
    resolution: z.string().min(1).max(20).optional(),
    /** Video: tiếng do model sinh bật/tắt (model có `limits.audio`). */
    audio: z.boolean().optional(),
    /** Đường dẫn thư viện của ảnh AI làm frame đầu / cuối của video. */
    start_frame: z.string().min(1).max(500).optional(),
    end_frame: z.string().min(1).max(500).optional(),
    /** Đường dẫn thư viện của ảnh tham chiếu. */
    refs: z.array(z.string().min(1).max(500)).min(1).max(8).optional(),
    /** Ảnh/video: số giây hiện trên clip (B-roll 1.5–4 s); video vẫn sinh và trả tiền đủ `duration`. */
    length: z.number().finite().min(0.5).max(60).optional(),
    /** Video: tắt tiếng phần tử (B-roll), không đổi spec sinh. */
    muted: z.boolean().optional(),
    /** Video: tua nhanh để CẢ video sinh ra chạy hết trong `length` (AI transition tới đúng frame cuối). */
    fit: z.boolean().optional(),
    /** Model sửa video (G2): đường dẫn thư viện của video nguồn + giây bắt đầu cắt trong file. */
    source_video: z.string().min(1).max(500).optional(),
    source_start: z.number().finite().min(0).optional(),
    /** Âm thanh (G3): âm lượng dB của phần tử — nhạc nền đặt thấp dưới giọng nói. */
    volume: z.number().finite().min(-60).max(12).optional(),
  }),
  describe: (input: AddGenerated) =>
    `Generate ${KIND_NOUNS[input.kind]}: "${input.prompt.length > 40 ? `${input.prompt.slice(0, 40)}…` : input.prompt}"`,
  async apply(document: ClipDocument, input: AddGenerated, ctx: OpContext) {
    const { width, height } = sceneFor(document);
    let src: AssetDeclaration;
    switch (input.kind) {
      case 'image':
        src = {
          generate: 'image',
          prompt: input.prompt,
          model: input.model,
          aspectRatio: input.aspect_ratio ?? '16:9',
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.refs ? { refs: input.refs } : {}),
          seed: input.seed,
        };
        break;
      case 'video':
        src = {
          generate: 'video',
          prompt: input.prompt,
          model: input.model,
          aspectRatio: input.aspect_ratio ?? '16:9',
          duration: input.duration ?? 5,
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.audio !== undefined ? { audio: input.audio } : {}),
          ...(input.start_frame ? { startFrame: input.start_frame } : {}),
          ...(input.end_frame ? { endFrame: input.end_frame } : {}),
          ...(input.refs ? { refs: input.refs } : {}),
          ...(input.source_video ? { sourceVideo: input.source_video, sourceStart: round(input.source_start ?? 0) } : {}),
          seed: input.seed,
        };
        break;
      case 'voice':
        // `generate.voice` không mang model: giọng quyết định model.
        if (!input.voice) throw new OpFailure('Choose a voice.');
        src = { generate: 'voice', prompt: input.prompt, voice: input.voice, seed: input.seed };
        break;
      case 'audio':
        src = { generate: 'audio', prompt: input.prompt, model: input.model, duration: input.duration ?? 5, seed: input.seed };
        break;
    }
    const start = input.start ? { start: round(input.start) } : {};
    // Video/tiếng sinh ra dài đúng `duration` đã trả tiền. Không ghi `end` thì
    // layer rơi về 16 giây mặc định trong lúc chờ (UAT production 29/09: Veo 4s
    // hiện thành layer 16s).
    const paid = input.duration ?? 5;
    const length =
      input.kind === 'video' ? Math.min(paid, input.length ?? paid) : input.kind === 'audio' ? paid : input.kind === 'image' ? (input.length ?? null) : null;
    const timing = length === null ? start : { ...start, end: round((input.start ?? 0) + length) };
    const name = layerName(input.prompt);
    // Hàng cùng làn còn trống (`tracks.ts`); hình nằm dưới chữ/phụ đề — ảnh/video
    // sinh ra thường phủ kín khung, đặt trên cùng là che mất tiêu đề hook.
    if (input.kind === 'voice' || input.kind === 'audio') {
      return placeInRow(document, {
        kind: 'audio',
        name,
        src,
        x: Math.round((width - AUDIO_BOX.width) / 2),
        y: Math.round((height - AUDIO_BOX.height) / 2),
        width: AUDIO_BOX.width,
        height: AUDIO_BOX.height,
        ...timing,
        ...(input.volume !== undefined ? { volume: round(input.volume) } : {}),
      } as ClipNode, ctx);
    }
    // Thu vừa khung, căn giữa — cùng cách ô Generate đặt.
    const size = GENERATED_SIZE[input.aspect_ratio ?? '16:9']!;
    const scale = Math.min(1, width / size.width, height / size.height);
    const boxW = Math.round(size.width * scale);
    const boxH = Math.round(size.height * scale);
    return placeInRow(document, {
      kind: 'rect',
      name,
      keepAspectRatio: true,
      x: Math.round((width - boxW) / 2),
      y: Math.round((height - boxH) / 2),
      width: boxW,
      height: boxH,
      ...timing,
      ...(input.kind === 'video' && input.muted ? { muted: true } : {}),
      ...(input.kind === 'video' && input.fit && length !== null && length < paid ? { playbackRate: round(paid / length) } : {}),
      paints: [{ type: input.kind, src }],
    } as ClipNode, ctx);
  },
};

type Regenerate = { op: 'regenerate'; element_id: string; seed: number };

/** Khai báo `generate.*` của CHÍNH phần tử (`src` của nó, `src` của paint) — không xét con. */
function ownGenerated(entity: Entity): Entity[] {
  const sources = [entity.src, ...((entity.paints as Entity[] | undefined) ?? []).map((paint) => paint.src)];
  return sources.filter((src): src is Entity => !!src && typeof src === 'object' && typeof (src as Entity).generate === 'string');
}

/**
 * Sinh lại phần tử AI với seed mới (G1, menu chuột phải — "Rerun" của Palmier). Khai báo đổi
 * seed = khoá mới = một lượt sinh mới; file cũ vẫn ở thư viện. Không cho agent gọi thẳng: tốn
 * credit mà không qua thẻ duyệt giá (người dùng thấy giá trên mục menu).
 */
export const regenerate = {
  name: 'regenerate',
  agent: false,
  input: z.object({
    op: z.literal('regenerate'),
    element_id: z.string().min(1),
    seed: z.number().int().min(0).max(2_147_483_647),
  }),
  describe: () => 'Regenerate',
  async apply(document: ClipDocument, input: Regenerate) {
    const next = clone(document);
    const found = byId(next, input.element_id);
    if (!found) throw new OpFailure('That element is no longer in the project.');
    const declarations = ownGenerated(found.entity);
    if (!declarations.length) throw new OpFailure('Only AI-generated media can be regenerated.');
    for (const declaration of declarations) declaration.seed = input.seed;
    return next;
  },
};

type EnhanceGenerated = { op: 'enhance_generated'; element_id: string; resolution: string };

/**
 * Nháp rẻ → bản đẹp (G4, "Draft → Enhance" của Palmier): cùng prompt, CÙNG seed, cùng frame
 * đầu/cuối, chỉ nâng `resolution`. Khoá đổi = lượt sinh mới, bản nháp ở lại thư viện. Model không
 * hứa chuyển động giống hệt, chỉ gần. Agent không gọi thẳng: tốn credit, giá nằm trên mục menu.
 */
export const enhanceGenerated = {
  name: 'enhance_generated',
  agent: false,
  input: z.object({
    op: z.literal('enhance_generated'),
    element_id: z.string().min(1),
    resolution: z.string().min(1).max(20),
  }),
  describe: (input: EnhanceGenerated) => `Enhance to ${input.resolution}`,
  async apply(document: ClipDocument, input: EnhanceGenerated) {
    const next = clone(document);
    const found = byId(next, input.element_id);
    if (!found) throw new OpFailure('That element is no longer in the project.');
    const videos = ownGenerated(found.entity).filter((declaration) => declaration.generate === 'video');
    if (!videos.length) throw new OpFailure('Only AI-generated videos can be enhanced.');
    for (const declaration of videos) {
      const resolutions = aiModel(String(declaration.model))?.limits.resolutions ?? [];
      const from = resolutions.indexOf(String(declaration.resolution ?? resolutions[0] ?? ''));
      const to = resolutions.indexOf(input.resolution);
      if (to < 0 || to <= from) throw new OpFailure(`This video cannot be enhanced to ${input.resolution}.`);
      declaration.resolution = input.resolution;
    }
    return next;
  },
};

// ---------------------------------------------------------------------------
// Chữ

/** Họ font tự host dưới `/fonts` (CSP `font-src 'self'`): font khác không nạp được. Một nguồn: `clip-render`. */
export const FONTS = Object.keys(RENDER_FONTS) as [FontFamily, ...FontFamily[]];

type AddText = {
  text: string;
  start: number;
  end: number;
  y?: number;
  size?: number;
  color?: string;
  bold?: boolean;
  font?: (typeof FONTS)[number];
};

export const addText = {
  name: 'add_text',
  input: z
    .object({
      op: z.literal('add_text'),
      text: z.string().trim().min(1).max(300),
      start: z.number().finite().min(0),
      end: z.number().finite().min(0),
      /** Tâm dọc, chuẩn hoá 0–1 theo chiều cao khung. */
      y: z.number().min(0).max(1).optional(),
      size: z.number().min(8).max(400).optional(),
      color: color.optional(),
      bold: z.boolean().optional(),
      font: z.enum(FONTS).optional(),
    })
    .refine((input) => input.end > input.start, 'The text must end after it starts.'),
  describe: (input: AddText) => `Add the text "${input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text}"`,
  /**
   * Cùng dạng chữ mà bộ sinh project viết: hộp lấy trọn bề ngang và canh giữa,
   * cao gấp ba cỡ chữ — thiếu `height` thì `textAlign` không có tác dụng.
   */
  async apply(document: ClipDocument, input: AddText) {
    const scene = sceneFor(document);
    const end = round(scene.duration === null ? input.end : Math.min(input.end, scene.duration));
    const start = round(input.start);
    if (end <= start) throw new OpFailure('The text starts after the clip ends.');
    const size = Math.round(input.size ?? Math.round(scene.width / 15));
    const height = size * 3;
    const center = (input.y ?? 0.2) * scene.height;
    return append(document, {
      kind: 'text',
      y: Math.round(Math.min(Math.max(center - height / 2, 0), scene.height - height)),
      width: scene.width,
      height,
      textAlign: 'center',
      textBaseline: 'middle',
      color: input.color ?? '#FFFFFF',
      fontFamily: input.font ?? 'Inter',
      fontWeight: input.bold === false ? 400 : 700,
      fontSize: size,
      start,
      end,
      text: input.text.trim(),
    });
  },
};

// ---------------------------------------------------------------------------
// Phần tử

function elementById(document: ClipDocument, id: string) {
  const found = byId(document, id);
  if (!found) throw new OpFailure(`There is no element "${id}" in this project.`);
  return found;
}

const isMasterEntity = (tag: string, entity: Entity): boolean => (tag === 'video' || tag === 'audio') && entity.src === MASTER_SRC;

/**
 * Prop không op nào được ghi qua `update_element`: danh tính của phần tử, và
 * thứ đã có op riêng giữ bất biến — cửa sổ nguồn của video master (cắt bằng
 * chữ), khung của scene (`set_frame`), nguồn của phụ đề (panel transcript).
 */
export function guardProps(tag: string, entity: Entity, names: string[]): void {
  for (const prop of names) {
    if (['id', 'kind', 'type', '__source', 'key', 'ref', 'children', 'masks', 'marks'].includes(prop) || /^on[A-Z]/.test(prop)) {
      throw new OpFailure(`The "${prop}" property cannot be changed.`);
    }
    if (isMasterEntity(tag, entity) && ['src', 'sourceIn', 'sourceOut', 'start'].includes(prop)) {
      throw new OpFailure('Cut the clip from the transcript instead of changing its video timing.');
    }
    if (tag === 'scene' && ['width', 'height'].includes(prop)) {
      throw new OpFailure('Use set_frame to change the frame size.');
    }
    if (tag === 'captions' && ['src', 'sourceIn', 'sourceOut'].includes(prop)) {
      throw new OpFailure('Edit the captions from the transcript instead.');
    }
  }
}

const propValue = z.union([
  z.number().finite(),
  z.string().max(2_000),
  z.boolean(),
  z.null(),
  z.array(z.union([z.number().finite(), z.string().max(200)])).max(64),
]);

type PropValue = z.infer<typeof propValue>;
type UpdateElement = { element_id: string; props?: Record<string, PropValue>; text?: string };

/** Số lưu với hai chữ số thập phân, như lúc người dùng kéo một slider trên canvas. */
const settle = (value: PropValue): unknown =>
  typeof value === 'number'
    ? Math.round(value * 100) / 100
    : Array.isArray(value)
      ? value.map((item) => (typeof item === 'number' ? Math.round(item * 100) / 100 : item))
      : value;

/** Document còn đúng schema sau lượt sửa: prop lạ hay giá trị sai kiểu bị từ chối ngay. */
export function checked(document: ClipDocument, message: string): ClipDocument {
  const parsed = DocumentSchema.safeParse(document);
  if (parsed.success) return document;
  // Prop lạ nằm trong lỗi `unrecognized_keys`, có khi lồng trong lỗi của union.
  type Issue = { code?: string; keys?: string[]; path?: PropertyKey[]; errors?: Issue[][] };
  const find = (issues: Issue[]): string | null => {
    for (const issue of issues) {
      if (issue.code === 'unrecognized_keys' && issue.keys?.[0]) return issue.keys[0];
      for (const branch of issue.errors ?? []) {
        const inner = find(branch);
        if (inner) return inner;
      }
    }
    const last = issues[0]?.path?.at(-1);
    return typeof last === 'string' ? last : null;
  };
  const where = find(parsed.error.issues as Issue[]);
  throw new OpFailure(where ? `${message} ("${where}" is not accepted there).` : `${message}.`);
}

export const updateElement = {
  name: 'update_element',
  input: z
    .object({
      op: z.literal('update_element'),
      element_id: z.string().min(1).max(64),
      props: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), propValue).optional(),
      text: z.string().max(300).optional(),
    })
    .refine((input) => Object.keys(input.props ?? {}).length > 0 || input.text !== undefined, 'Nothing to change.'),
  describe: (input: UpdateElement) =>
    input.text !== undefined ? `Change the text to "${input.text}"` : `Change ${Object.keys(input.props ?? {}).join(', ')}`,
  async apply(document: ClipDocument, input: UpdateElement) {
    const next = clone(document);
    const { entity, tag } = elementById(next, input.element_id);
    guardProps(tag, entity, Object.keys(input.props ?? {}));
    if (input.text !== undefined && tag !== 'text') throw new OpFailure('Only text elements have words to change.');
    for (const [key, value] of Object.entries(input.props ?? {})) {
      // `false` và `null` là không có prop: boolean vắng mặt đọc là false, và
      // `null` không phải giá trị document nào nhận.
      assign(entity, key, value === false || value === null ? undefined : settle(value));
    }
    if (input.text !== undefined) entity.text = input.text;
    return checked(next, 'That element could not be changed');
  },
};

/** Phần tử (hoặc một phần tử con của nó) dùng video master làm nguồn. */
function holdsMaster(entity: Entity): boolean {
  if (entity.src === MASTER_SRC) return true;
  for (const [key, value] of Object.entries(entity)) {
    if (key === 'marks') continue;
    const items = Array.isArray(value) ? value : [value];
    if (items.some((item) => item && typeof item === 'object' && holdsMaster(item as Entity))) return true;
  }
  return false;
}

export const deleteElement = {
  name: 'delete_element',
  input: z.object({ op: z.literal('delete_element'), element_id: z.string().min(1).max(64) }),
  describe: () => 'Delete an element',
  async apply(document: ClipDocument, input: { element_id: string }) {
    const next = clone(document);
    const { entity, tag, list, parent } = elementById(next, input.element_id);
    if (tag === 'stage' || tag === 'scene' || holdsMaster(entity)) throw new OpFailure('The clip video cannot be deleted.');
    list!.splice(list!.indexOf(entity), 1);
    // Mảng thành phần phụ rỗng là không có thành phần phụ nào.
    if (!list!.length && parent) {
      for (const [key, value] of Object.entries(parent)) {
        if (value === list && key !== 'children') delete parent[key];
      }
    }
    return checked(next, 'That element could not be deleted');
  },
};
