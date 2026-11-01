"use client";

import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/**
 * The border between two columns, draggable and keyboard-resizable (the separator pattern react-resizable-panels and
 * VS Code use: arrows, Home/End, Enter to reset). A 1 px line with an 8 px hit area.
 *
 * While dragging only `onLive` runs (it writes a CSS variable); the shell's state changes once, on release.
 */
export function Sash({
  label,
  controls,
  value,
  min,
  max,
  onLive,
  onCommit,
  onReset,
  disabled = false,
}: {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  onLive: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
  /** Kept in the grid but inert: a collapsed rail has no width to set. */
  disabled?: boolean;
}) {
  const drag = useRef<{ x: number; from: number; last: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, from: value, last: value };
    document.documentElement.dataset.v2Resizing = "";
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.last = clamp(state.from + event.clientX - state.x);
    onLive(state.last);
  };
  const end = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    delete document.documentElement.dataset.v2Resizing;
    if (state.last !== state.from) onCommit(state.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next =
      event.key === "ArrowLeft" ? value - step
      : event.key === "ArrowRight" ? value + step
      : event.key === "Home" ? min
      : event.key === "End" ? max
      : null;
    if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    onCommit(clamp(next));
  };

  if (disabled) return <div className="v2-sash" aria-hidden="true" data-disabled="" />;
  return (
    <div
      className="v2-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
