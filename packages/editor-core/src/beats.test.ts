import { describe, expect, it } from 'vitest';

import { detectBeats } from './beats';

const RATE = 100;

/** Đường bao của một track gõ đều: đỉnh ở mỗi beat rồi tắt dần, có nhiễu nền. */
function clicks(bpm: number, seconds: number, offset = 0, seed = 1): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let state = seed;
  const noise = () => ((state = (state * 16807) % 2147483647) / 2147483647) * 0.05;
  const period = 60 / bpm;
  for (let index = 0; index < out.length; index++) {
    const t = index / RATE;
    const since = (((t - offset) % period) + period) % period;
    out[index] = 0.05 + 0.8 * Math.exp(-since * 18) + noise();
  }
  return out;
}

describe('detectBeats (học Palmier §B7)', () => {
  it('nhạc 120 BPM: ra 120 ± 1, beat trùng nhịp gõ trong 20 ms', () => {
    const grid = detectBeats(clicks(120, 20, 0.13), RATE)!;
    expect(grid.bpm).toBeGreaterThan(119);
    expect(grid.bpm).toBeLessThan(121);
    expect(grid.confidence).toBeGreaterThan(0.3);
    for (const beat of grid.beats.slice(1, 10)) {
      const off = (((beat - 0.13) % 0.5) + 0.5) % 0.5;
      expect(Math.min(off, 0.5 - off)).toBeLessThan(0.02);
    }
  });

  it('nhịp lẻ (97 BPM) và nhanh (174 BPM) không nhảy sang nửa/gấp đôi', () => {
    expect(Math.abs(detectBeats(clicks(97, 24), RATE)!.bpm - 97)).toBeLessThan(1.5);
    expect(Math.abs(detectBeats(clicks(174, 20), RATE)!.bpm - 174)).toBeLessThan(2);
  });

  it('không có nhịp (nhiễu, im lặng, quá ngắn): null', () => {
    let state = 7;
    const random = new Float32Array(20 * RATE).map(() => ((state = (state * 16807) % 2147483647) / 2147483647) * 0.6);
    expect(detectBeats(random, RATE)).toBeNull();
    expect(detectBeats(new Float32Array(20 * RATE), RATE)).toBeNull();
    expect(detectBeats(clicks(120, 2), RATE)).toBeNull();
    // Giống lời nói: âm tiết cách nhau ngẫu nhiên 0.12–0.45 s, có ngắt câu.
    const speech = new Float32Array(30 * RATE);
    let seed = 3;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0.2; t < 29; t += 0.12 + next() * 0.33 + (next() < 0.1 ? 0.6 : 0)) {
      const start = Math.round(t * RATE);
      for (let k = 0; k < 15 && start + k < speech.length; k++) speech[start + k] = Math.max(speech[start + k]!, (0.3 + next() * 0.5) * Math.exp(-k / 6));
    }
    expect(detectBeats(speech, RATE)).toBeNull();
  });
});
