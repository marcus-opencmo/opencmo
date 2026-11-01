/**
 * `look` (editor-MCP plan, item 1): frames drawn for Claude over MCP must be the frames the export draws.
 * Real ffmpeg, like `clip-export.test.ts`: frame N of the fixture is gray level 4N, so the gray
 * of a cell tells which source frame it shows.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadImage, createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validate } from '@opencmo/clip-doc';

import { exportJob } from './export.ts';
import { lookJob, stillsJob } from './look.ts';

const FONTS = fileURLToPath(new URL('../../clip-media/fonts', import.meta.url));

describe('lookJob (real ffmpeg)', () => {
  let dir = '';
  const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clip-look-test-'));
    ffmpeg([
      '-f', 'lavfi', '-i', "color=s=360x640:r=30:d=2,format=gray,geq=lum='4*N'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p',
      join(dir, 'master.mp4'),
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=1', '-frames:v', '1', join(dir, 'still.png')]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const document = validate({
    version: 1,
    stage: {
      children: [{
        kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true,
        children: [
          { kind: 'video', id: 'speaker', width: 360, height: 640, src: 'assets/master.mp4' },
          { kind: 'text', id: 'title', text: 'Hello', fontFamily: 'Inter', x: 100, y: 520, fontSize: 48, color: '#FFFFFF', start: 0, end: 0.5 },
        ],
      }],
    },
  });
  const base = () => ({ document, media: [{ src: 'assets/master.mp4', file: join(dir, 'master.mp4') }], transcripts: [], fonts: FONTS });

  /** Mean gray of a 20×20 patch at the top left of a JPEG cell (no text there). */
  const grayOf = async (base64: string, x = 30, y = 60) => {
    const image = await loadImage(Buffer.from(base64, 'base64'));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(x, y, 20, 20).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]!;
    return { gray: sum / (data.length / 4), width: image.width, height: image.height };
  };

  it('stills: one PNG per slide at its midpoint, text kept, at the size of the export', async () => {
    const slide = (id: string, start: number, end: number, fill: string, text: string) => ({
      kind: 'group', id, start, end, marks: { visual: { op: 'add_slide', input: {} } },
      children: [
        { kind: 'rect', width: 360, height: 640, fill, start: 0, end: end - start },
        { kind: 'text', x: 20, y: 200, width: 320, height: 200, text, color: '#FFFFFF', fontFamily: 'Inter', fontSize: 60, fontWeight: 700, textAlign: 'center', textBaseline: 'middle', start: 0, end: end - start },
      ],
    });
    const slides = validate({ version: 1, stage: { children: [{ kind: 'scene', width: 360, height: 640, active: true, workarea: [0, 5], children: [slide('a', 0, 2, '#FF0000', 'ONE'), slide('b', 2, 5, '#0000FF', 'TWO')] }] } });
    const out = join(dir, 'stills');
    const result = await stillsJob({ document: slides, media: [], transcripts: [], fonts: FONTS, out_dir: out });
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ width: 1080, height: 1920 });
    expect(result.files.map((file) => file.slice(out.length + 1))).toEqual(['slide-01.png', 'slide-02.png']);
    const pixels = async (file: string) => {
      const image = await loadImage(file);
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return { size: [image.width, image.height], corner: [...ctx.getImageData(5, 5, 1, 1).data].slice(0, 3), whites: ctx.getImageData(0, 600, 1080, 600).data.filter((_, at, data) => at % 4 === 0 && data[at]! > 240 && data[at + 1]! > 240 && data[at + 2]! > 240).length };
    };
    const [first, second] = [await pixels(result.files[0]!), await pixels(result.files[1]!)];
    expect(first.size).toEqual([1080, 1920]);
    expect(first.corner).toEqual([255, 0, 0]);
    expect(second.corner).toEqual([0, 0, 255]);
    expect(first.whites).toBeGreaterThan(100);
    expect(second.whites).toBeGreaterThan(100);
  });

  it('stills: a saved document past the slide limit is refused', async () => {
    const group = { kind: 'group', start: 0, end: 1, marks: { visual: { op: 'add_slide', input: {} } }, children: [] };
    const many = validate({ version: 1, stage: { children: [{ kind: 'scene', width: 360, height: 640, active: true, children: Array.from({ length: 36 }, (_, at) => ({ ...group, id: `s${at}`, start: at, end: at + 1 })) }] } });
    expect(await stillsJob({ document: many, media: [], transcripts: [], fonts: FONTS, out_dir: join(dir, 'many') })).toEqual({ error: expect.stringMatching(/at most 35/) });
  });

  it('stills: a document with no slides says so', async () => {
    expect(await stillsJob({ document, media: [], transcripts: [], fonts: FONTS, out_dir: join(dir, 'none') })).toEqual({ error: expect.stringMatching(/no slides/) });
  });

  it('capture: one sheet, the layers on screen, and the same frame the export draws', async () => {
    const result = await lookJob({ ...base(), op: 'capture', times: [0.25, 1], grid: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.images).toHaveLength(1);
    // Two cells side by side, long edge 360 each (the scene is 360×640, so 203×360), gap 4.
    const sheet = await grayOf(result.images[0]!);
    expect([sheet.width, sheet.height]).toEqual([203 * 2 + 4, 360]);
    const cell = await grayOf(result.images[0]!, 203 + 4 + 30, 60);
    const layers = result.data.layers as { time: number; visible: { id: string; box: number[] }[] }[];
    // Top first; the title only shows until 0.5 s.
    expect(layers[0]!.visible.map((layer) => layer.id)).toEqual(['title', 'speaker']);
    expect(layers[1]!.visible.map((layer) => layer.id)).toEqual(['speaker']);
    expect(layers[1]!.visible[0]!.box).toEqual([0, 0, 1, 1]);

    await exportJob({ ...base(), out: join(dir, 'out.mp4'), resolution: 720, parallel: 1 });
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'out.mp4'), '-vf', 'select=eq(n\\,30),crop=40:40:40:80,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
    const exported = raw.reduce((sum, value) => sum + value, 0) / raw.length;
    // Frame 30 is gray 120: both paths must agree within codec noise.
    expect(Math.abs(exported - 120)).toBeLessThan(6);
    expect(Math.abs(cell.gray - exported)).toBeLessThan(6);
  });

  it('capture: a time at the very end of a 60 fps scene draws the last frame, not one past it', async () => {
    const fast = structuredClone(document);
    (fast.stage.children[0] as { fps?: number }).fps = 60;
    const result = await lookJob({ ...base(), document: validate(fast), op: 'capture', times: [2], grid: false });
    if ('error' in result) throw new Error(result.error);
    const layers = result.data.layers as { visible: { id: string }[] }[];
    expect(layers[0]!.visible.map((layer) => layer.id)).toEqual(['speaker']);
    expect((await grayOf(result.images[0]!)).gray).toBeGreaterThan(200);
  });

  it('capture: evenly spread frames when no times are given, at most 12', async () => {
    const result = await lookJob({ ...base(), op: 'capture', count: 4 });
    if ('error' in result) throw new Error(result.error);
    expect(result.data.times).toEqual([0.25, 0.75, 1.25, 1.75]);
    expect(result.data.grid).toMatch(/Cyan lines/);
    await expect(lookJob({ ...base(), op: 'capture', times: Array.from({ length: 13 }, (_, i) => i / 10) })).rejects.toThrow();
  });

  it('inspect_color: numbers of the frame without text, and a box for one layer', async () => {
    const whole = await lookJob({ ...base(), op: 'inspect_color', time: 1 });
    if ('error' in whole) throw new Error(whole.error);
    // The frame is flat gray 120/255 ≈ 0.47; the white title would push `white` near 1.
    expect(whole.data.white as number).toBeLessThan(0.6);
    expect(whole.data.median as number).toBeGreaterThan(0.4);
    const gone = await lookJob({ ...base(), op: 'inspect_color', time: 1, element_id: 'title' });
    expect(gone).toEqual({ error: expect.stringMatching(/not visible/) });
    const speaker = await lookJob({ ...base(), op: 'inspect_color', time: 1, element_id: 'speaker' });
    if ('error' in speaker) throw new Error(speaker.error);
    expect(speaker.data.box).toEqual([0, 0, 1, 1]);
  });

  it('frame: one large frame without the text, for save_frame', async () => {
    const result = await lookJob({ ...base(), op: 'frame', time: 0.25, edge: 640 });
    if ('error' in result) throw new Error(result.error);
    expect([result.data.width, result.data.height]).toEqual([360, 640]);
    // The title is on screen at 0.25 s in a capture; here the text is left out, so its spot stays the video's gray.
    const where = await grayOf(result.images[0]!, 120, 535);
    expect(where.gray).toBeLessThan(80);
  });

  it('grab: frames inside a library video, or the one picture of an image', async () => {
    const video = await lookJob({ ...base(), op: 'grab', file: join(dir, 'master.mp4'), times: [0.5, 1.5] });
    if ('error' in video) throw new Error(video.error);
    expect(video.data.times).toEqual([0.5, 1.5]);
    const image = await lookJob({ ...base(), op: 'grab', file: join(dir, 'still.png') });
    if ('error' in image) throw new Error(image.error);
    expect(image.data.times).toEqual([0]);
    const red = await grayOf(image.images[0]!, 60, 40);
    expect(red.gray).toBeGreaterThan(200);
  });
});
