/**
 * Renderer MỚI (`@opencmo/clip-render`) vẽ các mẫu — ứng viên để so với ảnh DS.
 *
 *   node packages/editor-parity/scripts/candidate.mjs --target browser|node [--out <thư mục>] [id…]
 *
 * - `browser`: trang esbuild trong Chromium của Playwright, cùng trình duyệt với
 *   oracle — đây là đường preview/chụp khung của editor mới.
 * - `node`: `@napi-rs/canvas` — đường export trên server (spec §7).
 *
 * Cả hai lấy khung video bằng ffmpeg — đường export — với khung đầu tiên có
 * chỉ số ≥ `round(giây · fps)` (luật của DS), cache ở `.frames/`. Bộ giải của
 * ffmpeg và của Chromium lệch nhau vài mức màu trên mảng phẳng, mắt không thấy;
 * mẫu có video vì thế có ngưỡng riêng (xem README).
 * Mẫu có chữ hoặc phụ đề được vẽ nhưng thiếu phần chữ cho tới A3.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRenderer, FONTS, mediaSources } from '../../clip-render/src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const target = flag('target', 'browser');
const out = join(ROOT, flag('out', `.candidate-${target}`));
const valued = new Set(['--target', '--out']);
const only = args.filter((arg, index) => !arg.startsWith('--') && !valued.has(args[index - 1]));

const manifest = JSON.parse(readFileSync(join(ROOT, 'samples', 'manifest.json'), 'utf8'));
const samples = manifest.samples.filter((sample) => only.length === 0 || only.includes(sample.id));

const key = (src) => (typeof src === 'string' ? src : JSON.stringify(src));
const fileOf = (src) => join(ROOT, src);

// ------------------------------------------------------------ video qua ffmpeg

const probed = new Map();
function probe(src) {
  if (!probed.has(src)) {
    const text = execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_read_frames,color_space:format=duration', '-of', 'json', fileOf(src)],
      { encoding: 'utf8' },
    );
    const json = JSON.parse(text);
    const [num, den] = json.streams[0].r_frame_rate.split('/').map(Number);
    probed.set(src, {
      fps: num / den,
      frames: Number(json.streams[0].nb_read_frames),
      duration: Number(json.format.duration),
      // Luồng không ghi ma trận màu: Chromium (thứ người dùng nhìn) giải theo BT.709,
      // ffmpeg mặc định BT.601 — đỏ lệch thành cam. Theo Chromium.
      matrix: !json.streams[0].color_space || json.streams[0].color_space === 'unknown' ? 'bt709' : null,
    });
  }
  return probed.get(src);
}

/** PNG của khung video mà DS sẽ chọn ở `seconds` giây của nguồn. */
function frameFile(src, seconds) {
  const { matrix } = probe(src);
  const index = frameIndex(src, seconds);
  const file = join(ROOT, '.frames', src.replace(/[^\w.-]/g, '_'), `${index}.png`);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const convert = matrix ? `,scale=in_color_matrix=${matrix}` : '';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fileOf(src), '-vf', `select=eq(n\\,${index})${convert}`, '-frames:v', '1', file]);
  }
  return file;
}

/** Chỉ số khung DS chọn ở `seconds` giây của nguồn. */
function frameIndex(src, seconds) {
  const { fps, frames } = probe(src);
  return Math.min(frames - 1, Math.max(0, Math.round(seconds * fps)));
}

/** Mọi file một mẫu cần: ảnh, và khung video của từng mốc thời gian. */
function prepare(document, times) {
  const durations = {};
  const files = {};
  const transcripts = {};
  for (const { kind, src } of mediaSources(document)) {
    if (typeof src !== 'string') continue;
    if (kind === 'image') files[key(src)] = fileOf(src);
    else if (kind === 'transcript') transcripts[src] = JSON.parse(readFileSync(fileOf(src), 'utf8'));
    else durations[key(src)] = probe(src).duration;
  }
  const planner = createRenderer(document, {
    image: () => null,
    video: () => null,
    duration: (src) => durations[key(src)] ?? null,
    transcript: (src) => transcripts[src] ?? null,
  });
  for (const time of times) {
    for (const need of planner.needs(planner.exportFrame(time))) {
      if (need.kind === 'video' && typeof need.src === 'string') {
        files[`${key(need.src)}@${need.seconds}`] = frameFile(need.src, need.seconds);
      }
    }
  }
  return { durations, files, transcripts };
}

const write = (id, time, buffer) => {
  const dir = join(out, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(time).replace('.', '_')}s.png`), buffer);
};

// ------------------------------------------------------------ đích

let failed = 0;

if (target === 'node') {
  const { createCanvas, GlobalFonts, loadImage } = await import('@napi-rs/canvas');
  // Cùng file font với trình duyệt; trục wght/opsz do renderer đặt qua fontVariationSettings.
  for (const [family, entry] of Object.entries(FONTS)) {
    for (const file of [entry.file, entry.italic].filter(Boolean)) {
      GlobalFonts.registerFromPath(join(ROOT, '..', 'clip-media', 'fonts', file), family);
    }
  }
  for (const sample of samples) {
    try {
      const document = JSON.parse(readFileSync(join(ROOT, 'samples', `${sample.id}.json`), 'utf8'));
      const { durations, files, transcripts } = prepare(document, sample.times);
      const images = new Map();
      for (const [name, file] of Object.entries(files)) images.set(name, await loadImage(readFileSync(file)));
      const renderer = createRenderer(document, {
        image: (src) => images.get(key(src)) ?? 'failed',
        video: (src, seconds) => images.get(`${key(src)}@${seconds}`) ?? null,
        duration: (src) => durations[key(src)] ?? null,
        transcript: (src) => transcripts[src] ?? null,
      });
      const canvas = createCanvas(renderer.scene.width, renderer.scene.height);
      const ctx = canvas.getContext('2d');
      for (const time of sample.times) {
        renderer.render(ctx, renderer.exportFrame(time));
        write(sample.id, time, canvas.toBuffer('image/png'));
      }
      console.log(`ok   ${sample.id}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${sample.id}: ${String(error.stack ?? error).split('\n').slice(0, 3).join(' | ')}`);
    }
  }
} else {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright');
  const { serve } = await import('./serve.mjs');
  const { executablePath } = await import('./chromium.mjs');
  await build({
    entryPoints: [join(ROOT, 'render', 'main.ts')],
    bundle: true,
    format: 'esm',
    outfile: join(ROOT, '.build', 'render', 'main.js'),
    logLevel: 'error',
  });
  writeFileSync(join(ROOT, '.build', 'render', 'index.html'), readFileSync(join(ROOT, 'render', 'index.html')));
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('  [page]', message.text().slice(0, 300));
  });
  await page.goto(`${base}/render/index.html`);
  await page.waitForFunction(() => window.candidate?.ready === true, null, { timeout: 60_000 });
  const url = (file) =>
    file.startsWith(join(ROOT, '.frames'))
      ? `${base}/frames/${file.slice(join(ROOT, '.frames').length + 1)}`
      : `${base}/editor-parity/${file.slice(ROOT.length + 1)}`;
  for (const sample of samples) {
    try {
      const document = JSON.parse(readFileSync(join(ROOT, 'samples', `${sample.id}.json`), 'utf8'));
      const { durations, files, transcripts } = prepare(document, sample.times);
      const pngs = await page.evaluate((input) => window.candidate.render(input), {
        document,
        durations,
        transcripts,
        files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, url(file)])),
        times: sample.times,
      });
      pngs.forEach((png, index) => write(sample.id, sample.times[index], Buffer.from(png, 'base64')));
      console.log(`ok   ${sample.id}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${sample.id}: ${String(error.message ?? error).split('\n')[0]}`);
    }
  }
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
