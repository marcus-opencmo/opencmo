"use client";

import type { ClipLength } from "@/lib/clipping-types";

import { CLIP_COUNTS, CLIP_LENGTH_OPTIONS } from "@/lib/clip-options";

export { CLIP_COUNTS, CLIP_LENGTH_OPTIONS };

export function ProjectSettings({
  count,
  clipLength,
  disabled,
  onCount,
  onClipLength,
}: {
  count: number;
  clipLength: ClipLength;
  disabled: boolean;
  onCount: (count: number) => void;
  onClipLength: (value: ClipLength) => void;
}) {
  return (
    <div className="project-settings">
      <label htmlFor="clip-count">
        Clips to find
        <select
          id="clip-count"
          value={count}
          disabled={disabled}
          onChange={(event) => onCount(Number(event.target.value))}
        >
          {CLIP_COUNTS.map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "clip" : "clips"}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="clip-length">
        Clip length
        <select
          id="clip-length"
          value={clipLength}
          disabled={disabled}
          onChange={(event) => onClipLength(event.target.value as ClipLength)}
        >
          {CLIP_LENGTH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
