"use client";

/**
 * Preview cảnh code 3D cho agent (spec code-scenes, browser tool `preview_3d`):
 * gửi code vào iframe sandbox `/sandbox/three.html` (origin mờ, CSP riêng, sinh
 * bởi `packages/clip-three/scripts/build-sandbox.mts`), nhận ảnh + báo cáo bố cục.
 *
 * Editor không bao giờ chạy code của agent trên origin của mình. Treo (vòng lặp
 * vô hạn) thì chỉ worker trong iframe treo: hết hạn là xoá iframe, lần sau tạo mới.
 */

import { frameSize, type Theme } from "@opencmo/clip-three";

type Report = { t: number; issues: string[]; coverage: number };
type Response =
  | { id: number; ok: true; images: ArrayBuffer[]; reports: Report[]; msPerFrame: number; triangles: number; renderer: string }
  | { id: number; ok: false; phase: "compile" | "build" | "frame"; message: string; at?: number };

export type Preview3DInput = { code: string; duration: number; aspect_ratio: string; theme?: Theme; seed?: number };
export type Preview3DResult = {
  images?: string[];
  data?: Record<string, unknown>;
  error?: string;
};

const SRC = "/sandbox/three.html";
/** Nửa độ phân giải export: agent nhìn ảnh ≤ 768px, vẽ nhanh gấp ~4 lần. */
const SCALE = 0.5;
const READY_MS = 15_000;
/** Dựng cảnh + chạy trước trạng thái cuối + 4 khung; quá lâu là code lặp vô hạn. */
const RUN_MS = 25_000;

const base64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

class Sandbox {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private next = 1;
  private waiting = new Map<number, (response: Response) => void>();
  private readyResolve: (() => void) | null = null;

  private readonly onMessage = (event: MessageEvent) => {
    // Origin mờ gửi với origin "null": nhận dạng bằng chính cửa sổ iframe.
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const data = event.data as { ready?: boolean } & Partial<Response>;
    if (data.ready) return void this.readyResolve?.();
    if (typeof data.id !== "number") return;
    // id -1: worker sập ngoài một yêu cầu (lỗi tải runtime) — trả cho mọi yêu cầu đang chờ.
    const targets = data.id === -1 ? [...this.waiting.keys()] : [data.id];
    for (const id of targets) {
      this.waiting.get(id)?.({ ...(data as Response), id });
      this.waiting.delete(id);
    }
  };

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none";
    frame.src = SRC;
    window.addEventListener("message", this.onMessage);
    this.frame = frame;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The 3D preview did not start.")), READY_MS);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    document.body.appendChild(frame);
    return this.ready;
  }

  /** Bỏ iframe (worker chết theo) — sau treo hoặc lỗi tải. */
  reset(): void {
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    this.readyResolve = null;
    for (const resolve of this.waiting.values()) resolve({ id: 0, ok: false, phase: "frame", message: "The 3D preview was reset." });
    this.waiting.clear();
  }

  /** `request`: PreviewRequest của worker (`packages/clip-three/src/code/worker.ts`) trừ `id`. */
  async run(request: Record<string, unknown>): Promise<Response> {
    try {
      await this.start();
    } catch (error) {
      this.reset();
      throw error;
    }
    const id = this.next++;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        // Code lặp vô hạn: worker không bao giờ trả lời. Xoá iframe là cách duy nhất dừng nó.
        this.waiting.delete(id);
        this.reset();
        resolve({ id, ok: false, phase: "frame", message: `The scene took longer than ${RUN_MS / 1000} s to draw (an endless loop?).` });
      }, RUN_MS);
      this.waiting.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.frame!.contentWindow!.postMessage({ ...request, id }, "*");
    });
  }
}

let sandbox: Sandbox | null = null;

/** Mốc preview: gần đầu, giữa, gần cuối, và trạng thái cuối (thứ đứng lâu nhất trên màn hình). */
export function previewTimes(duration: number): number[] {
  return [0.15, 0.45, 0.75].map((f) => Math.round(duration * f * 100) / 100).concat(Math.max(0, Math.round((duration - 0.05) * 100) / 100));
}

export async function preview3d(input: Preview3DInput): Promise<Preview3DResult> {
  sandbox ??= new Sandbox();
  const full = frameSize(input.aspect_ratio);
  const even = (value: number) => Math.max(64, Math.round((value * SCALE) / 2) * 2);
  const times = previewTimes(input.duration);
  const response = await sandbox.run({
    code: input.code,
    width: even(full.width),
    height: even(full.height),
    duration: input.duration,
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    times,
  });
  if (!response.ok) {
    const where = response.phase === "frame" && response.at !== undefined ? ` at ${response.at}s` : "";
    return { error: `The scene code failed (${response.phase}${where}): ${response.message}`.slice(0, 300) };
  }
  return {
    images: response.images.map(base64),
    data: {
      times,
      // Agent sửa theo đây: vật/nhãn nào lệch khung, ở giây nào.
      layout: response.reports.map((report) => ({ t: report.t, coverage: report.coverage, issues: report.issues })),
      ms_per_frame: Math.round(response.msPerFrame),
      triangles: response.triangles,
    },
  };
}
