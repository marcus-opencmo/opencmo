/**
 * Gói chạy TRONG trình duyệt cho compat.spec: đúng code của editor (không chép lại),
 * phơi ra `window.compat` để Playwright gọi trên Chromium, Firefox và WebKit.
 */
import { browserFacts, deviceVerdict } from "@/lib/editor/device";
import { canWriteOpfs, readLocal, removeLocal, writeLocal } from "@/components/editor/library/local";

declare global {
  interface Window {
    compat: Record<string, (...args: never[]) => unknown>;
  }
}

window.compat = {
  facts: () => browserFacts(),
  verdict: () => deviceVerdict(browserFacts()),
  canWriteOpfs: () => canWriteOpfs(globalThis as never),
  async roundtrip(clipId: string, source: string) {
    const bytes = new Uint8Array(4096).map((_, index) => index % 251);
    await writeLocal(clipId, source, new Blob([bytes], { type: "image/png" }));
    const back = await readLocal(clipId, source);
    const same = back ? new Uint8Array(await back.arrayBuffer()).every((value, index) => value === bytes[index]) : false;
    await removeLocal(clipId, source);
    const gone = (await readLocal(clipId, source)) === null;
    return { size: back?.size ?? 0, type: back?.type ?? "", same, gone };
  },
};
