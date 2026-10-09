/**
 * Node cho một asset thư viện — một luật cho cả kéo thả trong editor
 * (`library/store.ts`) lẫn tool `insert_asset` của agent (server). Thuần: không
 * DOM, không fetch.
 */

import { stemOf, type LibraryRecord } from "@opencmo/clip-assets";

type Entity = Record<string, unknown> & { id?: string };

/** Tên kế tiếp dạng "broll 1": như fork đặt cho element chèn từ thư viện. */
function nextName(scene: Entity, prefix: string): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  let max = 0;
  const visit = (entity: Entity) => {
    const match = typeof entity.name === "string" ? pattern.exec(entity.name) : null;
    if (match) max = Math.max(max, Number(match[1]));
    for (const key of ["children", "masks"]) for (const child of (entity[key] as Entity[] | undefined) ?? []) visit(child);
  };
  visit(scene);
  return `${prefix} ${max + 1}`;
}

const AUDIO_SIZE = { width: 500, height: 150 };

/**
 * Node cho một asset, như fork chèn: video/ảnh là hình chữ nhật giữ tỉ lệ với
 * một paint của nó, âm thanh là `<audio>` 500×150. `at` là tâm (toạ độ scene);
 * thiếu thì giữa scene. `start` giây; 0 thì không ghi.
 */
export function nodeFor(
  record: LibraryRecord,
  scene: Entity,
  options: { at?: { x: number; y: number }; start: number },
): Record<string, unknown> | null {
  const name = nextName(scene, stemOf(record.path));
  const size =
    record.type === "AUDIO"
      ? AUDIO_SIZE
      : typeof record.width === "number" && typeof record.height === "number"
        ? { width: Math.round(record.width), height: Math.round(record.height) }
        : null;
  const W = Number(scene.width) || 0;
  const H = Number(scene.height) || 0;
  // Lottie vẽ theo vector: cỡ gốc của file (thường 400–1080) chẳng nói gì về
  // cỡ trên clip — đặt cạnh dài bằng 40% cạnh ngắn của khung, giữ tỉ lệ.
  if (record.type === "LOTTIE" && size && W && H) {
    const factor = (0.4 * Math.min(W, H)) / Math.max(size.width, size.height);
    size.width = Math.round(size.width * factor);
    size.height = Math.round(size.height * factor);
  }
  const position = size
    ? options.at
      ? { x: Math.round(options.at.x - size.width / 2), y: Math.round(options.at.y - size.height / 2) }
      : { x: Math.round((W - size.width) / 2), y: Math.round((H - size.height) / 2) }
    : {};
  const timing: { start?: number; end?: number } = options.start > 0 ? { start: Math.round(options.start * 1e4) / 1e4 } : {};
  // Độ dài đo lúc nhập: ghi `end` để hàng timeline biết clip chiếm tới đâu ngay cả khi
  // editor chưa nạp xong file (thiếu thì renderer coi là 16 s và b-roll kế tiếp tưởng bị chồng).
  if ((record.type === "VIDEO" || record.type === "AUDIO") && typeof record.duration === "number" && record.duration > 0) {
    timing.end = Math.round((options.start + record.duration) * 1e4) / 1e4;
  }
  switch (record.type) {
    case "VIDEO":
    case "IMAGE":
      return {
        kind: "rect",
        name,
        ...position,
        ...(size ?? {}),
        keepAspectRatio: true,
        ...timing,
        paints: [{ type: record.type === "VIDEO" ? "video" : "image", src: record.path }],
      };
    case "AUDIO":
      return { kind: "audio", name, ...position, ...AUDIO_SIZE, ...timing, src: record.path };
    case "TRANSCRIPT":
      return { kind: "captions", src: record.path, ...timing };
    case "LOTTIE":
      return { kind: "lottie", name, ...position, ...(size ?? {}), ...timing, src: record.path };
    default:
      return null;
  }
}
