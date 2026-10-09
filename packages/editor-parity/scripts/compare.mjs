/**
 * So ảnh ứng viên với ảnh tham chiếu của Diffusion Studio (spec thay dần editor, A0.4).
 *
 *   node packages/editor-parity/scripts/compare.mjs --candidate <thư mục> [--reference references]
 *        [--diff <thư mục>] [--phase A2] [--target node] [--verbose] [id…]
 *
 * `--phase A2`: chỉ đòi các mẫu mà giai đoạn đó phải vẽ khớp (trường `phase` của
 * manifest); mẫu của giai đoạn sau vẫn được đo nhưng chỉ in, không tính hỏng.
 *
 * Giải mã PNG bằng ffmpeg (đã là phụ thuộc cứng của dự án) nên không thêm thư viện ảnh nào.
 * Hai số đo cho mỗi frame, cả hai phải nằm dưới ngưỡng trong `thresholds.json`:
 *
 * - `mean`: sai khác trung bình mỗi kênh RGBA (0–255) trên toàn ảnh — bắt lệch màu, lệch
 *   blend, lệch easing trải khắp khung.
 * - `tile`: sai khác trung bình của ô 32×32 TỆ NHẤT — bắt lỗi cục bộ mà `mean` pha loãng
 *   mất: thiếu một chữ phụ đề, nét viền lệch vài pixel, mặt nạ cắt sai một góc.
 *
 * Ngưỡng lấy từ nhiễu DS-vs-DS (`--candidate .noise`), xem README.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TILE = 32;

const args = process.argv.slice(2);
const flags = {};
const only = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--verbose') flags.verbose = true;
  else if (args[index].startsWith('--')) flags[args[index].slice(2)] = args[++index];
  else only.push(args[index]);
}
if (!flags.candidate) {
  console.error('thiếu --candidate <thư mục>');
  process.exit(2);
}
const candidateDir = resolve(ROOT, flags.candidate);
const referenceDir = resolve(ROOT, flags.reference ?? 'references');
const diffDir = flags.diff ? resolve(ROOT, flags.diff) : null;

const thresholds = JSON.parse(readFileSync(join(ROOT, 'thresholds.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'samples', 'manifest.json'), 'utf8'));
const samples = manifest.samples.filter((sample) => only.length === 0 || only.includes(sample.id));
const due = (sample) => !flags.phase || (sample.phase ?? 'A2') <= flags.phase;

function probeSize(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`ffprobe hỏng: ${file}`);
  const [width, height] = result.stdout.trim().split(',').map(Number);
  return { width, height };
}

function decode(file) {
  const { width, height } = probeSize(file);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
    maxBuffer: width * height * 4 + 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg hỏng: ${file}`);
  return { width, height, data: result.stdout };
}

function measure(a, b) {
  const { width, height } = a;
  const tilesX = Math.ceil(width / TILE);
  const tilesY = Math.ceil(height / TILE);
  const tileSum = new Float64Array(tilesX * tilesY);
  const tileCount = new Float64Array(tilesX * tilesY);
  const diff = diffDir ? Buffer.alloc(width * height * 3) : null;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      let pixel = 0;
      let peak = 0;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(a.data[offset + channel] - b.data[offset + channel]);
        pixel += delta;
        if (delta > peak) peak = delta;
      }
      total += pixel;
      const tile = Math.floor(y / TILE) * tilesX + Math.floor(x / TILE);
      tileSum[tile] += pixel;
      tileCount[tile] += 4;
      // Ảnh diff: nền là tham chiếu nhạt đi, chỗ lệch tô đỏ theo độ lệch lớn nhất.
      if (diff) {
        const out = (y * width + x) * 3;
        const gray = (a.data[offset] + a.data[offset + 1] + a.data[offset + 2]) / 12 + 32;
        diff[out] = Math.min(255, gray + peak * 4);
        diff[out + 1] = gray;
        diff[out + 2] = gray;
      }
    }
  }
  let tile = 0;
  for (let index = 0; index < tileSum.length; index++) tile = Math.max(tile, tileSum[index] / tileCount[index]);
  return { mean: total / (width * height * 4), tile, diff };
}

function writeDiff(file, width, height, buffer) {
  mkdirSync(dirname(file), { recursive: true });
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-', file],
    { input: buffer },
  );
  if (result.status !== 0) throw new Error(`không ghi được ${file}`);
}

/**
 * Ngưỡng: mặc định → theo mẫu → theo đích. `--target node`: Skia của Node đo bề
 * rộng chữ và khử răng cưa glyph hơi khác Chromium (một từ có thể lệch 1 px), nên
 * mẫu có chữ dùng ngưỡng nới của đích đó. Logic vẽ chữ đã được đích trình duyệt
 * đo chặt; đích Node chỉ cần bắt lỗi thô (thiếu font, sai baseline).
 */
const limitFor = (sample) => {
  const target = flags.target ? thresholds.targets?.[flags.target] : undefined;
  return {
    ...thresholds.default,
    ...(thresholds.samples?.[sample.id] ?? {}),
    ...(sample.text && target?.text ? target.text : {}),
  };
};
const fmt = (value) => value.toFixed(2).padStart(6);

let failed = 0;
let pending = 0;
let worstMean = 0;
let worstTile = 0;
for (const sample of samples) {
  const limit = limitFor(sample);
  const required = due(sample);
  if (sample.oracleBroken) {
    console.log(`bỏ   ${sample.id}: ${sample.oracleBroken}`);
    continue;
  }
  const refFolder = join(referenceDir, sample.id);
  const candFolder = join(candidateDir, sample.id);
  if (!existsSync(refFolder)) {
    failed++;
    console.log(`FAIL ${sample.id}: thiếu ảnh tham chiếu (ảnh DS đã chốt ở references/, không vẽ thêm được từ C3)`);
    continue;
  }
  for (const name of readdirSync(refFolder).filter((file) => file.endsWith('.png')).sort()) {
    const label = `${sample.id}/${name}`;
    const candFile = join(candFolder, name);
    if (!existsSync(candFile)) {
      failed++;
      console.log(`FAIL ${label}: ứng viên không có frame này`);
      continue;
    }
    const reference = decode(join(refFolder, name));
    const candidate = decode(candFile);
    if (reference.width !== candidate.width || reference.height !== candidate.height) {
      failed++;
      console.log(
        `FAIL ${label}: kích thước ${candidate.width}×${candidate.height}, tham chiếu ${reference.width}×${reference.height}`,
      );
      continue;
    }
    const { mean, tile, diff } = measure(reference, candidate);
    const ok = mean <= limit.mean && tile <= limit.tile;
    if (required) {
      worstMean = Math.max(worstMean, mean);
      worstTile = Math.max(worstTile, tile);
      if (!ok) failed++;
    } else if (!ok) {
      pending++;
    }
    if ((!ok && required) || flags.verbose) {
      const status = ok ? 'ok  ' : required ? 'FAIL' : sample.phase;
      console.log(`${status.padEnd(4)} ${label.padEnd(44)} mean ${fmt(mean)}/${limit.mean}  tile ${fmt(tile)}/${limit.tile}`);
    }
    if (diff && !ok) writeDiff(join(diffDir, sample.id, name), reference.width, reference.height, diff);
  }
}

const later = pending ? ` · ${pending} frame của giai đoạn sau chưa khớp` : '';
console.log(
  `\n${samples.filter(due).length}/${samples.length} mẫu phải đạt · lệch lớn nhất: mean ${worstMean.toFixed(2)}, tile ${worstTile.toFixed(2)} · ${failed} frame hỏng${later}`,
);
process.exit(failed ? 1 : 0);
