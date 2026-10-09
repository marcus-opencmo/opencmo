/**
 * Phát preview: đồng hồ, thẻ media và tiếng qua WebAudio (spec editor-rewrite B2).
 *
 * Đồng hồ là `AudioContext.currentTime`, không phải `performance.now()`: tiếng
 * là thứ tai nghe thấy lệch trước, nên hình chạy theo tiếng chứ không ngược lại.
 *
 * Mỗi khung, với từng nguồn đang cần (hình hoặc tiếng), thẻ media của nguồn đó
 * phải đang chạy ở đúng giây của nguồn. Lệch quá `DRIFT` thì tua. Âm lượng lấy
 * từ `renderer.gains()` — cùng luật dB với export (clip-render `audio.ts`) —
 * đặt vào GainNode của thẻ, nên bus, track `volume`, `muted` nghe như bản xuất.
 */

import type { AssetInput } from "@opencmo/clip-doc";
import { FPS, type AudioClip, type Renderer } from "@opencmo/clip-render";

import { keyOf, mediaKeyOf, type BrowserMedia } from "./media";

/** Lệch hơn chừng này giữa thẻ và đồng hồ thì tua lại; nhỏ hơn thì tai không nghe ra. */
const DRIFT = 0.2;

type Want = { src: AssetInput; seconds: number; rate: number; gain: number };

/** Nguồn nào cần chạy ở giây nào tại `frame`, và to bao nhiêu. */
export function wanted(renderer: Renderer, frame: number, solo: string | null = null): Map<string, Want> {
  const out = new Map<string, Want>();
  const gains = renderer.gains(frame);
  const soloed = (clip: AudioClip) => {
    for (let r: AudioClip["node"] | null = clip.node; r; r = r.parent) {
      if ((r.node as { id?: string }).id === solo) return true;
    }
    return false;
  };
  renderer.audio.forEach((clip, index) => {
    if (frame < clip.start || frame >= clip.end) return;
    if (solo && !soloed(clip)) gains[index] = 0;
    const seconds = clip.sourceIn + ((frame - clip.start) / FPS) * clip.rate;
    const key = mediaKeyOf(clip.src, clip.node.node.kind);
    const found = out.get(key);
    if (!found || gains[index] > found.gain) out.set(key, { src: clip.src, seconds, rate: clip.rate, gain: gains[index] });
  });
  for (const need of renderer.needs(frame)) {
    if (need.kind !== "video" || out.has(keyOf(need.src))) continue;
    out.set(keyOf(need.src), { src: need.src, seconds: need.seconds, rate: 1, gain: 0 });
  }
  return out;
}

export class Playback {
  frame = 0;
  playing = false;
  private startFrame = 0;
  private startTime = 0;
  private raf = 0;
  renderer: Renderer | null = null;

  constructor(
    private media: BrowserMedia,
    /** Mỗi khung mới (đang phát) hay mỗi lần tua: canvas vẽ lại, UI cập nhật playhead. */
    private onFrame: (frame: number) => void,
    private onState: (playing: boolean) => void,
  ) {}

  /** Solo (checklist TML-07): chỉ node này và con cháu của nó kêu. Chỉ là cách NGHE, không vào file. */
  solo: string | null = null;

  /**
   * Tốc độ phát (J/K/L, KBD-13): 1 là thường; âm là chạy lùi. Chạy lùi không
   * phát được bằng thẻ media, nên thẻ đứng yên và mỗi khung tua tới đúng chỗ.
   */
  speed = 1;

  /** J/L: cùng chiều thì nhanh gấp đôi (tới 8×), ngược chiều thì quay đầu ở 1×. K dừng. */
  shuttle(direction: 1 | -1): void {
    const same = this.playing && Math.sign(this.speed) === direction;
    const next = same ? Math.max(-8, Math.min(8, this.speed * 2)) : direction;
    if (this.playing) {
      this.restart();
      this.speed = next;
    } else {
      this.speed = next;
      void this.play();
    }
  }

  /** Cả scene, không chỉ vùng làm việc: timeline cho tua tới bất kỳ đâu. */
  get range(): { start: number; end: number } {
    return { start: 0, end: this.renderer?.end ?? 0 };
  }

  seek(frame: number): void {
    const { start, end } = this.range;
    this.frame = Math.max(start, Math.min(Math.max(start, end - 1), Math.round(frame)));
    if (this.playing) this.restart();
    this.onFrame(this.frame);
  }

  async play(): Promise<void> {
    if (this.playing || !this.renderer) return;
    const context = this.media.audioContext();
    await context.resume();
    const { start, end } = this.range;
    if (this.speed > 0 && this.frame >= end - 1) this.frame = start;
    if (this.speed < 0 && this.frame <= start) this.frame = end - 1;
    this.playing = true;
    this.media.playing = true;
    this.restart();
    this.onState(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.media.playing = false;
    cancelAnimationFrame(this.raf);
    for (const [, entry] of this.media.entries()) entry.el.pause();
    this.silence();
    this.speed = 1;
    this.onState(false);
    this.onFrame(this.frame);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  dispose(): void {
    this.pause();
    cancelAnimationFrame(this.raf);
  }

  private restart(): void {
    this.startFrame = this.frame;
    this.startTime = this.media.audioContext().currentTime;
  }

  private tick = (): void => {
    if (!this.playing || !this.renderer) return;
    const elapsed = this.media.audioContext().currentTime - this.startTime;
    const frame = this.startFrame + Math.floor(elapsed * FPS * this.speed);
    const { start, end } = this.range;
    if (frame >= end || frame < start) {
      this.frame = frame < start ? start : Math.max(start, end - 1);
      this.pause();
      return;
    }
    if (frame !== this.frame) {
      this.frame = frame;
      this.sync(frame);
      this.onFrame(frame);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private sync(frame: number): void {
    const want = wanted(this.renderer!, frame, this.solo);
    for (const [key, entry] of this.elements()) {
      const target = want.get(key);
      const el = entry.el;
      if (!target) {
        if (!el.paused) el.pause();
        if (entry.gain) entry.gain.gain.value = 0;
        continue;
      }
      if (this.speed < 0) {
        // Lùi: thẻ đứng, tua từng khung, im tiếng.
        if (!el.paused) el.pause();
        if (!el.seeking) el.currentTime = target.seconds;
        if (entry.gain) entry.gain.gain.value = 0;
        continue;
      }
      const rate = target.rate * this.speed;
      if (el.playbackRate !== rate) el.playbackRate = rate;
      if (Math.abs(el.currentTime - target.seconds) > DRIFT * rate) el.currentTime = target.seconds;
      if (el.paused) void el.play().catch(() => undefined);
      if (entry.gain) entry.gain.gain.value = target.gain;
    }
  }

  private silence(): void {
    for (const [, entry] of this.elements()) if (entry.gain) entry.gain.gain.value = 0;
  }

  private *elements() {
    for (const [key, entry] of this.media.entries()) if (entry.ready) yield [key, entry] as const;
  }
}
