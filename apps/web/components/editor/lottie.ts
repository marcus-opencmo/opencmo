/**
 * Lottie cho preview: Skottie của CanvasKit — cùng engine Skia mà export dùng
 * (`LottieAnimation` của @napi-rs/canvas), nên khung preview khớp khung xuất.
 *
 * CanvasKit bản full nặng 8 MB wasm: chỉ nạp khi document THẬT SỰ có lottie
 * (lần đầu renderer xin khung), không nạp theo trang. Renderer vẽ đồng bộ, nên
 * trong lúc nạp trả `null` (lớp trống) rồi báo `onChange` để vẽ lại — như ảnh.
 *
 * Mỗi animation một canvas + surface phần mềm theo cỡ pixel renderer xin; cỡ đổi
 * (phóng bằng keyframe) thì cấp lại, không giữ một surface cho từng cỡ.
 */

import type { CanvasKit, ManagedSkottieAnimation, Surface } from "canvaskit-wasm";

import type { AssetInput } from "@opencmo/clip-doc";
import { builtinLottieName, lottieTime, type MediaResult } from "@opencmo/clip-render";

let kit: Promise<CanvasKit> | null = null;

function canvasKit(): Promise<CanvasKit> {
  kit ??= import("canvaskit-wasm/bin/full/canvaskit.js").then(({ default: init }) =>
    // `new URL(…, import.meta.url)`: bundler phát file wasm thành asset cùng
    // origin (CSP `default-src 'self'`), không lấy từ CDN.
    init({ locateFile: () => new URL("canvaskit-wasm/bin/full/canvaskit.wasm", import.meta.url).href }),
  );
  return kit;
}

type Entry = {
  state: "loading" | "failed" | "ready";
  animation?: ManagedSkottieAnimation;
  canvas?: HTMLCanvasElement;
  surface?: Surface;
};

export class LottieFrames {
  private entries = new Map<string, Entry>();
  private ck: CanvasKit | null = null;

  constructor(
    /** Chữ JSON của một nguồn (thư viện, OPFS, hay bộ có sẵn). */
    private text: (src: AssetInput) => Promise<string | null>,
    private onChange: () => void,
  ) {}

  frame(src: AssetInput, seconds: number, width: number, height: number, loop: boolean): MediaResult {
    const key = typeof src === "string" ? src : JSON.stringify(src);
    const entry = this.entries.get(key);
    if (!entry) {
      void this.load(key, src);
      return null;
    }
    if (entry.state !== "ready" || !entry.animation || !this.ck) return entry.state === "failed" ? "failed" : null;
    const animation = entry.animation;
    if (!entry.canvas || entry.canvas.width !== width || entry.canvas.height !== height) {
      entry.surface?.delete();
      entry.canvas = document.createElement("canvas");
      entry.canvas.width = width;
      entry.canvas.height = height;
      entry.surface = this.ck.MakeSWCanvasSurface(entry.canvas) ?? undefined;
    }
    const surface = entry.surface;
    if (!surface) return "failed";
    const length = animation.duration();
    const fps = animation.fps() || 30;
    const time = lottieTime(seconds, length, fps, loop);
    const canvas = surface.getCanvas();
    canvas.clear(this.ck.TRANSPARENT);
    animation.seekFrame(time * fps);
    animation.render(canvas, this.ck.LTRBRect(0, 0, width, height));
    surface.flush();
    return entry.canvas;
  }

  /** Nguồn hỏng được thử lại khi thư viện đổi (như ảnh và video). */
  retryFailed(): boolean {
    let retry = false;
    for (const [key, entry] of this.entries) if (entry.state === "failed") (this.entries.delete(key), (retry = true));
    return retry;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.animation?.delete();
      entry.surface?.delete();
    }
    this.entries.clear();
  }

  private async load(key: string, src: AssetInput): Promise<void> {
    const entry: Entry = { state: "loading" };
    this.entries.set(key, entry);
    try {
      const [ck, json] = await Promise.all([canvasKit(), this.text(src)]);
      this.ck = ck;
      const animation = json ? ck.MakeManagedAnimation(json) : null;
      if (animation) {
        entry.animation = animation;
        entry.state = "ready";
      } else entry.state = "failed";
    } catch {
      entry.state = "failed";
    }
    if (this.entries.get(key) === entry) this.onChange();
  }
}

/** Bộ có sẵn (`builtin:<tên>`) phục vụ ở `/lottie/` (chép từ `packages/clip-media/lottie`), cùng origin. */
export function builtinLottieUrl(src: AssetInput): string | null {
  const name = builtinLottieName(src);
  return name ? `/lottie/${name}.json` : null;
}
