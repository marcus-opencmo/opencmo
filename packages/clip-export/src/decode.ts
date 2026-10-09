/**
 * Khung video cho exporter: mỗi luồng là MỘT tiến trình ffmpeg giải mã tuần tự
 * ra RGBA, giữ đúng một khung trong RAM. Seek đặt `-ss` TRƯỚC `-i` (không giải
 * từ đầu file). Luật chọn khung như DS: khung đầu tiên có chỉ số
 * ≥ `round(giây · fps)`.
 *
 * Một nguồn có thể cần nhiều luồng cùng lúc — hai đoạn cắt của cùng master nằm
 * trong một chuyển cảnh — nên mỗi nguồn có một nhóm luồng nhỏ.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { createCanvas, type Canvas, type ImageData } from '@napi-rs/canvas';

import type { Probe } from './probe.ts';
import { USER_INPUT } from './inputs.ts';

/** Đọc tiếp tối đa chừng này khung thay vì mở luồng mới. */
const SKIP_LIMIT_SECONDS = 2;
/** Số luồng tối đa cho một nguồn; thêm nữa thì mở lại luồng dùng lâu nhất. */
const STREAMS_PER_SOURCE = 3;

class Stream {
  readonly canvas: Canvas;
  private readonly image: ImageData;
  private process: ChildProcessByStdio<null, Readable, null> | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private waiter: (() => void) | null = null;
  /** Chỉ số của khung đang nằm trong `canvas`; −1 = chưa có. */
  current = -1;
  /** Chỉ số khung kế tiếp ffmpeg sẽ trả. */
  private next = 0;
  lastUsed = 0;
  private readonly file: string;
  private readonly info: NonNullable<Probe['video']>;

  constructor(file: string, info: NonNullable<Probe['video']>) {
    this.file = file;
    this.info = info;
    this.canvas = createCanvas(info.width, info.height);
    this.image = this.canvas.getContext('2d').createImageData(info.width, info.height);
  }

  private get frameBytes() {
    return this.info.width * this.info.height * 4;
  }

  /** Còn đọc tới được `index` mà không mở lại ffmpeg. */
  reaches(index: number): boolean {
    if (index === this.current) return true;
    return this.process !== null && index >= this.next && index - this.next < SKIP_LIMIT_SECONDS * this.info.fps;
  }

  private open(index: number) {
    this.close();
    const filters = [this.info.matrix ? `scale=in_color_matrix=${this.info.matrix}` : null, 'format=rgba']
      .filter(Boolean)
      .join(',');
    // Một luồng giải mã: ~190 MB thay vì ~280 MB mỗi tiến trình (đo trên
    // 1080×1920). Giải mã chưa bao giờ là chỗ chậm — chép pixel mới là.
    // `-fps_mode passthrough` là bắt buộc: muxer rawvideo mặc định CFR, và khung
    // đầu sau seek lệch nửa khung bị nhân đôi — mọi khung trễ một nhịp.
    // Nửa khung trước khung cần: ffmpeg trả khung đầu tiên có pts ≥ mốc seek.
    const seek = Math.max(0, (index - 0.5) / this.info.fps);
    const child = spawn(
      'ffmpeg',
      // File media của người dùng: chỉ demuxer media thường (inputs.ts).
      ['-v', 'error', '-nostdin', '-threads', '1', '-ss', seek.toFixed(6), ...USER_INPUT, '-i', this.file, '-an', '-sn', '-vf', filters, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.process = child;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.next = index;
    child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      // Chặn ffmpeg chạy trước quá hai khung: đây là cái giữ RAM phẳng.
      if (this.buffered >= this.frameBytes * 2) child.stdout.pause();
      this.wake();
    });
    child.stdout.on('end', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /** Đọc đúng một khung vào `image`; false khi hết file. */
  private async readFrame(): Promise<boolean> {
    const need = this.frameBytes;
    while (this.buffered < need && !this.ended) {
      this.process?.stdout.resume();
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
    if (this.buffered < need) return false;
    const target = this.image.data;
    let written = 0;
    while (written < need) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, need - written);
      target.set(chunk.subarray(0, take), written);
      written += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.buffered -= need;
    if (this.buffered < need * 2) this.process?.stdout.resume();
    return true;
  }

  async seek(index: number): Promise<void> {
    if (index === this.current) return;
    if (!this.reaches(index)) this.open(index);
    let painted = false;
    while (this.next <= index) {
      if (!(await this.readFrame())) break;
      this.next++;
      painted = true;
    }
    if (painted) this.canvas.getContext('2d').putImageData(this.image, 0, 0);
    // Hết file trước khung cần: giữ khung cuối đã có (DS kẹp về khung cuối).
    this.current = painted || this.current >= 0 ? Math.min(index, this.next - 1) : -1;
  }

  close() {
    this.process?.kill('SIGKILL');
    this.process = null;
  }
}

export class VideoFrames {
  private readonly pools = new Map<string, Stream[]>();
  private clock = 0;
  /** Luồng đã giao trong khung đang chuẩn bị: không được dời sang chỉ số khác. */
  private claimed = new Set<Stream>();

  private readonly sources: Map<string, { file: string; probe: Probe }>;

  constructor(sources: Map<string, { file: string; probe: Probe }>) {
    this.sources = sources;
  }

  /** Gọi trước khi chuẩn bị mỗi khung xuất. */
  beginFrame() {
    this.claimed = new Set();
    this.clock++;
  }

  async frame(key: string, seconds: number): Promise<Canvas | 'failed'> {
    const source = this.sources.get(key);
    const info = source?.probe.video;
    if (!source || !info) return 'failed';
    const index = Math.min(info.frames - 1, Math.max(0, Math.round(seconds * info.fps)));
    const pool = this.pools.get(key) ?? [];
    this.pools.set(key, pool);
    const free = pool.filter((stream) => !this.claimed.has(stream) || stream.current === index);
    let stream =
      free.find((candidate) => candidate.current === index) ??
      free.filter((candidate) => candidate.reaches(index)).sort((a, b) => b.current - a.current)[0];
    if (!stream) {
      if (pool.length < STREAMS_PER_SOURCE) {
        stream = new Stream(source.file, info);
        pool.push(stream);
      } else {
        stream = free.sort((a, b) => a.lastUsed - b.lastUsed)[0] ?? pool[0]!;
      }
    }
    this.claimed.add(stream);
    stream.lastUsed = this.clock;
    await stream.seek(index);
    return stream.current < 0 ? 'failed' : stream.canvas;
  }

  close() {
    for (const pool of this.pools.values()) for (const stream of pool) stream.close();
  }
}
