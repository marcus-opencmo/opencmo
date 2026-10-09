import type {
  AspectRatio,
  TranscriptArtifact,
  TranscriptSegment,
} from "@/lib/clipping-types";

const OUTPUT_SIZES: Record<AspectRatio, readonly [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "16:9": [1920, 1080],
};

/** Một câu giao với clip dù bắt đầu hơi sớm vẫn thuộc transcript của clip đó. */
export function segmentsForClip(
  transcript: TranscriptArtifact["transcript"] | null,
  start: number,
  end: number,
): TranscriptSegment[] {
  return (transcript?.segments ?? []).filter(
    (segment) => segment.end > start && segment.start < end,
  );
}

export function outputBadge(
  aspect: AspectRatio,
  width: number | undefined,
  height: number | undefined,
  edited: boolean,
): string {
  const fallback = OUTPUT_SIZES[aspect];
  return `${edited ? "Edited" : "Preview"} · ${aspect} · ${width ?? fallback[0]}×${height ?? fallback[1]}`;
}
