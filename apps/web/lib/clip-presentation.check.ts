import assert from "node:assert/strict";

import { outputBadge, segmentsForClip } from "@/components/clipping/clip-presentation";

const transcript = {
  version: 1,
  language: "en",
  source: "subs" as const,
  segments: [
    { start: 0, end: 4, text: "before", words: null },
    { start: 3.5, end: 7, text: "overlaps the clip", words: null },
    { start: 7, end: 10, text: "inside", words: null },
    { start: 12, end: 15, text: "after", words: null },
  ],
};

assert.deepEqual(
  segmentsForClip(transcript, 4, 12).map((segment) => segment.text),
  ["overlaps the clip", "inside"],
);
assert.equal(outputBadge("16:9", 1920, 1080, true), "Edited · 16:9 · 1920×1080");
assert.equal(outputBadge("1:1", undefined, undefined, false), "Preview · 1:1 · 1080×1080");

console.log("clip presentation: mọi kiểm tra xanh");
