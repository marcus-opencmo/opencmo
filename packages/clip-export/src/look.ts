/**
 * Look at a clip on the server (editor-MCP plan, item 1): the frames the in-app Assistant gets
 * from its browser tools (`apps/web/components/editor/assistant/capture.ts`), drawn here by the
 * same renderer the export uses, so Claude over MCP sees exactly what will be exported.
 *
 * - `capture`: frames at export-timeline seconds as one contact sheet (timecode per cell, the
 *   0.25/0.5/0.75 guides), plus the visible layers per frame, top first, with id and 0-1 box.
 * - `inspect_color`: colour numbers of one frame without text or captions (`scopeStats`).
 * - `grab`: frames inside a library video or image, as a sheet (ffmpeg, no renderer).
 * - `frame`: one large frame without text or captions, for `save_frame` (an image model would
 *   redraw any text it sees, garbled).
 * - `stills` (`stillsJob`): one full-size PNG per slide with its text, written to disk for `render_stills`.
 *
 * Only the asked frames are decoded and drawn; nothing is encoded to video. Same inputs and
 * output shape as the browser tools; the rules both share (times, visible layers, text removal,
 * colour guide) live once in `@opencmo/clip-render` (`look.ts`).
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { MAX_SLIDES, slideSpans, validate, type ClipDocument } from '@opencmo/clip-doc';
import { captureTimes, COLOR_GUIDE, createRenderer, FPS, MAX_LOOK_TIMES, mediaSources, outputSize, pickScene, scopeStats, visibleAt, withoutText, type LookBox, type MediaHost } from '@opencmo/clip-render';
import { z } from 'zod';

import { userInput } from './inputs.ts';
import { JobSchema, sourceKey } from './job.ts';
import { probe, type Probe } from './probe.ts';
import { loadHost, registerFonts } from './segment.ts';

const run = promisify(execFile);

/** Long edge of one sheet cell: 12 portrait cells come out near 800×1100, readable and small. */
const CELL_EDGE = 360;
const COLOR_EDGE = 512;
export const MAX_TIMES = MAX_LOOK_TIMES;
export { captureTimes, withoutText };

export const LookSchema = JobSchema.pick({ document: true, media: true, transcripts: true, fonts: true, scene: true }).extend({
  op: z.enum(['capture', 'inspect_color', 'grab', 'frame']),
  times: z.array(z.number().min(0)).max(MAX_TIMES).optional(),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  count: z.number().int().min(1).max(MAX_TIMES).optional(),
  grid: z.boolean().optional(),
  time: z.number().min(0).optional(),
  /** `frame`: long edge in pixels (the in-app save_frame asks 1280). */
  edge: z.number().int().min(256).max(1920).optional(),
  element_id: z.string().max(200).optional(),
  /** `grab`: the downloaded library file and its seconds. */
  file: z.string().min(1).optional(),
});
export type LookJob = z.infer<typeof LookSchema>;
export type LookResult = { images: string[]; data: Record<string, unknown> } | { error: string };

const stamp = (seconds: number): string => {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

const jpeg = (canvas: Canvas) => canvas.encodeSync('jpeg', 80).toString('base64');

/** Equal cells into one sheet, a timecode at each cell's top left (captions sit at the bottom). */
function sheet(cells: { canvas: Canvas; label: string }[]): Canvas {
  const count = cells.length;
  const columns = count <= 4 ? count : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  const { width, height } = cells[0]!.canvas;
  const gap = 4;
  const out = createCanvas(columns * width + (columns - 1) * gap, rows * height + (rows - 1) * gap);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, out.width, out.height);
  const font = Math.max(12, Math.round(Math.min(width, height) / 12));
  cells.forEach((cell, index) => {
    const x = (index % columns) * (width + gap);
    const y = Math.floor(index / columns) * (height + gap);
    ctx.drawImage(cell.canvas, x, y);
    ctx.font = `600 ${font}px sans-serif`;
    const pad = Math.round(font / 3);
    const w = ctx.measureText(cell.label).width + pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x, y, w, font + pad * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(cell.label, x + pad, y + pad);
  });
  return out;
}

/** The 0-1 guides add_shape and add_text take, drawn on a clean copy of the cell. */
function withGrid(source: Canvas): Canvas {
  const canvas = createCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const { width, height } = canvas;
  const font = Math.max(9, Math.round(Math.min(width, height) / 30));
  ctx.lineWidth = 1;
  ctx.font = `600 ${font}px sans-serif`;
  ctx.textBaseline = 'top';
  for (const t of [0.25, 0.5, 0.75]) {
    ctx.strokeStyle = t === 0.5 ? 'rgba(0,255,255,0.45)' : 'rgba(0,255,255,0.28)';
    const x = Math.round(t * width) + 0.5;
    const y = Math.round(t * height) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const label = String(t);
    const w = ctx.measureText(label).width + 4;
    const top = Math.round(Math.min(width, height) / 12) * 2;
    ctx.fillRect(x + 1, top, w, font + 2);
    ctx.fillRect(width - w - 1, y + 1, w, font + 2);
    ctx.fillStyle = 'rgba(0,255,255,0.95)';
    ctx.fillText(label, x + 3, top + 1);
    ctx.fillText(label, width - w + 1, y + 2);
  }
  return canvas;
}

type DrawJob = Pick<LookJob, 'media' | 'transcripts' | 'fonts' | 'scene'>;

async function probesOf(job: DrawJob, document: ClipDocument): Promise<Record<string, Probe>> {
  const files = new Map(job.media.map((entry) => [sourceKey(entry.src), entry.file]));
  const wanted = new Map<string, string>();
  for (const { kind, src } of mediaSources(document)) {
    if (kind !== 'video' && kind !== 'audio') continue;
    const key = sourceKey(src);
    const file = files.get(key);
    if (file) wanted.set(key, file);
  }
  // In parallel: each probe of a signed URL is a network round trip.
  const entries = await Promise.all([...wanted].map(async ([key, file]) => [key, await probe(file)] as const));
  return Object.fromEntries(entries);
}

/**
 * Draws the frames `pick` chooses from the export length (seconds), each into its own canvas of
 * long edge `edge`, with the layer boxes. With `sink`, each frame goes there and is not kept: a
 * still set can be 35 full-size canvases.
 */
async function drawFrames(job: DrawJob, document: ClipDocument, pick: (length: number) => number[], edge: number, sink?: (canvas: Canvas, index: number) => void) {
  registerFonts(job.fonts);
  const probes = await probesOf(job, document);
  const full = { ...job, document, out: '/dev/null', resolution: 1080 as const, crf: 18 };
  const { host, frames, current, loadImages } = await loadHost(full, probes);
  const scene = pickScene(document, job.scene);
  const scale = edge / Math.max(scene.width, scene.height);
  const renderer = createRenderer(document, host as MediaHost, { scene: job.scene, scale });
  // `range` counts timeline frames at FPS; the scene's own rate only sets the export's frame grid.
  const length = renderer.range.frames / FPS;
  // Clamped in timeline frames: `exportFrame` rounds on the 30 fps grid whatever the scene's rate.
  const last = renderer.range.start + Math.max(0, renderer.range.frames - 1);
  const seconds = pick(length);
  const width = Math.round(scene.width * scale);
  const height = Math.round(scene.height * scale);
  const drawn: { time: number; canvas: Canvas; layers: ReturnType<typeof visibleAt> }[] = [];
  try {
    for (const [index, time] of seconds.entries()) {
      const frame = Math.min(last, renderer.exportFrame(Math.max(0, time)));
      frames.beginFrame();
      current.clear();
      const needs = renderer.needs(frame);
      await loadImages(needs.filter((need) => need.kind === 'image').map((need) => sourceKey(need.src)));
      for (const need of needs) {
        if (need.kind !== 'video') continue;
        const key = sourceKey(need.src);
        current.set(`${key}@${need.seconds}`, await frames.frame(key, need.seconds));
      }
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      renderer.render(ctx as never, frame);
      if (sink) {
        sink(canvas, index);
        continue;
      }
      drawn.push({ time, canvas, layers: visibleAt(renderer.layout(frame, ctx as never) as unknown as LookBox[], frame, scene) });
    }
  } finally {
    frames.close();
  }
  return { drawn, length, times: seconds };
}

async function capture(job: LookJob): Promise<LookResult> {
  const document = validate(job.document);
  const { drawn, length, times } = await drawFrames(job, document, (total) => captureTimes(job, total), CELL_EDGE);
  const grid = job.grid !== false;
  const cells = drawn.map((item) => ({ canvas: grid ? withGrid(item.canvas) : item.canvas, label: stamp(item.time) }));
  return {
    images: [jpeg(sheet(cells))],
    data: {
      times,
      length: Math.round(length * 100) / 100,
      ...(grid ? { grid: 'Cyan lines mark 0.25, 0.5 and 0.75 of the frame (x from the left, y from the top) — the same 0-1 coordinates add_shape, add_text and region take.' } : {}),
      layers: drawn.map((item) => ({ time: item.time, visible: item.layers })),
    },
  };
}

async function inspectColor(job: LookJob): Promise<LookResult> {
  const document = withoutText(validate(job.document));
  const time = job.time ?? 0;
  const { drawn } = await drawFrames(job, document, () => [time], COLOR_EDGE);
  const item = drawn[0]!;
  const { width, height } = item.canvas;
  let region = [0, 0, 1, 1];
  if (job.element_id) {
    const layer = item.layers.find((entry) => entry.id === job.element_id);
    if (!layer) return { error: `"${job.element_id}" is not visible at ${stamp(time)}. Pick a time when it is on screen (capture_frame lists visible layers).` };
    region = layer.box;
  }
  const x = Math.floor(region[0]! * width);
  const y = Math.floor(region[1]! * height);
  const w = Math.max(1, Math.ceil(region[2]! * width) - x);
  const h = Math.max(1, Math.ceil(region[3]! * height) - y);
  const stats = scopeStats(item.canvas.getContext('2d').getImageData(x, y, w, h).data as unknown as Uint8ClampedArray);
  return { images: [], data: { time: Math.round(time * 100) / 100, ...(job.element_id ? { element_id: job.element_id, box: region } : {}), ...stats, guide: COLOR_GUIDE } };
}

async function frame(job: LookJob): Promise<LookResult> {
  const time = job.time ?? 0;
  const { drawn } = await drawFrames(job, withoutText(validate(job.document)), () => [time], job.edge ?? 1280);
  const item = drawn[0]!;
  return { images: [jpeg(item.canvas)], data: { time: Math.round(time * 100) / 100, width: item.canvas.width, height: item.canvas.height } };
}

/** Frames inside a library file. `-ss` before `-i` (input seeking), the demuxer allowlist on. */
async function grab(job: LookJob): Promise<LookResult> {
  if (!job.file) return { error: 'grab needs a file.' };
  const info = await probe(job.file);
  const still = !info.video || info.duration <= 0;
  const times = still ? [0] : captureTimes({ ...job, count: job.count ?? 6 }, info.duration);
  const cells: { canvas: Canvas; label: string }[] = [];
  for (const time of times) {
    const { stdout } = await run(
      'ffmpeg',
      ['-v', 'error', ...(still ? [] : ['-ss', String(Math.min(time, Math.max(0, info.duration - 0.05)))]), ...userInput(job.file), '-i', job.file,
        '-frames:v', '1', '-vf', `scale='if(gt(iw,ih),${CELL_EDGE},-2)':'if(gt(iw,ih),-2,${CELL_EDGE})'`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const image = await loadImage(stdout as unknown as Buffer);
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    cells.push({ canvas, label: stamp(time) });
  }
  return { images: [jpeg(sheet(cells))], data: { times, duration: Math.round(info.duration * 100) / 100 } };
}

export async function lookJob(raw: unknown): Promise<LookResult> {
  const job = LookSchema.parse(raw);
  if (job.op === 'capture') return capture(job);
  if (job.op === 'inspect_color') return inspectColor(job);
  if (job.op === 'frame') return frame(job);
  return grab(job);
}

const MAX_STILL_EDGE = 1920;
export const StillsSchema = JobSchema.pick({ document: true, media: true, transcripts: true, fonts: true, scene: true }).extend({ out_dir: z.string().min(1) });

/** One PNG per slide, at its midpoint with text kept, as the export draws it: `slide-01.png`, `slide-02.png`… */
export async function stillsJob(raw: unknown): Promise<{ files: string[]; width: number; height: number } | { error: string }> {
  const job = StillsSchema.parse(raw);
  const document = validate(job.document);
  const spans = slideSpans(document);
  if (!spans.length) return { error: 'This project has no slides to export as images.' };
  // The document is the user's: the op's limit does not bind one saved another way.
  if (spans.length > MAX_SLIDES) return { error: `A slideshow has at most ${MAX_SLIDES} slides.` };
  const scene = pickScene(document, job.scene);
  // The export's size, with the long edge capped: a very narrow frame would otherwise draw a huge canvas per slide.
  const size = outputSize(scene, 1080);
  const edge = Math.min(MAX_STILL_EDGE, Math.max(size.width, size.height));
  const fit = edge / Math.max(scene.width, scene.height);
  const [width, height] = [Math.round(scene.width * fit), Math.round(scene.height * fit)];
  mkdirSync(job.out_dir, { recursive: true });
  const files: string[] = [];
  await drawFrames(job, document, () => spans.map((span) => (span.start + span.end) / 2), edge, (canvas, index) => {
    const file = join(job.out_dir, `slide-${String(index + 1).padStart(2, '0')}.png`);
    writeFileSync(file, canvas.encodeSync('png'));
    files.push(file);
  });
  return { files, width, height };
}

/** CLI helper: the job file the worker wrote. */
export const readLookJob = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
