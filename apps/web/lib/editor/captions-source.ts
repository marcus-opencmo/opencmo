/**
 * Phụ đề cho một phần tử media (E4-e), phần THUẦN dùng chung cho inspector và tool agent:
 * cùng một chỗ tìm nguồn, tính đoạn đang chiếu và giá — nút bấm và agent không thể báo
 * hai giá khác nhau cho cùng một phần tử.
 */

type Entity = Record<string, unknown>;

/** 1 credit/phút, làm tròn lên — cùng công thức `captions_credits` trong SQL. */
export const captionCredits = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/**
 * Nguồn media của phần tử: `video`/`audio` mang `src` thẳng; video thư viện là `rect` tô
 * bằng paint video (`nodeFor`), mốc nguồn nằm trên paint, thời điểm trên rect.
 */
export function mediaOf(node: Entity): { src: unknown; timing: Entity } | null {
  if (node.kind === "video" || node.kind === "audio") return { src: node.src, timing: node };
  if (node.kind !== "rect" || !Array.isArray(node.paints)) return null;
  const paint = (node.paints as Entity[]).find((item) => item.type === "video");
  return paint ? { src: paint.src, timing: { ...paint, start: node.start, end: node.end } } : null;
}

/** Đoạn nguồn phần tử đang chiếu (giây của file). */
export function sourceRange(timing: Entity, duration: number | undefined): { start: number; end: number } {
  const start = typeof timing.sourceIn === "number" ? timing.sourceIn : 0;
  const shown = typeof timing.end === "number" && typeof timing.start === "number" ? timing.end - timing.start : undefined;
  const end = typeof timing.sourceOut === "number" ? timing.sourceOut : duration ?? (shown !== undefined ? start + shown : start);
  return { start, end: duration !== undefined ? Math.min(end, duration) : end };
}

/** Lớp phụ đề khớp thời gian với phần tử nguồn: cùng start/end/sourceIn/sourceOut. */
export function captionsNode(timing: Entity, src: string, name: string): Entity {
  const node: Entity = { kind: "captions", name, src };
  for (const key of ["start", "end", "sourceIn", "sourceOut", "playbackRate"]) if (timing[key] !== undefined) node[key] = timing[key];
  return node;
}

export const TRANSCRIPT_SRC = /^assets\/transcripts\/([0-9a-f]{64})\.json$/;
