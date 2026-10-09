/**
 * Tool tab của Assistant (`capture`, `media_grab`, `media_waveform`) chạy
 * trong Node cho eval — cùng clip-render với editor và export, khung video lấy
 * bằng ffmpeg (`-ss` trước `-i`, một frame). Không dùng trong app.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import type { ClipDocument } from "@opencmo/clip-doc";
import { createRenderer, FONTS, scopeStats, type MediaHost, type Transcript } from "@opencmo/clip-render";

const run = promisify(execFile);

export type NodeMedia = {
  /** Đường dẫn thư viện → file trên đĩa. */
  files: Record<string, string>;
  durations: Record<string, number>;
  transcripts: Map<string, Transcript>;
  fontsDir: string;
};

let fonts: string | null = null;
function registerFonts(dir: string) {
  if (fonts === dir) return;
  for (const [family, entry] of Object.entries(FONTS)) {
    for (const file of [entry.file, "italic" in entry ? entry.italic : undefined]) {
      if (file) GlobalFonts.registerFromPath(join(dir, file), family);
    }
  }
  fonts = dir;
}

async function frameAt(file: string, seconds: number): Promise<Image | null> {
  try {
    const { stdout } = await run(
      "ffmpeg",
      ["-v", "error", "-ss", String(Math.max(0, seconds)), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.length ? await loadImage(stdout) : null;
  } catch {
    return null;
  }
}

const stamp = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

function sheet(cells: { canvas: Canvas; label: string }[]): string {
  const count = cells.length;
  const columns = count <= 4 ? count : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  const { width, height } = cells[0]!.canvas;
  const gap = 4;
  const out = createCanvas(columns * width + (columns - 1) * gap, rows * height + (rows - 1) * gap);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#202020";
  ctx.fillRect(0, 0, out.width, out.height);
  const font = Math.max(12, Math.round(Math.min(width, height) / 12));
  cells.forEach((cell, index) => {
    const x = (index % columns) * (width + gap);
    const y = Math.floor(index / columns) * (height + gap);
    ctx.drawImage(cell.canvas, x, y);
    ctx.font = `600 ${font}px sans-serif`;
    const pad = Math.round(font / 3);
    const w = ctx.measureText(cell.label).width + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x, y, w, font + pad * 2);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    ctx.fillText(cell.label, x + pad, y + pad);
  });
  return out.toBuffer("image/jpeg", 80).toString("base64");
}

/** `capture` như editor: giây trên timeline bản xuất, ≤12 ô một sheet. */
export async function nodeCapture(
  document: ClipDocument,
  media: NodeMedia,
  input: { times?: number[]; start?: number; end?: number; count?: number; separate?: boolean },
): Promise<{ images: string[]; data: unknown }> {
  registerFonts(media.fontsDir);
  const current = new Map<string, Image | null>();
  const host: MediaHost = {
    image: () => "failed",
    video: (src, seconds) => (typeof src === "string" ? (current.get(`${src}@${seconds}`) ?? "failed") : "failed") as never,
    duration: (src) => (typeof src === "string" ? (media.durations[src] ?? null) : null),
    transcript: (src) => media.transcripts.get(src) ?? null,
    canvas: (width, height) => createCanvas(width, height),
  };
  const probe = createRenderer(document, host);
  const length = probe.range.frames / 30;
  let times = input.times?.slice(0, 12);
  if (!times?.length) {
    const start = Math.max(0, input.start ?? 0);
    const end = Math.min(length, input.end ?? length);
    const count = Math.max(1, Math.min(12, input.count ?? 6));
    times = Array.from({ length: count }, (_, index) => Math.round((start + ((end - start) * (index + 0.5)) / count) * 100) / 100);
  }
  const separate = Boolean(input.separate) || times.length === 1;
  if (separate) times = times.slice(0, 4);
  const edge = separate ? 768 : 360;
  const scale = edge / Math.max(probe.scene.width, probe.scene.height);
  const renderer = createRenderer(document, host, { scale });
  const cells: { canvas: Canvas; label: string }[] = [];
  for (const time of times) {
    const frame = renderer.exportFrame(time);
    current.clear();
    for (const need of renderer.needs(frame)) {
      if (need.kind !== "video" || typeof need.src !== "string") continue;
      const file = media.files[need.src];
      current.set(`${need.src}@${need.seconds}`, file ? await frameAt(file, need.seconds) : null);
    }
    const canvas = createCanvas(Math.round(probe.scene.width * scale), Math.round(probe.scene.height * scale));
    renderer.render(canvas.getContext("2d") as never, frame);
    cells.push({ canvas, label: stamp(time) });
  }
  const images = separate ? cells.map((cell) => cell.canvas.toBuffer("image/jpeg", 80).toString("base64")) : [sheet(cells)];
  return { images, data: { times, length: Math.round(length * 100) / 100 } };
}

/** `inspect_color` trong eval: số liệu màu cả khung (không bỏ chữ, không đo theo lớp). */
export async function nodeInspectColor(document: ClipDocument, media: NodeMedia, input: { time?: number }): Promise<{ data: unknown }> {
  const shot = await nodeCapture(document, media, { times: [input.time ?? 0], separate: true });
  const image = await loadImage(Buffer.from(shot.images[0]!, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { data: { time: input.time ?? 0, ...scopeStats(ctx.getImageData(0, 0, image.width, image.height).data) } };
}

/** `media_grab`: khung trong một file thư viện, theo giây của file. */
export async function nodeGrab(media: NodeMedia, input: { path: string; times?: number[]; count?: number }): Promise<{ images: string[]; data: unknown } | { error: string }> {
  const file = media.files[input.path];
  if (!file) return { error: `"${input.path}" is not available on this device.` };
  const duration = media.durations[input.path] ?? 5;
  const count = Math.min(12, Math.max(1, input.count ?? 6));
  const times = input.times?.length ? input.times.slice(0, 12) : Array.from({ length: count }, (_, index) => Math.round(((duration * (index + 0.5)) / count) * 100) / 100);
  const cells: { canvas: Canvas; label: string }[] = [];
  for (const time of times) {
    const image = await frameAt(file, time);
    if (!image) continue;
    const scale = 360 / Math.max(image.width, image.height);
    const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    cells.push({ canvas, label: stamp(time) });
  }
  if (!cells.length) return { error: "No frames could be read." };
  return { images: [sheet(cells)], data: { times, duration } };
}

/** `media_waveform`: mức dB thô + khoảng lặng, giây của file (PCM 8 kHz qua ffmpeg). */
export async function nodeWaveform(
  media: NodeMedia,
  input: { path?: string; start?: number; end?: number; threshold_db?: number; min_silence?: number },
  master: string,
  window: { start: number; end: number } | null,
): Promise<{ data: unknown } | { error: string }> {
  const src = input.path ?? master;
  const file = media.files[src];
  if (!file) return { error: `No sound could be read from "${src}".` };
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const rate = 100;
  const step = 80;
  const peaks = new Float32Array(Math.ceil(samples.length / step));
  for (let bucket = 0; bucket < peaks.length; bucket++) {
    let peak = 0;
    for (let index = bucket * step; index < Math.min(samples.length, (bucket + 1) * step); index++) peak = Math.max(peak, Math.abs(samples[index]!) / 32768);
    peaks[bucket] = peak;
  }
  const total = peaks.length / rate;
  const start = Math.max(0, input.start ?? (input.path ? 0 : (window?.start ?? 0)));
  const end = Math.min(total, input.end ?? (input.path ? total : (window?.end ?? total)));
  const threshold = input.threshold_db ?? -35;
  const minSilence = input.min_silence ?? 0.4;
  const db = (value: number) => (value > 0 ? 20 * Math.log10(value) : -120);
  const silences: { start: number; end: number }[] = [];
  let quietFrom: number | null = null;
  for (let index = Math.floor(start * rate); index <= Math.ceil(end * rate); index++) {
    const quiet = index < end * rate && db(peaks[index] ?? 0) < threshold;
    if (quiet && quietFrom === null) quietFrom = index;
    if (!quiet && quietFrom !== null) {
      if ((index - quietFrom) / rate >= minSilence) silences.push({ start: quietFrom / rate, end: index / rate });
      quietFrom = null;
    }
  }
  return { data: { path: src, start, end, threshold_db: threshold, silences } };
}

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/**
 * preview_3d trong Node (spec code-scenes): cùng runtime với sandbox của editor,
 * vẽ trong Chromium headless (SwiftShader). Cần CHROMIUM_PATH như test clip-three.
 */
export async function nodePreview3d(input: { code: string; duration: number; aspect_ratio: string; theme?: string; seed?: number }): Promise<{ images: string[]; data: unknown } | { error: string }> {
  const { frameSize } = await import("@opencmo/clip-three");
  // Chỉ eval (Node) dùng: import động theo chuỗi để typecheck của web không kéo
  // cả renderer (Chromium, font brand) vào — kiểu khai báo tại chỗ.
  type CodeStills =
    | { ok: true; images: string[]; reports: { t: number; issues: string[]; coverage: number }[]; msPerFrame: number; triangles: number }
    | { ok: false; phase: string; message: string; at?: number };
  const renderModule = "@opencmo/clip-three/render";
  const { renderCodeStills } = (await import(renderModule)) as {
    renderCodeStills: (input: Record<string, unknown>, times: number[]) => Promise<CodeStills>;
  };
  const full = frameSize(input.aspect_ratio);
  const even = (value: number) => Math.max(64, Math.round(value / 4) * 2);
  const times = [0.15, 0.45, 0.75].map((f) => Math.round(input.duration * f * 100) / 100).concat(Math.round((input.duration - 0.05) * 100) / 100);
  try {
    const result = await renderCodeStills(
      { code: input.code, width: even(full.width), height: even(full.height), duration: input.duration, ...(input.theme ? { theme: input.theme as never } : {}), ...(input.seed === undefined ? {} : { seed: input.seed }) },
      times,
    );
    if (!result.ok) return { error: `The scene code failed (${result.phase}${result.at === undefined ? "" : ` at ${result.at}s`}): ${result.message}`.slice(0, 300) };
    return {
      images: result.images.map((url) => url.slice(url.indexOf(",") + 1)),
      data: { times, layout: result.reports.map((report) => ({ t: report.t, coverage: report.coverage, issues: report.issues })), ms_per_frame: Math.round(result.msPerFrame), triangles: result.triangles },
    };
  } catch (error) {
    return { error: `The 3D preview could not run here: ${(error as Error).message}`.slice(0, 300) };
  }
}
