/**
 * Vẽ một khoảng khung liên tục của bản xuất ra một file H.264 chỉ có hình.
 * Chạy trong worker thread (nhiều đoạn song song) hoặc ngay trong tiến trình
 * chính khi chỉ có một đoạn.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { createCanvas, GlobalFonts, loadImage, LottieAnimation, type Canvas, type Image } from '@napi-rs/canvas';
import { builtinLottieName, createRenderer, FONTS, lottieTime, outputSize, parseCube, type CubeLut, type MediaHost, type Transcript } from '@opencmo/clip-render';

import { VideoFrames } from './decode.ts';
import { jobDocument, sourceKey, type Job } from './job.ts';
import type { Probe } from './probe.ts';

export type SegmentInput = {
  job: Job;
  probes: Record<string, Probe>;
  /** Khung scene đầu tiên và số khung của đoạn — đếm theo khung XUẤT (`fps`). */
  from: number;
  count: number;
  /**
   * Số khung/giây của bản xuất (E2-b, vắng = 30) và khung scene ứng với khung xuất 0.
   * Document luôn theo lưới 30: khung xuất j vẽ ở khung scene `start + j·30/fps` (lẻ được).
   */
  fps?: number;
  start?: number;
  file: string;
  threads: number;
};

let fontsLoaded: string | null = null;

export function registerFonts(dir: string) {
  if (fontsLoaded === dir) return;
  for (const [family, entry] of Object.entries(FONTS)) {
    for (const file of [entry.file, 'italic' in entry ? entry.italic : undefined]) {
      if (file) GlobalFonts.registerFromPath(join(dir, file), family);
    }
  }
  fontsLoaded = dir;
}

/** Mọi thứ chỉ đọc mà renderer cần, dựng giống nhau ở mọi đoạn. */
export async function loadHost(job: Job, probes: Record<string, Probe>) {
  const files = new Map(job.media.map((entry) => [sourceKey(entry.src), entry.file]));
  const transcripts = new Map<string, Transcript>(
    job.transcripts.map((entry) => [entry.src, JSON.parse(readFileSync(entry.file, 'utf8')) as Transcript]),
  );
  const images = new Map<string, Image | 'failed'>();
  const frames = new VideoFrames(
    new Map(
      Object.entries(probes).flatMap(([key, probe]) => {
        const file = files.get(key);
        return file ? [[key, { file, probe }]] : [];
      }),
    ),
  );
  const current = new Map<string, unknown>();
  const luts = new Map<string, CubeLut | 'failed'>();
  const lottie = lottieHost(job, files);
  const host: MediaHost = {
    image: (src) => (images.get(sourceKey(src)) as never) ?? 'failed',
    video: (src, seconds) => (current.get(`${sourceKey(src)}@${seconds}`) as never) ?? 'failed',
    duration: (src) => probes[sourceKey(src)]?.duration ?? null,
    transcript: (src) => transcripts.get(src) ?? null,
    lottie,
    canvas: (width, height) => createCanvas(width, height),
    lut: (src) => {
      if (!luts.has(src)) {
        const file = files.get(sourceKey(src));
        try {
          luts.set(src, file ? parseCube(readFileSync(file, 'utf8')) : 'failed');
        } catch {
          luts.set(src, 'failed');
        }
      }
      return luts.get(src)!;
    },
  };
  const loadImages = async (keys: Iterable<string>) => {
    for (const key of keys) {
      if (images.has(key)) continue;
      const file = files.get(key);
      images.set(key, file ? await loadImage(readFileSync(file)).catch(() => 'failed' as const) : 'failed');
    }
  };
  return { host, frames, current, loadImages };
}

/**
 * Lottie qua Skottie của Skia (`LottieAnimation` của @napi-rs/canvas) — cùng
 * engine với CanvasKit ở preview. Vẽ vào canvas riêng theo cỡ pixel mà renderer
 * xin (không nhoè khi phóng), renderer `drawImage` ngay sau đó. `builtin:<tên>`
 * là bộ có sẵn ở `job.lottie` (`packages/clip-media/lottie`), không phải tải.
 *
 * Hai điều đã đo trên 1.0.9: Skottie chỉ vẽ lên canvas mà trước đó chỉ có
 * `clearRect` (vẽ gì khác trước là mất hình, im lặng), và `getImageData` không
 * thấy kết quả — `drawImage(canvas)` thì thấy. Vì thế canvas riêng, xoá sạch mỗi
 * khung, và test đọc qua `drawImage`. Một canvas mỗi animation: cỡ đổi theo
 * keyframe `scale` thì cấp lại chứ không giữ canvas cho từng cỡ (RAM).
 */
/** Lottie khai báo ảnh ngoài (đường dẫn) thay vì nhúng `data:` — cùng luật `lottie_info` của worker. */
export function hasExternalAssets(text: string): boolean {
  const assets = (JSON.parse(text) as { assets?: unknown }).assets;
  if (assets === undefined || assets === null) return false;
  if (!Array.isArray(assets)) return true;
  return assets.some((asset) => {
    if (!asset || typeof asset !== 'object') return true;
    const { p, e } = asset as { p?: unknown; e?: unknown };
    return p !== undefined && !(e === 1 && typeof p === 'string' && p.startsWith('data:'));
  });
}

export function lottieHost(job: Pick<Job, 'lottie'>, files: Map<string, string>): NonNullable<MediaHost['lottie']> {
  const animations = new Map<string, LottieAnimation | 'failed'>();
  const canvases = new Map<string, Canvas>();
  const fileOf = (key: string) => {
    if (!key.startsWith('builtin:')) return files.get(key);
    const name = builtinLottieName(key);
    return name ? join(job.lottie, `${name}.json`) : undefined;
  };
  return (src, seconds, width, height, loop) => {
    const key = sourceKey(src);
    let animation = animations.get(key);
    if (animation === undefined) {
      const file = fileOf(key);
      try {
        const text = file ? readFileSync(file, 'utf8') : null;
        // Lottie người dùng: tài nguyên NGOÀI (`p` không phải ảnh nhúng `data:`) có thể khiến Skottie
        // đọc file khác trên máy worker rồi vẽ vào video — chỉ nạp file không có tài nguyên ngoài.
        animation = text && !hasExternalAssets(text) ? LottieAnimation.loadFromData(text) : 'failed';
      } catch {
        animation = 'failed';
      }
      animations.set(key, animation);
    }
    if (animation === 'failed') return 'failed';
    const time = lottieTime(seconds, animation.duration, animation.fps, loop);
    let canvas = canvases.get(key);
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = createCanvas(width, height);
      canvases.set(key, canvas);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    animation.seekTime(time);
    animation.render(ctx, { x: 0, y: 0, width, height });
    return canvas as never;
  };
}

/**
 * `canvas.data()` cấp một Buffer native 8 MB mỗi khung 1080×1920 mà V8 không
 * tính vào heap: GC chỉ chạy theo rác JS, nên với cảnh ít JS (Lottie, video)
 * hàng trăm buffer đã ghi xong vẫn nằm chờ — đo 29/09: ~480 MB mỗi đoạn. Gọi GC
 * mỗi `GC_EVERY` khung giữ phần tồn đọng dưới ~15 × 8 MB; mất ~1 ms mỗi lần.
 */
const GC_EVERY = 15;
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

/** `onFrames(n)`: báo thêm n khung đã vẽ + mã hoá — thanh tiến độ Export (02/10). */
export async function renderSegment(input: SegmentInput, onFrames: (count: number) => void = () => {}): Promise<void> {
  const { job, probes } = input;
  registerFonts(job.fonts);
  const document = jobDocument(job);
  const { host, frames, current, loadImages } = await loadHost(job, probes);
  const planner = createRenderer(document, host, { scene: job.scene });
  const size = outputSize(planner.scene, job.resolution);
  const renderer = createRenderer(document, host, { scene: job.scene, scale: size.scale });
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');

  const filters = [job.videoFilter, 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p'].filter(Boolean).join(',');
  const encoder = spawn(
    'ffmpeg',
    [
      '-v', 'error', '-y',
      '-thread_queue_size', '2',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-r', String(input.fps ?? 30), '-i', 'pipe:0',
      '-vf', filters,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(job.crf), '-threads', String(input.threads),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      input.file,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  encoder.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()).length > 8192 && (stderr = stderr.slice(-8192)));
  const exited = once(encoder, 'close');

  try {
    const fps = input.fps ?? 30;
    // 30 fps: khung xuất = khung scene, như trước (không làm tròn lại số nguyên nào).
    const sceneFrame = (index: number) => (fps === 30 ? index : (input.start ?? 0) + Math.round(((index - (input.start ?? 0)) * 30 * 1e6) / fps) / 1e6);
    for (let i = 0; i < input.count; i++) {
      const frame = sceneFrame(input.from + i);
      frames.beginFrame();
      current.clear();
      const needs = renderer.needs(frame);
      await loadImages(needs.filter((need) => need.kind === 'image').map((need) => sourceKey(need.src)));
      for (const need of needs) {
        if (need.kind !== 'video') continue;
        const key = sourceKey(need.src);
        current.set(`${key}@${need.seconds}`, await frames.frame(key, need.seconds));
      }
      renderer.render(ctx, frame);
      if (!encoder.stdin.write(canvas.data())) await once(encoder.stdin, 'drain');
      onFrames(1);
      if (i % GC_EVERY === GC_EVERY - 1) collect();
    }
    encoder.stdin.end();
    const [code] = await exited;
    if (code !== 0) throw new Error(`ffmpeg mã hoá đoạn ${input.from} lỗi (${code}): ${stderr.trim()}`);
  } finally {
    frames.close();
    if (encoder.exitCode === null) encoder.kill('SIGKILL');
  }
}
