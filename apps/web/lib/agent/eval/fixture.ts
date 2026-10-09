/**
 * Clip mẫu cho eval (spec agent-editor §6): document như bộ sinh project viết
 * cho một clip 9:16 dài 30 giây, transcript tổng hợp có từ đệm, từ lặp và hai
 * khoảng lặng dài, thư viện có một B-roll.
 *
 * Hình là `e2e/fixtures/talk-30s.mp4` (thẻ màu, không có người) — grader chấm
 * trên document, còn `capture` vẫn cho model thấy chữ, phụ đề, B-roll thật.
 * Transcript là tổng hợp: không khớp tiếng của file, nhưng mốc từ là thứ các
 * op cắt/phụ đề đọc.
 */

import { fileURLToPath } from "node:url";

import type { Manifest } from "@opencmo/clip-assets";
import type { ClipDocument } from "@opencmo/clip-doc";
import type { Transcript } from "@opencmo/editor-core";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const FIXTURE_FILES = {
  "assets/master.mp4": here("../../../e2e/fixtures/talk-30s.mp4"),
  "assets/broll.mp4": here("../../../e2e/fixtures/broll-5s.mp4"),
};
export const FONTS_DIR = here("../../../../../packages/clip-media/fonts");

/** Câu → từ có mốc đều trong `[start, end]`. */
function line(text: string, start: number, end: number) {
  const words = text.split(" ");
  const step = (end - start) / words.length;
  return {
    text,
    words: words.map((word, index) => ({
      text: word,
      start: Math.round((start + index * step) * 100) / 100,
      end: Math.round((start + (index + 0.85) * step) * 100) / 100,
    })),
  };
}

export const TRANSCRIPT: Transcript = [
  line("So here is the one thing nobody tells you about growing an audience", 0.3, 4.0),
  line("um", 4.2, 4.6),
  // Lặng 4.6 → 6.0
  line("You do not need more content uh you need better hooks", 6.0, 10.5),
  // Lặng 10.5 → 11.8
  line("Most people lose viewers in the first three seconds", 11.8, 16.0),
  line("so so start with the result then show how you got there", 16.2, 21.0),
  line("Try it on your next video and watch the numbers change", 21.5, 26.0),
  line("Follow for more tips like this", 26.3, 29.5),
];

export function fixtureDocument(): ClipDocument {
  return {
    version: 1,
    stage: {
      id: "stage0",
      background: "#000000",
      children: [
        {
          kind: "scene",
          id: "scene0",
          name: "Clip",
          width: 1080,
          height: 1920,
          fill: "#000000",
          active: true,
          workarea: [0, 30],
          marks: { reframe: { focus: 0.5, track: [], mode: "fill" } },
          children: [
            {
              kind: "video",
              id: "video0",
              x: -1166.67,
              y: 0,
              width: 3413.33,
              height: 1920,
              start: 0,
              sourceIn: 0,
              sourceOut: 30,
              src: "assets/master.mp4",
              objectFit: "cover",
            },
            {
              kind: "captions",
              id: "captions0",
              src: "assets/transcript.json",
              preset: "spotlight",
              colors: ["#ff7a59"],
              verticalAlign: "bottom",
              start: 0,
              sourceIn: 0,
              sourceOut: 30,
            },
          ],
        },
      ],
    },
  } as unknown as ClipDocument;
}

export function fixtureManifest(): Manifest {
  return {
    version: 1,
    folders: [],
    assets: [
      {
        id: "broll0",
        path: "assets/broll.mp4",
        source: "broll0",
        type: "VIDEO",
        mimeType: "video/mp4",
        createdAt: "2026-09-26T00:00:00.000Z",
        width: 1280,
        height: 720,
        duration: 5,
      },
    ],
  };
}

export const FIXTURE_DURATIONS: Record<string, number> = { "assets/master.mp4": 30, "assets/broll.mp4": 5 };
export const FIXTURE_MASTER = { width: 1280, height: 720 };

/** Tiêu đề + lý do chọn clip như bảng `clips` (engine ghi lúc chọn clip). */
export const FIXTURE_ABOUT = {
  hook: "Why your videos lose viewers in 3 seconds",
  reason: "A concrete, contrarian tip about hooks with a clear call to action.",
};
