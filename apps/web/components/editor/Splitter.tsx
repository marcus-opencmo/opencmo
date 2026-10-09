"use client";

/**
 * Tay kéo ở mép một panel (vạch mảnh, vùng bắt chuột rộng hơn — như
 * `PaddedDividerSplitViewController` của Palmier). Kéo xong mới lưu; nhấp đúp về
 * cỡ mặc định; mũi tên bàn phím nhích 20px.
 */

import { useRef } from "react";

export function Splitter({
  edge,
  size,
  min,
  onResize,
  onReset,
  label,
  testid,
}: {
  edge: "left" | "right" | "top";
  size: number;
  min: number;
  onResize: (size: number, persist: boolean) => void;
  onReset: () => void;
  label: string;
  testid?: string;
}) {
  const drag = useRef<{ at: number; size: number } | null>(null);
  const vertical = edge !== "top";
  // Mép trái/trên: kéo ra xa panel (âm) là panel to ra.
  const sign = edge === "right" ? 1 : -1;
  const pointer = (event: React.PointerEvent) => (vertical ? event.clientX : event.clientY);
  const next = (event: React.PointerEvent) => drag.current!.size + sign * (pointer(event) - drag.current!.at);

  return (
    <div
      className={`ed2-split ed2-split-${edge}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid={testid}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        // Cỡ đang VẼ, không phải cỡ đã lưu: thiếu chỗ thì lưới co panel về MIN,
        // bắt đầu từ cỡ lưu thì panel nhảy ngay cú kéo đầu.
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        drag.current = { at: pointer(event), size: box ? (vertical ? box.width : box.height) : size };
      }}
      onPointerMove={(event) => {
        if (drag.current) onResize(next(event), false);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        onResize(next(event), true);
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const keys = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (!keys.includes(event.key)) return;
        // Mũi tên ở đây là của tay kéo, không phải nhích lớp trên canvas.
        event.preventDefault();
        event.stopPropagation();
        const grow = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        onResize(size + (edge === "top" ? -grow : sign * grow) * 20, true);
      }}
    />
  );
}
