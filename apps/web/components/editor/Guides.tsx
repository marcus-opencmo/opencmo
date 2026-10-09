"use client";

/**
 * Lưới và vùng an toàn trên preview (E4-d, học Palmier): lưới 1/3, tâm, Action safe 93% +
 * Title safe 90%, khung tham chiếu 9:16 / 1:1 / 1.85 / 2.39. Chỉ là SVG phủ lên canvas theo
 * camera, không vào document nên không bao giờ lọt vào bản export.
 */

import { useEffect, useRef, useState } from "react";

import type { Camera } from "./camera";

export type GuideSettings = {
  thirds: boolean;
  center: boolean;
  safe: boolean;
  frame: number | null;
};

const KEY = "opencmo.editor.guides";
const OFF: GuideSettings = {
  thirds: false,
  center: false,
  safe: false,
  frame: null,
};
const FRAMES = [
  { label: "9:16", ratio: 9 / 16 },
  { label: "1:1", ratio: 1 },
  { label: "1.85:1", ratio: 1.85 },
  { label: "2.39:1", ratio: 2.39 },
];

/** Lựa chọn nhớ theo trình duyệt; localStorage có thể ném (chế độ riêng tư) nên luôn bọc. */
export function useGuides(): [GuideSettings, (next: GuideSettings) => void] {
  const [guides, setGuides] = useState<GuideSettings>(OFF);
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(KEY) ?? "null",
      ) as Partial<GuideSettings> | null;
      if (saved) setGuides({ ...OFF, ...saved });
    } catch {
      // không đọc được thì giữ mặc định tắt
    }
  }, []);
  const update = (next: GuideSettings) => {
    setGuides(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // chỉ mất phần nhớ, guides vẫn chạy
    }
  };
  return [guides, update];
}

export const anyGuide = (guides: GuideSettings) =>
  guides.thirds || guides.center || guides.safe || guides.frame !== null;

/** Hộp lớn nhất tỉ lệ `ratio` nằm giữa khung w × h. */
export function referenceBox(
  w: number,
  h: number,
  ratio: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(w, h * ratio);
  const height = width / ratio;
  return { x: (w - width) / 2, y: (h - height) / 2, width, height };
}

export function GuidesOverlay({
  guides,
  camera,
  width,
  height,
}: {
  guides: GuideSettings;
  camera: Camera;
  width: number;
  height: number;
}) {
  if (!anyGuide(guides) || !width || !height) return null;
  const w = width * camera.scale;
  const h = height * camera.scale;
  const inset = (percent: number) => {
    const dx = (w * (1 - percent)) / 2;
    const dy = (h * (1 - percent)) / 2;
    return <rect x={dx} y={dy} width={w - 2 * dx} height={h - 2 * dy} />;
  };
  const ref = guides.frame !== null ? referenceBox(w, h, guides.frame) : null;
  return (
    <svg
      data-testid="editor-guides"
      className="ed2-guides"
      style={{ left: camera.x, top: camera.y, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
    >
      {ref ? (
        <g data-guide="frame">
          <path
            className="ed2-guide-dim"
            fillRule="evenodd"
            d={`M0 0H${w}V${h}H0Z M${ref.x} ${ref.y}h${ref.width}v${ref.height}h${-ref.width}Z`}
          />
          <rect
            className="ed2-guide-frame"
            x={ref.x}
            y={ref.y}
            width={ref.width}
            height={ref.height}
          />
        </g>
      ) : null}
      {guides.thirds ? (
        <g className="ed2-guide-line" data-guide="thirds">
          {[1, 2].map((i) => (
            <line
              key={`v${i}`}
              x1={(w * i) / 3}
              x2={(w * i) / 3}
              y1={0}
              y2={h}
            />
          ))}
          {[1, 2].map((i) => (
            <line
              key={`h${i}`}
              y1={(h * i) / 3}
              y2={(h * i) / 3}
              x1={0}
              x2={w}
            />
          ))}
        </g>
      ) : null}
      {guides.center ? (
        <g className="ed2-guide-line" data-guide="center">
          <line x1={w / 2 - 12} x2={w / 2 + 12} y1={h / 2} y2={h / 2} />
          <line y1={h / 2 - 12} y2={h / 2 + 12} x1={w / 2} x2={w / 2} />
        </g>
      ) : null}
      {guides.safe ? (
        <g className="ed2-guide-safe" data-guide="safe">
          {inset(0.93)}
          {inset(0.9)}
        </g>
      ) : null}
    </svg>
  );
}

export function GuidesMenu({
  guides,
  onChange,
}: {
  guides: GuideSettings;
  onChange: (next: GuideSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const toggle = (key: "thirds" | "center" | "safe") =>
    onChange({ ...guides, [key]: !guides[key] });
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="ed2-btn"
        data-testid="guides-toggle"
        aria-pressed={anyGuide(guides)}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Guides
      </button>
      {open ? (
        <div className="ed2-menu is-up" role="menu" data-testid="guides-menu">
          {(
            [
              ["thirds", "Rule of thirds"],
              ["center", "Center mark"],
              ["safe", "Action / title safe"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={guides[key]}
              className="ed2-menu-item"
              data-testid={`guide-${key}`}
              onClick={() => toggle(key)}
            >
              {label}
              <span>{guides[key] ? "✓" : ""}</span>
            </button>
          ))}
          <div className="ed2-menu-label">Reference frame</div>
          {[{ label: "None", ratio: null as number | null }, ...FRAMES].map(
            (item) => (
              <button
                key={item.label}
                type="button"
                role="menuitemradio"
                aria-checked={guides.frame === item.ratio}
                className="ed2-menu-item"
                data-testid={`guide-frame-${item.label}`}
                onClick={() => onChange({ ...guides, frame: item.ratio })}
              >
                {item.label}
                <span>{guides.frame === item.ratio ? "✓" : ""}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
