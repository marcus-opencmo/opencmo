import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validate } from '@opencmo/clip-doc';

import { planMix } from './audio.ts';
import { exportJob, parallelFor } from './export.ts';
import { sourceKey } from './job.ts';
import { hasExternalAssets, lottieHost } from './segment.ts';

const FONTS = fileURLToPath(new URL('../../clip-media/fonts', import.meta.url));
const LOTTIE = fileURLToPath(new URL('../../clip-media/lottie', import.meta.url));
const TRANSCRIPT = fileURLToPath(new URL('../../editor-parity/fixtures/transcript.json', import.meta.url));

describe('planMix', () => {
  const clip = (over: object) => ({ src: 'a.mp4', start: 0, end: 60, sourceIn: 2, rate: 1, node: null as never, ...over });

  it('denoise: highpass + anlmdn trước atempo, mạnh dần theo mức; không có thì không thêm', () => {
    const gains = [[1]];
    const at = (denoise?: number) =>
      planMix([clip({ node: { node: { kind: 'video', denoise } } as never })], gains, { start: 0, frames: 1 }, () => ({ file: 'a.mp4', channels: 2 }))!.graph;
    expect(at(undefined)).not.toContain('anlmdn');
    expect(at(0)).not.toContain('anlmdn');
    expect(at(0.5)).toContain('highpass=f=80,anlmdn=s=0.1000');
    expect(at(1)).toContain('anlmdn=s=0.5000');
  });

  it('chỉ ghi lệnh âm lượng khi biên độ đổi, theo giây của bản xuất', () => {
    const gains = [[0], [0.5], [0.5], [1]];
    const mix = planMix([clip({})], gains, { start: 0, frames: 4 }, () => ({ file: 'a.mp4', channels: 2 }))!;
    expect(mix.commands[0]!.split('\n')).toEqual([
      '0.000000 volume@v0 volume 0.000000;',
      '0.033333 volume@v0 volume 0.500000;',
      '0.100000 volume@v0 volume 1.000000;',
    ]);
    expect(mix.inputs[0]).toEqual({ file: 'a.mp4', seek: 2, duration: 4 / 30 });
    expect(mix.graph).toContain('[1:a]aresample=48000');
    expect(mix.graph).not.toContain('pan=');
  });

  it('cắt theo khoảng xuất, giãn nhịp bằng chuỗi atempo, mono ra hai kênh nguyên mức', () => {
    const gains = Array.from({ length: 30 }, () => [1]);
    const mix = planMix([clip({ start: 0, end: 90, rate: 4 })], gains, { start: 30, frames: 30 }, () => ({
      file: 'a.mp4',
      channels: 1,
    }))!;
    // Bắt đầu ở khung 30 của clip: nguồn đã chạy 1 s × tốc độ 4.
    expect(mix.inputs[0]).toEqual({ file: 'a.mp4', seek: 6, duration: 4 });
    expect(mix.graph).toContain('atempo=2,atempo=2');
    expect(mix.graph).toContain('pan=stereo|c0=c0|c1=c0');
  });

  it('bỏ clip câm suốt khoảng xuất, clip không có tiếng, và clip nằm ngoài khoảng', () => {
    const gains = [[0, 1, 1]];
    const clips = [clip({}), clip({ src: 'silent.mp4' }), clip({ start: 100, end: 200 })];
    expect(
      planMix(clips, gains, { start: 0, frames: 1 }, (c) => (c.src === 'silent.mp4' ? null : { file: 'a', channels: 2 })),
    ).toBeNull();
  });
});

describe('job', () => {
  it('khoá nguồn không phụ thuộc thứ tự khoá của khai báo asset', () => {
    expect(sourceKey({ generate: 'image', prompt: 'x' })).toBe(sourceKey({ prompt: 'x', generate: 'image' }));
    expect(sourceKey('assets/master.mp4')).toBe('assets/master.mp4');
  });

  it('số đoạn song song theo ngân sách RAM, không theo số lõi', () => {
    expect(parallelFor(1, 16)).toBe(2);
    expect(parallelFor(3, 16)).toBe(1);
    expect(parallelFor(0, 1)).toBe(1);
    // Visual nặng (stress 29/09): ba cảnh 3D không video → 2 đoạn thay vì 3.
    expect(parallelFor(0, 16)).toBe(3);
    expect(parallelFor(0, 16, 180)).toBe(2);
  });
});

describe('lottieHost (Skottie)', () => {
  /** Đếm điểm ảnh có màu — qua drawImage vì getImageData không thấy nét Skottie. */
  function painted(frame: unknown): number {
    const probe = createCanvas(64, 64);
    const ctx = probe.getContext('2d');
    ctx.drawImage(frame as never, 0, 0);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) count++;
    return count;
  }

  it('vẽ bộ có sẵn đúng cỡ xin, đổi theo giây; nguồn thiếu → failed', () => {
    const host = lottieHost({ lottie: LOTTIE }, new Map());
    const a = host('builtin:walk', 0.1, 64, 64, true);
    expect((a as { width: number }).width).toBe(64);
    const first = painted(a);
    expect(first).toBeGreaterThan(100);
    // Lặp: 1 giây sau là cùng khung.
    expect(painted(host('builtin:walk', 1.1, 64, 64, true))).toBe(first);
    expect(host('builtin:no-such', 0, 64, 64, true)).toBe('failed');
    expect(host('upload.json', 0, 64, 64, true)).toBe('failed');
  });

  it('Lottie người dùng có tài nguyên ngoài không được nạp (đọc file trên worker)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lottie-'));
    const base = { v: '5.7.4', fr: 30, ip: 0, op: 30, w: 64, h: 64, layers: [{ ind: 1, ty: 1, sc: '#00ff00', sw: 64, sh: 64, ip: 0, op: 30, st: 0, ks: {} }] };
    const external = join(dir, 'external.json');
    writeFileSync(external, JSON.stringify({ ...base, assets: [{ id: 'i', w: 1, h: 1, u: '/etc/', p: 'hostname' }] }));
    const clean = join(dir, 'clean.json');
    writeFileSync(clean, JSON.stringify(base));
    const host = lottieHost({ lottie: LOTTIE }, new Map([['user/external.json', external], ['user/clean.json', clean]]));
    expect(host('user/external.json', 0, 64, 64, true)).toBe('failed');
    expect(host('user/clean.json', 0, 64, 64, true)).not.toBe('failed');
    expect(hasExternalAssets(JSON.stringify({ ...base, assets: [{ id: 'i', p: 'data:image/png;base64,AA', e: 1 }] }))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('exportJob (ffmpeg thật)', () => {
  let dir = '';
  const run = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clip-export-test-'));
    // Khung thứ N là màu xám mức 4N: đọc được chỉ số khung từ điểm ảnh, xám
    // thì không lệch theo ma trận màu. Tiếng là sine mono ở −21 dBFS.
    run([
      '-f', 'lavfi', '-i', "color=s=360x640:r=30:d=2,format=gray,geq=lum='4*N'",
      '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      join(dir, 'master.mp4'),
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Nodes = Record<string, unknown>[];
  const clip = (children: Nodes) =>
    validate({
      version: 1,
      stage: { children: [{ kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, children }] },
    });
  const source = (captions: Nodes) =>
    clip([
      {
        kind: 'video',
        width: 360,
        height: 640,
        sourceIn: 0.5,
        src: 'assets/master.mp4',
        volume: -6,
        animations: [{ type: 'gain', phase: 'in', duration: 0.5 }],
      },
      ...captions,
    ]);

  const job = (out: string, document: ReturnType<typeof clip>, parallel: number) => ({
    document,
    media: [{ src: 'assets/master.mp4', file: join(dir, 'master.mp4') }],
    transcripts: [{ src: 'assets/transcript.json', file: TRANSCRIPT }],
    fonts: FONTS, lottie: LOTTIE,
    out: join(dir, out),
    resolution: 720,
    parallel,
  });

  /** Mức xám trung bình vùng 40×40 ở góc trên trái của khung `n` (không dính phụ đề). */
  const grayAt = (file: string, n: number) => {
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),crop=40:40:0:0,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
    ]);
    return raw.reduce((sum, value) => sum + value, 0) / raw.length;
  };

  const rms = (file: string, at: number) => {
    const text = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-ss', String(at), '-t', '0.1', '-i', file, '-af', 'astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    return Number(text.trim().split('\n').at(-1)!.split('=')[1]);
  };

  it('denoise thật: nền ồn giữa câu hạ ≥ 10 dB, mức giọng giữ trong 1 dB', async () => {
    // Giọng giả: sine 220 Hz bật 0.5 s / tắt 0.5 s, trộn nhiễu hồng nền. Nhiễu có seed cố định:
    // không seed thì mỗi lần chạy một mẫu nhiễu khác, mức hạ dao động quanh ngưỡng (CI đo 9.6 dB).
    run([
      '-f', 'lavfi', '-i', 'color=s=360x640:r=30:d=3',
      '-f', 'lavfi', '-i', "sine=f=220:sample_rate=48000:d=3,volume='if(lt(mod(t,1),0.5),0.5,0)':eval=frame",
      '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.03:d=3:r=48000:seed=7',
      '-filter_complex', '[1][2]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest',
      join(dir, 'noisy.mp4'),
    ]);
    const noisy = (denoise?: number) =>
      clip([{ kind: 'video', width: 360, height: 640, src: 'assets/noisy.mp4', ...(denoise === undefined ? {} : { denoise }) }]);
    const noisyJob = (out: string, denoise?: number) => ({ ...job(out, noisy(denoise), 1), media: [{ src: 'assets/noisy.mp4', file: join(dir, 'noisy.mp4') }] });
    await exportJob(noisyJob('raw.mp4'));
    await exportJob(noisyJob('clean.mp4', 0.6));
    const gap = (file: string) => rms(join(dir, file), 1.7);
    const voice = (file: string) => rms(join(dir, file), 2.2);
    expect(gap('raw.mp4') - gap('clean.mp4')).toBeGreaterThan(10);
    expect(Math.abs(voice('raw.mp4') - voice('clean.mp4'))).toBeLessThan(1);
  });

  it('khung đúng luật DS, phóng theo độ phân giải, tiếng theo volume + gain', async () => {
    const out = join(dir, 'plain.mp4');
    const result = await exportJob(job('plain.mp4', source([]), 1));
    // Scene 360×640 xuất 720p: phóng ×2. Video 2 s bắt đầu từ 0.5 s → 1.5 s = 45 khung.
    expect(result).toMatchObject({ frames: 45, width: 720, height: 1280, audioClips: 1 });
    for (const n of [0, 10, 44]) expect(Math.abs(grayAt(out, n) - 4 * (n + 15))).toBeLessThan(3);
    // Fade tiếng 0.5 s ở đầu, sau đó −21 − 6 = −27 dBFS.
    expect(rms(out, 0)).toBeLessThan(-40);
    expect(Math.abs(rms(out, 1) - -27)).toBeLessThan(0.5);
  });

  it('chia đoạn song song ra cùng một bản xuất, kể cả phụ đề guinea đếm theo lịch sử', async () => {
    const document = source([{ kind: 'captions', src: 'assets/transcript.json', preset: 'guinea' }]);
    await exportJob(job('one.mp4', document, 1));
    const result = await exportJob(job('two.mp4', document, 2));
    expect(result.segments).toBe(2);
    const psnr = execFileSync(
      'ffmpeg',
      ['-v', 'info', '-i', join(dir, 'one.mp4'), '-i', join(dir, 'two.mp4'), '-lavfi', '[0:v]crop=720:400:0:440[a];[1:v]crop=720:400:0:440[b];[a][b]psnr=stats_file=-', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Chỉ so vùng phụ đề: màu nhấn sai của guinea là vài chục điểm ảnh, so cả
    // khung thì PSNR vẫn cao.
    const worst = Math.min(...[...psnr.matchAll(/psnr_avg:(\S+)/g)].map((m) => (m[1] === 'inf' ? Infinity : Number(m[1]))));
    expect(worst).toBeGreaterThan(35);
  });

  it('job không có document bị từ chối (R3: không còn đường TSX)', async () => {
    const { document: _document, ...rest } = job('no-doc.mp4', source([]), 1);
    await expect(exportJob({ ...rest })).rejects.toThrow(/job needs a document/);
    // Job kiểu cũ mang chuỗi TSX ở `source`: bị từ chối, không đọc.
    await expect(exportJob({ ...rest, source: 'export default function Project() {}' })).rejects.toThrow(/source/);
  });

  it('fps của scene (E2-b): 60 và 24 khung/giây, cùng độ dài, khung đúng thời điểm', async () => {
    const { document: _document, ...rest } = job('fps.mp4', source([]), 1);
    const withFps = (fps: number) => {
      const document = source([]) as unknown as { stage: { children: Record<string, unknown>[] } };
      document.stage.children[0]!.fps = fps;
      return document;
    };
    const rate = (file: string) =>
      execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    const sixty = await exportJob({ ...rest, out: join(dir, 'fps60.mp4'), document: withFps(60) });
    expect(sixty.frames).toBe(90);
    expect(rate(join(dir, 'fps60.mp4'))).toBe('60/1,90');
    // Khung xuất 20 ở 60 fps = khung scene 10 ở lưới 30.
    expect(Math.abs(grayAt(join(dir, 'fps60.mp4'), 20) - 4 * (10 + 15))).toBeLessThan(3);
    const film = await exportJob({ ...rest, out: join(dir, 'fps24.mp4'), document: withFps(24), parallel: 2 });
    expect(film.frames).toBe(36);
    expect(rate(join(dir, 'fps24.mp4'))).toBe('24/1,36');
    // Khung xuất 12 ở 24 fps = giây 0.5 = khung scene 15.
    expect(Math.abs(grayAt(join(dir, 'fps24.mp4'), 12) - 4 * (15 + 15))).toBeLessThan(3);
  });

  it('J/L-cut (E1): hình cắt đúng khung, tiếng đoạn trước kéo sang đoạn sau', async () => {
    // Nguồn 4 s: khung N xám mức 2N; tiếng chỉ kêu ở giây nguồn 1.0–1.5.
    run([
      '-f', 'lavfi', '-i', "color=s=360x640:r=30:d=4,format=gray,geq=lum='2*N'",
      '-f', 'lavfi', '-i', "sine=f=440:sample_rate=48000:d=4,volume='if(between(t,1,1.5),1,0)':eval=frame",
      '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest',
      join(dir, 'roll.mp4'),
    ]);
    // Đúng dạng `writeCaptionState` dựng khi giữ [0,1] + [3,4] và L-cut 0.5 s ở chỗ cắt:
    // hình câm; tiếng đoạn 1 nguồn 0–1.5, đoạn 2 nguồn 3.5–4 từ giây 1.5.
    const video = (sourceIn: number, sourceOut: number, start: number, muted: boolean) => ({
      kind: 'video', src: 'assets/roll.mp4', width: 360, height: 640, sourceIn, sourceOut, start, ...(muted ? { muted: true } : {}),
    });
    const sound = (sourceIn: number, sourceOut: number, start: number) => ({ kind: 'audio', src: 'assets/roll.mp4', sourceIn, sourceOut, start });
    const documentFor = (rolled: boolean) => ({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, workarea: [0, 2],
            children: [
              {
                kind: 'sequence',
                children: rolled
                  ? [video(0, 1, 0, true), video(3, 4, 1, true), sound(0, 1.5, 0), sound(3.5, 4, 1.5)]
                  : [video(0, 1, 0, false), video(3, 4, 1, false)],
              },
            ],
          },
        ],
      },
    });
    const exportDoc = (out: string, rolled: boolean) =>
      exportJob({ document: documentFor(rolled) as never, media: [{ src: 'assets/roll.mp4', file: join(dir, 'roll.mp4') }], transcripts: [], fonts: FONTS, lottie: LOTTIE, out: join(dir, out), resolution: 720, parallel: 1 });
    await exportDoc('straight.mp4', false);
    await exportDoc('lcut.mp4', true);
    // Giây xuất 1.2: hình là giây nguồn 3.2 (khung 96 → xám 192) ở CẢ HAI bản.
    for (const file of ['straight.mp4', 'lcut.mp4']) expect(Math.abs(grayAt(join(dir, file), 36) - 192)).toBeLessThan(4);
    // Tiếng: cắt thẳng thì im (nguồn 3.2), L-cut thì còn tiếng nguồn 1.2 kêu.
    // Im tuyệt đối thì astats in "-inf" (đọc ra NaN): coi là −∞.
    const level = (file: string, at: number) => {
      const value = rms(join(dir, file), at);
      return Number.isNaN(value) ? -Infinity : value;
    };
    expect(level('straight.mp4', 1.2)).toBeLessThan(-50);
    expect(level('lcut.mp4', 1.2)).toBeGreaterThan(-30);
    // Sau khoảng chồng (giây 1.7 = nguồn 3.7) cả hai đều im như nguồn.
    expect(level('lcut.mp4', 1.7)).toBeLessThan(-50);
  });

  it('chỉnh màu trên pixel (E3): saturation −1 ra xám, bộ curves/wheels/grain/glow xuất được', async () => {
    run(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=1', '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'color.mp4')]);
    const documentFor = (effects: unknown[]) => ({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, workarea: [0, 1],
            children: [{ kind: 'video', src: 'assets/color.mp4', width: 360, height: 640, effects }],
          },
        ],
      },
    });
    const exportDoc = (out: string, effects: unknown[]) =>
      exportJob({ document: documentFor(effects) as never, media: [{ src: 'assets/color.mp4', file: join(dir, 'color.mp4') }], transcripts: [], fonts: FONTS, lottie: LOTTIE, out: join(dir, out), resolution: 720, parallel: 1 });
    // Độ lệch chroma trung bình (|U−128| + |V−128|) của khung 10.
    const chromaOf = (file: string) => {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-vf', 'select=eq(n\\,10),scale=90:160,format=yuv444p', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
      const plane = 90 * 160;
      let sum = 0;
      for (let i = 0; i < plane; i++) sum += Math.abs(raw[plane + i]! - 128) + Math.abs(raw[2 * plane + i]! - 128);
      return sum / plane;
    };
    await exportDoc('color-plain.mp4', []);
    await exportDoc('color-gray.mp4', [{ type: 'saturation', value: -1 }]);
    expect(chromaOf('color-plain.mp4')).toBeGreaterThan(20);
    expect(chromaOf('color-gray.mp4')).toBeLessThan(2);
    const graded = await exportDoc('color-graded.mp4', [
      { type: 'curves', value: 1, params: { master: [[0, 0.05], [0.5, 0.42], [1, 0.97]] } },
      { type: 'wheels', value: 1, params: { gain: [0.15, 0.05, -0.1], lift: [0, 0, 0.2] } },
      { type: 'sharpen', value: 0.5 },
      { type: 'glow', value: 0.6 },
      { type: 'grain', value: 0.4 },
    ]);
    expect(graded).toMatchObject({ frames: 30, width: 720, height: 1280 });
  });

  it('LUT .cube (E3-c): xuất ra đảo màu đúng, LUT hỏng thì báo lỗi trước khi vẽ', async () => {
    const lines = ['LUT_3D_SIZE 9'];
    for (let b = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++) lines.push(`${1 - r / 8} ${1 - g / 8} ${1 - b / 8}`);
    writeFileSync(join(dir, 'invert.cube'), lines.join('\n'));
    writeFileSync(join(dir, 'broken.cube'), 'LUT_3D_SIZE 9\n0 0 0');
    const documentFor = (lut: string) => ({
      version: 1,
      stage: {
        children: [
          {
            kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, workarea: [0, 1],
            children: [{ kind: 'video', src: 'assets/master.mp4', width: 360, height: 640, effects: [{ type: 'lut', value: 1, params: { src: lut } }] }],
          },
        ],
      },
    });
    const run = (out: string, lut: string) =>
      exportJob({
        document: documentFor(lut) as never,
        media: [{ src: 'assets/master.mp4', file: join(dir, 'master.mp4') }, { src: lut, file: join(dir, lut) }],
        transcripts: [], fonts: FONTS, lottie: LOTTIE, out: join(dir, out), resolution: 720, parallel: 1,
      });
    await run('lut.mp4', 'invert.cube');
    // Nguồn khung N xám mức 4N: khung 10 là 40 → đảo ra ~215.
    const level = grayAt(join(dir, 'lut.mp4'), 10);
    expect(Math.abs(level - (255 - 40)), `gray ${level}`).toBeLessThan(6);
    await expect(run('broken.mp4', 'broken.cube')).rejects.toThrow(/damaged/);
  });

  it('bố cục grid 2×2 (E5): mỗi ô đúng màu nguồn của nó, objectPosition cắt đúng phía', async () => {
    const colors = { red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] } as const;
    for (const name of Object.keys(colors)) run(['-f', 'lavfi', '-i', `color=c=${name}:s=320x180`, '-frames:v', '1', join(dir, `${name}.png`)]);
    const cell = (name: string, x: number, y: number) => ({
      kind: 'rect', x, y, width: 180, height: 320, start: 0, end: 1, paints: [{ type: 'image', src: `${name}.png`, objectFit: 'cover', objectPosition: [0, 0.5] }],
    });
    const document = {
      version: 1,
      stage: { children: [{ kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, workarea: [0, 1], children: [
        cell('red', 0, 0), cell('lime', 180, 0), cell('blue', 0, 320), cell('yellow', 180, 320),
      ] }] },
    };
    await exportJob({
      document: document as never,
      media: Object.keys(colors).map((name) => ({ src: `${name}.png`, file: join(dir, `${name}.png`) })),
      transcripts: [], fonts: FONTS, lottie: LOTTIE, out: join(dir, 'grid.mp4'), resolution: 720, parallel: 1,
    });
    const rgb = (x: number, y: number) => [...execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'grid.mp4'), '-vf', `crop=4:4:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']).subarray(0, 3)];
    const points: [keyof typeof colors, number, number][] = [['red', 180, 320], ['lime', 540, 320], ['blue', 180, 960], ['yellow', 540, 960]];
    for (const [name, x, y] of points) {
      const got = rgb(x, y);
      colors[name].forEach((value, index) => expect(Math.abs(got[index]! - value), `${name} ${got}`).toBeLessThan(40));
    }
  });

  it('kiểu chữ E4: chữ Footage lộ video trong lòng chữ, matte phủ ngoài; nền + gạch dưới + wordSlide xuất được', async () => {
    run(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=1', '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p', join(dir, 'text-bg.mp4')]);
    const document = {
      version: 1,
      stage: { children: [{ kind: 'scene', name: 'Clip', width: 360, height: 640, fill: '#000000', active: true, workarea: [0, 1], children: [
        { kind: 'video', src: 'assets/text-bg.mp4', width: 360, height: 640 },
        { kind: 'text', text: 'BIG', fontFamily: 'Anton', fontSize: 200, color: '#FFFFFF', fill: 'footage', x: 20, y: 160, start: 0, end: 1 },
        {
          kind: 'text', text: 'Boxed words', fontFamily: 'Inter', fontSize: 40, color: '#FFFFFF', x: 20, y: 480, start: 0, end: 1,
          background: { color: '#E11D48', radius: 14 }, decoration: ['underline'], animations: [{ type: 'wordSlide', perWord: 0.1 }],
        },
      ] }] },
    };
    await exportJob({
      document: document as never,
      media: [{ src: 'assets/text-bg.mp4', file: join(dir, 'text-bg.mp4') }],
      transcripts: [], fonts: FONTS, lottie: LOTTIE, out: join(dir, 'text-style.mp4'), resolution: 720, parallel: 1,
    });
    const rgb = (x: number, y: number) => [...execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'text-style.mp4'), '-vf', `select=eq(n\\,20),crop=4:4:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']).subarray(0, 3)];
    if (process.env.KEEP_FRAMES) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'text-style.mp4'), '-vf', 'select=eq(n\\,20)', '-frames:v', '1', process.env.KEEP_FRAMES]);
    // Ngoài chữ Footage (góc trên trái, cùng dải y) là matte trắng; dưới chữ video vẫn chạy.
    expect(Math.min(...rgb(16, 120))).toBeGreaterThan(230);
    const stem = rgb(270, 400);
    expect(Math.min(...stem), `stem ${stem}`).toBeLessThan(120);
    // Toạ độ chữ là mép trên trái. Hộp nền đỏ ở phần đệm bên trái chữ.
    const box = rgb(18, 1000);
    expect(box[0]! - box[2]!, `box ${box}`).toBeGreaterThan(100);
  });

  it('báo lỗi khi thiếu file cho một nguồn', async () => {
    await expect(exportJob({ ...job('x.mp4', source([]), 1), media: [] })).rejects.toThrow(/thiếu file/);
  });
});
