/**
 * Thời gian của TSX → giây.
 *
 * DS nhận bốn dạng: số giây, `"<n>f"` (frame ở 30 fps, đơn vị gốc của nó),
 * `"MM:SS"` và `"HH:MM:SS"`. Document chỉ giữ giây, nên mọi dạng quy về đây một
 * lần lúc đọc.
 */

export const FRAME_RATE = 30;

export function parseTime(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`time must be finite, got ${value}`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`time must be a number or string, got ${typeof value}`);
  const text = value.trim();
  const frames = /^(-?\d+(?:\.\d+)?)f$/.exec(text);
  if (frames) return Number(frames[1]) / FRAME_RATE;
  // Dấu âm áp cho cả chuỗi: "-01:30" là âm 90 giây, không phải -60 + 30.
  const clock = /^(-)?(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))(?::(\d+(?:\.\d+)?))?$/.exec(text);
  if (clock) {
    const parts = [clock[2], clock[3], clock[4]].filter((part) => part !== undefined).map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return clock[1] ? -seconds : seconds;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  throw new Error(`unrecognized time "${value}"`);
}
