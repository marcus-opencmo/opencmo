/**
 * Máy này mở được editor không — dò TÍNH NĂNG, không dò tên trình duyệt.
 *
 * Trước đây cổng chỉ cho Chromium (Q6 thời fork Diffusion Studio, cần WebCodecs).
 * Editor tự viết không dùng WebCodecs: preview vẽ Canvas 2D từ thẻ `<video>`, trộn
 * tiếng bằng WebAudio, thư viện ở OPFS (có đường IndexedDB khi thiếu
 * `createWritable`), export chạy trên server. Safari 17+ và Firefox đủ cả.
 *
 * Hàm thuần nhận `DeviceFacts` để kiểm được bằng script (`device.check.ts`).
 */

/** Khung nhỏ hơn mức này thì timeline và inspector không còn chỗ để dùng. */
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;

export type DeviceFacts = {
  width: number;
  height: number;
  /** Màn chạm là chính (điện thoại, máy tính bảng) — `(pointer: coarse)` mà không có chuột. */
  touchOnly: boolean;
  /** Chỗ giữ bytes thư viện trên máy: OPFS hoặc IndexedDB (`library/local.ts`). */
  storage: boolean;
  offscreen2d: boolean;
  audio: boolean;
  h264: boolean;
};

export type DeviceVerdict = { ok: true } | { ok: false; reason: "small" | "touch" | "codec" | "missing"; missing?: string[] };

export function deviceVerdict(facts: DeviceFacts): DeviceVerdict {
  if (facts.touchOnly) return { ok: false, reason: "touch" };
  if (facts.width < MIN_WIDTH || facts.height < MIN_HEIGHT) return { ok: false, reason: "small" };
  const missing = [
    ...(facts.storage ? [] : ["local file storage"]),
    ...(facts.offscreen2d ? [] : ["offscreen canvas"]),
    ...(facts.audio ? [] : ["Web Audio"]),
  ];
  if (missing.length) return { ok: false, reason: "missing", missing };
  // Chromium mã nguồn mở (bản Playwright, vài bản Linux) không giải được H.264 —
  // mà master luôn là H.264. Thiếu chốt này thì preview đen im lặng.
  if (!facts.h264) return { ok: false, reason: "codec" };
  return { ok: true };
}

/** Đọc sự thật từ trình duyệt đang chạy. */
export function browserFacts(): DeviceFacts {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const fine = window.matchMedia?.("(any-pointer: fine)").matches ?? true;
  let offscreen2d = false;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    offscreen2d = Boolean(canvas.getContext("2d")) && typeof canvas.convertToBlob === "function";
  } catch {
    offscreen2d = false;
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    touchOnly: coarse && !fine,
    storage: typeof navigator.storage?.getDirectory === "function" || typeof indexedDB !== "undefined",
    offscreen2d,
    // Editor gọi `new AudioContext()` không tiền tố; Safari có bản không tiền tố từ 14.1.
    audio: typeof window.AudioContext === "function",
    h264: Boolean(document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"')),
  };
}
