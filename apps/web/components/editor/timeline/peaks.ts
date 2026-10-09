/**
 * Sóng âm cho clip video/âm thanh trên timeline (checklist TML-04).
 *
 * Giải mã tiếng của cả file MỘT lần bằng `decodeAudioData` rồi giữ đỉnh biên
 * độ theo từng 1/100 giây — 100 số mỗi giây, đủ mịn ở mọi mức zoom mà timeline
 * cho phép, và nhỏ hơn bản PCM hàng nghìn lần. File không có tiếng (hay không
 * giải được) cho sóng rỗng chứ không báo lỗi: thiếu sóng không phải lý do để
 * clip biến mất.
 */

import { detectBeats, type BeatGrid } from "@opencmo/editor-core";

export const PEAK_RATE = 100;

export type Peaks = { rate: number; values: Float32Array };

const cache = new Map<string, Promise<Peaks | null>>();

export function loadPeaks(key: string, load: () => Promise<Blob | null>): Promise<Peaks | null> {
  let found = cache.get(key);
  if (!found) {
    found = (async () => {
      try {
        const blob = await load();
        if (!blob) return null;
        const bytes = await blob.arrayBuffer();
        // Offline context chỉ để giải mã: không phát gì, không đòi cử chỉ người dùng.
        const context = new OfflineAudioContext(1, 1, 44100);
        const audio = await context.decodeAudioData(bytes);
        return reduce(audio);
      } catch {
        return null;
      }
    })();
    cache.set(key, found);
  }
  return found;
}

function reduce(audio: AudioBuffer): Peaks {
  const step = Math.max(1, Math.round(audio.sampleRate / PEAK_RATE));
  const count = Math.ceil(audio.length / step);
  const values = new Float32Array(count);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let bucket = 0; bucket < count; bucket++) {
      let peak = values[bucket]!;
      const end = Math.min(data.length, (bucket + 1) * step);
      for (let index = bucket * step; index < end; index++) {
        const sample = Math.abs(data[index]!);
        if (sample > peak) peak = sample;
      }
      values[bucket] = peak;
    }
  }
  return { rate: PEAK_RATE, values };
}

/** Vẽ đoạn nguồn `[from, to)` giây vào canvas, đối xứng quanh giữa. */
export function drawPeaks(canvas: HTMLCanvasElement, peaks: Peaks, from: number, to: number, color: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  const span = Math.max(1e-6, to - from);
  for (let x = 0; x < width; x++) {
    const a = Math.floor((from + (x / width) * span) * peaks.rate);
    const b = Math.max(a + 1, Math.floor((from + ((x + 1) / width) * span) * peaks.rate));
    let peak = 0;
    for (let index = Math.max(0, a); index < Math.min(peaks.values.length, b); index++) {
      peak = Math.max(peak, peaks.values[index]!);
    }
    const h = Math.max(1, Math.min(1, peak) * height);
    ctx.fillRect(x, (height - h) / 2, 1, h);
  }
}

/**
 * Lưới beat của nhạc (học Palmier §B7) tính từ chính đường bao này, nhớ theo khoá nguồn
 * để timeline lấy làm điểm dính mà không phải chờ. null = chưa nạp hoặc không có nhịp.
 */
const beatCache = new Map<string, BeatGrid | null>();

export function beatsOf(key: string, peaks: Peaks): BeatGrid | null {
  if (!beatCache.has(key)) beatCache.set(key, detectBeats(peaks.values, peaks.rate));
  return beatCache.get(key) ?? null;
}

/** Beat đã tính của nguồn (giây NGUỒN), hoặc rỗng khi chưa có. */
export const knownBeats = (key: string): number[] => beatCache.get(key)?.beats ?? [];

/** Vạch beat mảnh ở mép dưới canvas sóng, cho đoạn nguồn `[from, to)` giây. */
export function drawBeats(canvas: HTMLCanvasElement, beats: number[], from: number, to: number, color: string): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || to <= from) return;
  ctx.fillStyle = color;
  const scale = canvas.width / (to - from);
  // Quá dày (zoom xa) thì vạch dính thành khối: bỏ qua.
  if (beats.length > 1 && (beats[1]! - beats[0]!) * scale < 4) return;
  for (const beat of beats) {
    if (beat < from || beat >= to) continue;
    ctx.fillRect(Math.round((beat - from) * scale), canvas.height - 5, 1, 5);
  }
}
