/**
 * Trang ứng viên: `@opencmo/clip-render` vẽ mẫu trong Chromium, cùng trình
 * duyệt với oracle DS. `scripts/candidate.mjs --target browser` điều khiển nó.
 */

import { createRenderer, FONTS, type MediaHost, type Transcript } from '@opencmo/clip-render';
import type { AssetInput, ClipDocument } from '@opencmo/clip-doc';

type Input = {
  document: ClipDocument;
  /** khoá nguồn → URL ảnh; khoá khung video là `${khoá}@${giây}`. */
  files: Record<string, string>;
  durations: Record<string, number>;
  transcripts: Record<string, Transcript>;
  times: number[];
};

/** Nạp 10 họ font như preview thật: FontFace với dải weight của file variable. */
const fontsReady = Promise.all(
  Object.entries(FONTS).flatMap(([family, entry]) =>
    [
      [entry.file, 'normal'],
      ['italic' in entry ? entry.italic : null, 'italic'],
    ]
      .filter((pair): pair is [string, string] => pair[0] !== null)
      .map(async ([file, style]) => {
        const face = new FontFace(family, `url(/fonts/${file})`, { weight: `${entry.weights[0]} ${entry.weights[1]}`, style });
        document.fonts.add(await face.load());
      }),
  ),
);

const key = (src: AssetInput) => (typeof src === 'string' ? src : JSON.stringify(src));

async function render(input: Input): Promise<string[]> {
  await fontsReady;
  const bitmaps = new Map<string, ImageBitmap>();
  await Promise.all(
    Object.entries(input.files).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      bitmaps.set(name, await createImageBitmap(await response.blob()));
    }),
  );
  const media: MediaHost = {
    image: (src) => bitmaps.get(key(src)) ?? 'failed',
    video: (src, seconds) => bitmaps.get(`${key(src)}@${seconds}`) ?? null,
    duration: (src) => input.durations[key(src)] ?? null,
    transcript: (src) => input.transcripts[src] ?? null,
  };
  const renderer = createRenderer(input.document, media);
  const canvas = new OffscreenCanvas(renderer.scene.width, renderer.scene.height);
  const ctx = canvas.getContext('2d')!;
  const out: string[] = [];
  for (const time of input.times) {
    renderer.render(ctx as never, renderer.exportFrame(time));
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    out.push(btoa(binary));
  }
  return out;
}

(window as unknown as { candidate: unknown }).candidate = { render, ready: true };
