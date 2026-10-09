/**
 * Xuất một document ra MP4 trên server (spec editor-rewrite §7).
 *
 * 1. Đọc document, dò mọi nguồn (độ dài, fps, có tiếng không).
 * 2. Chia khoảng xuất thành vài đoạn liên tục, mỗi đoạn một worker thread vẽ
 *    bằng clip-render + `@napi-rs/canvas` và mã hoá H.264 riêng. Chép pixel ra
 *    khỏi canvas là chỗ chậm nhất (~37 ms/khung 1080×1920), nên song song là
 *    cách duy nhất để 60 s clip không mất vài phút.
 * 3. Ghép các đoạn bằng concat (không mã hoá lại), trộn tiếng, `+faststart`.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import type { ClipDocument } from '@opencmo/clip-doc';
import { createRenderer, mediaSources, parseCube, type MediaHost } from '@opencmo/clip-render';

import { planMix } from './audio.ts';
import { JobSchema, jobDocument, sourceKey, type Job } from './job.ts';
import { probe, type Probe } from './probe.ts';
import { renderSegment, type SegmentInput } from './segment.ts';
import { USER_INPUT } from './inputs.ts';

const run = promisify(execFile);

/** Đoạn ngắn hơn thế này thì không đáng mở thêm worker. */
const MIN_SEGMENT_FRAMES = 60;
/**
 * Ngân sách RAM của exporter (MB), chừa phần còn lại của 2 GB cho worker Python.
 * Số đo trên 1080×1920 (A4, `note.md`): node ~300 chung + ~150 mỗi đoạn,
 * ffmpeg mã hoá ~250 mỗi đoạn, ffmpeg giải mã ~170 mỗi nguồn video mỗi đoạn.
 */
const MEMORY_BUDGET_MB = 1500;

export function parallelFor(videoSources: number, cores: number, visualMB = 0): number {
  const perSegment = 150 + 250 + 170 * videoSources + visualMB;
  return Math.max(1, Math.min(cores, Math.floor((MEMORY_BUDGET_MB - 300) / perSegment)));
}

/**
 * RAM thêm mỗi đoạn cho visual nặng (MB). Stress 29/09 (1080×1920): ba cảnh
 * scene3d kín khung đẩy mỗi đoạn từ ~150 lên ~320 MB (rác JS của vòng chiếu mặt,
 * lưới cache); mỗi Lottie giữ một canvas riêng cỡ hộp của nó.
 */
export function visualCost(document: ClipDocument): number {
  let scenes = 0;
  let lotties = 0;
  const walk = (node: { kind?: string; children?: unknown[] }) => {
    if (node.kind === 'scene3d') scenes++;
    if (node.kind === 'lottie') lotties++;
    for (const child of (node.children ?? []) as { kind?: string; children?: unknown[] }[]) walk(child);
  };
  for (const child of document.stage.children) walk(child as never);
  return Math.min(400, scenes * 60 + lotties * 10);
}

export type ExportResult = { frames: number; width: number; height: number; segments: number; audioClips: number };

export async function exportJob(raw: unknown, log: (line: string) => void = () => {}): Promise<ExportResult> {
  const job: Job = JobSchema.parse(raw);
  const document = jobDocument(job);
  const files = new Map(job.media.map((entry) => [sourceKey(entry.src), entry.file]));

  const probes: Record<string, Probe> = {};
  for (const { kind, src } of mediaSources(document)) {
    if (kind !== 'video' && kind !== 'audio') continue;
    const key = sourceKey(src);
    const file = files.get(key);
    if (!file) throw new Error(`thiếu file cho nguồn ${key}`);
    probes[key] ??= await probe(file);
  }
  const transcripts = new Map(job.transcripts.map((entry) => [entry.src, entry.file]));
  for (const { kind, src } of mediaSources(document)) {
    if (kind === 'transcript' && !transcripts.has(src as string)) throw new Error(`thiếu transcript cho ${String(src)}`);
    if (kind === 'image' && !files.has(sourceKey(src))) throw new Error(`thiếu file cho ảnh ${sourceKey(src)}`);
    if (kind === 'lut') {
      const file = files.get(sourceKey(src));
      if (!file) throw new Error(`thiếu file cho LUT ${sourceKey(src)}`);
      // Đọc thử trước khi vẽ: LUT hỏng mà im lặng thì bản xuất mất màu đã chỉnh.
      parseCube(readFileSync(file, 'utf8'));
    }
  }

  // Bản dựng không vẽ: độ dài, khoảng xuất, tiếng từng khung. Transcript cần cho
  // độ dài phụ đề, nên đọc thật.

  const planHost: MediaHost = {
    image: () => null,
    video: () => null,
    duration: (src) => probes[sourceKey(src)]?.duration ?? null,
    transcript: (src) => {
      const file = transcripts.get(src);
      return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
    },
  };
  const planner = createRenderer(document, planHost, { scene: job.scene });
  const { range } = planner;
  if (range.frames <= 0) throw new Error('scene không có khung nào để xuất');

  // Số khung/giây của bản xuất (E2-b): scene mang `fps`, vắng = 30. Tiếng tính theo lưới 30 như cũ.
  const fps = (planner.scene as { fps?: number }).fps ?? 30;
  const outFrames = Math.max(1, Math.round((range.frames * fps) / 30));

  const gains: number[][] = [];
  for (let i = 0; i < range.frames; i++) gains.push(planner.gains(range.start + i));
  const mix = planMix(planner.audio, gains, range, (clip) => {
    const key = sourceKey(clip.src);
    const file = files.get(key);
    const channels = probes[key]?.channels ?? 0;
    return file && channels > 0 ? { file, channels } : null;
  });

  const cores = availableParallelism();
  const parallel = Math.max(
    1,
    Math.min(
      job.parallel ?? parallelFor(Object.values(probes).filter((entry) => entry.video).length, cores, visualCost(document)),
      Math.floor(outFrames / MIN_SEGMENT_FRAMES) || 1,
    ),
  );
  const threads = Math.max(1, Math.floor(cores / parallel));
  const work = mkdtempSync(join(tmpdir(), 'clip-export-'));
  try {
    const segments: SegmentInput[] = [];
    const per = Math.ceil(outFrames / parallel);
    for (let from = 0; from < outFrames; from += per) {
      segments.push({
        job,
        probes,
        from: range.start + from,
        count: Math.min(per, outFrames - from),
        fps,
        start: range.start,
        file: join(work, `part-${segments.length}.mp4`),
        threads,
      });
    }
    log(`xuất ${outFrames} khung (${fps} fps), ${segments.length} đoạn song song, ${mix?.inputs.length ?? 0} nguồn tiếng`);
    const started = performance.now();
    // Dòng `progress <đã vẽ>/<tổng>` cho worker Python (thanh tiến độ Export): mỗi
    // khi qua thêm 1%, không phải mỗi khung.
    let drawn = 0;
    let reported = -1;
    const onFrames = (count: number) => {
      drawn += count;
      const percent = Math.floor((drawn / outFrames) * 100);
      if (percent > reported) {
        reported = percent;
        log(`progress ${drawn}/${outFrames}`);
      }
    };
    await Promise.all(segments.map((segment) => (segments.length === 1 ? renderSegment(segment, onFrames) : inWorker(segment, onFrames))));
    log(`vẽ + mã hoá xong trong ${((performance.now() - started) / 1000).toFixed(1)} s`);

    const list = join(work, 'parts.txt');
    writeFileSync(list, segments.map((segment) => `file '${segment.file}'`).join('\n'));
    const args = ['-v', 'error', '-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list];
    if (mix) {
      mix.inputs.forEach((input, n) => {
        // Tiếng từ file người dùng: chỉ demuxer media thường (inputs.ts).
        args.push('-ss', input.seek.toFixed(6), '-t', input.duration.toFixed(6), ...USER_INPUT, '-i', input.file);
        writeFileSync(join(work, `cmd-${n}.txt`), mix.commands[n]!);
      });
      const graph = mix.inputs.reduce((text, _, n) => text.replace(`CMD${n}`, join(work, `cmd-${n}.txt`)), mix.graph);
      args.push('-filter_complex', graph, '-map', '0:v', '-map', '[aout]');
    } else {
      // DS luôn có track tiếng; bản xuất không có nguồn tiếng thì im lặng.
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a');
    }
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', (range.frames / 30).toFixed(6),
      '-movflags', '+faststart',
      job.out,
    );
    await run('ffmpeg', args, { maxBuffer: 1 << 20 });
    const size = await probe(job.out);
    return {
      frames: outFrames,
      width: size.video?.width ?? 0,
      height: size.video?.height ?? 0,
      segments: segments.length,
      audioClips: mix?.inputs.length ?? 0,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function inWorker(input: SegmentInput, onFrames: (count: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./segment-worker.ts', import.meta.url), { workerData: input });
    // `{frames}` = tiến độ; `{ok}` = message cuối của worker.
    worker.on('message', (message: { frames?: number; ok?: boolean; error?: string }) => {
      if (typeof message.frames === 'number') onFrames(message.frames);
      else if (message.ok) resolve();
      else reject(new Error(message.error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => code !== 0 && reject(new Error(`worker thoát mã ${code}`)));
  });
}
