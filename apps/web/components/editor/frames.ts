/**
 * Frame nào của thẻ `<video>` ĐÃ hiện ra — qua `requestVideoFrameCallback`.
 *
 * Chromium vẽ được frame mới ngay khi `seeked`; Safari thì `seeked` có thể tới trước
 * khi frame được giải mã xong, và `drawImage` lúc đó vẽ frame CŨ (preview và
 * `capture`/`save_frame` lệch một nhịp). rVFC báo `mediaTime` của frame thật sự đã
 * hiện. Chỉ tin nó với thẻ đã từng báo ít nhất một lần: thẻ không gắn vào DOM có thể
 * không bao giờ nhận callback, và khi đó vẫn đi đường cũ (`seeked` + `currentTime`).
 */

type FrameMeta = { mediaTime: number };
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, meta: FrameMeta) => void) => number;
};

const presented = new WeakMap<HTMLVideoElement, number>();

/** Theo dõi frame đã hiện của một thẻ; `onFrame` chạy mỗi khi có frame mới (để vẽ lại). */
export function watchFrames(el: HTMLVideoElement, onFrame: () => void): void {
  const video = el as FrameVideo;
  if (typeof video.requestVideoFrameCallback !== "function") return;
  const next = () =>
    video.requestVideoFrameCallback!((_now, meta) => {
      const first = !presented.has(el);
      const previous = presented.get(el);
      presented.set(el, meta.mediaTime);
      // Lúc đang phát, Playback tự vẽ theo đồng hồ; chỉ báo khi frame đổi lúc đứng yên.
      if (first || (el.paused && previous !== meta.mediaTime)) onFrame();
      next();
    });
  next();
}

/** Frame đang hiện có phải frame của giây `seconds` không. Không biết (không có rVFC) thì coi như có. */
export function framePresented(el: HTMLVideoElement, seconds: number, tolerance = 1 / 24): boolean {
  const shown = presented.get(el);
  if (shown === undefined) return true;
  return Math.abs(shown - seconds) <= tolerance;
}

/** Chờ frame kế tiếp hiện ra (tối đa `timeout` ms) — cho thẻ tạm của `media_grab`. */
export function nextFrame(el: HTMLVideoElement, timeout: number): Promise<void> {
  const video = el as FrameVideo;
  if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    video.requestVideoFrameCallback!(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
