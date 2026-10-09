"use client";

/**
 * Đổi khung của clip (9:16, 1:1, …) và cách video lấp khung (Fill/Fit) — op
 * `set_frame` của editor-core, cùng op mà fork, route ops và Assistant gọi.
 * Split (spec visuals-2 L4) chia khung người nói + panel visual — op
 * `set_layout`, đặt cùng chỗ với tỉ lệ khung vì với người dùng nó là "bố cục".
 */

import { useEffect, useRef, useState } from "react";

import type { Frame, LayoutRange } from "@opencmo/editor-core";

const QUICK = [
  { label: "9:16", hint: "TikTok, Reels, Shorts", width: 1080, height: 1920 },
  { label: "1:1", hint: "Square post", width: 1080, height: 1080 },
  { label: "4:5", hint: "Instagram feed", width: 1080, height: 1350 },
  { label: "16:9", hint: "YouTube, landscape", width: 1920, height: 1080 },
] as const;

/** Các khung ít dùng hơn, gom theo hướng. Danh sách của OpenCMO, không theo preset của DS. */
const MORE = [
  {
    label: "Portrait",
    items: [
      { label: "3:4", width: 1080, height: 1440 },
      { label: "2:3", width: 1080, height: 1620 },
    ],
  },
  {
    label: "Landscape",
    items: [
      { label: "4:3", width: 1440, height: 1080 },
      { label: "3:2", width: 1620, height: 1080 },
      { label: "21:9", width: 2520, height: 1080 },
    ],
  },
] as const;

/** Một khoảng chia đôi quanh playhead khi không chia cả clip. */
const SPAN = 5;

export function FrameBar({
  frame,
  busy,
  onChange,
  layouts = [],
  playhead,
  duration,
  onLayout,
  fps = 30,
  onSettings,
}: {
  frame: Frame | null;
  busy: boolean;
  onChange: (next: Partial<Frame>) => void;
  layouts?: LayoutRange[];
  playhead?: () => number;
  duration?: number | null;
  onLayout?: (op: Record<string, unknown>) => void;
  /** Số khung/giây của bản export (E2-b). */
  fps?: number;
  /** Op `set_project_settings`: cỡ tự do, fps. */
  onSettings?: (settings: { width?: number; height?: number; fps?: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const splitMenu = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0.5);
  const [whole, setWhole] = useState(true);
  const [custom, setCustom] = useState<{ width: string; height: string } | null>(null);

  useEffect(() => {
    if (!open && !splitOpen) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
      if (!splitMenu.current?.contains(event.target as Node)) setSplitOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open, splitOpen]);

  const span = (): { start: number; end: number } => {
    if (whole || !playhead) return { start: 0, end: duration ?? 0 };
    const start = Math.round(playhead() * 100) / 100;
    return { start, end: Math.round(Math.min(start + SPAN, duration ?? start + SPAN) * 100) / 100 };
  };
  const layout = (mode: string, anchor?: string) => {
    setSplitOpen(false);
    const range = mode === "full" && whole ? {} : span();
    onLayout?.({ op: "set_layout", mode, ...range, ...(mode.startsWith("split") ? { ratio } : {}), ...(anchor ? { anchor } : {}) });
  };

  if (!frame) return null;
  const isCurrent = (width: number, height: number) => frame.width === width && frame.height === height;
  const quick = QUICK.some((preset) => isCurrent(preset.width, preset.height));

  return (
    <div className="ed2-framebar" data-testid="frame-bar" role="toolbar" aria-label="Frame">
      {QUICK.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="ed2-chip"
          aria-pressed={isCurrent(preset.width, preset.height)}
          data-testid={`frame-${preset.label}`}
          disabled={busy}
          title={`${preset.hint} · ${preset.width}×${preset.height}`}
          onClick={() => onChange({ width: preset.width, height: preset.height })}
        >
          {preset.label}
        </button>
      ))}
      <div className="relative" ref={menu}>
        <button
          type="button"
          className="ed2-chip"
          aria-pressed={!quick}
          aria-expanded={open}
          data-testid="frame-more"
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
        >
          {quick ? "More" : `${frame.width}×${frame.height}`}
          {fps !== 30 ? ` · ${fps} fps` : ""} ▾
        </button>
        {open ? (
          <div className="ed2-menu ed2-frame-menu" role="menu">
            {MORE.map((group) => (
              <div key={group.label}>
                <div className="ed2-menu-label">{group.label}</div>
                {group.items.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    role="menuitem"
                    className="ed2-menu-item"
                    onClick={() => {
                      setOpen(false);
                      onChange({ width: preset.width, height: preset.height });
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="ed2-muted">
                      {preset.width}×{preset.height}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {onSettings ? (
              <>
                <div className="ed2-menu-label">Custom size</div>
                <form
                  className="ed2-row ed2-frame-custom"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const width = Number(custom?.width ?? frame.width);
                    const height = Number(custom?.height ?? frame.height);
                    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 7680 || height > 7680) return;
                    setOpen(false);
                    setCustom(null);
                    onSettings({ width, height });
                  }}
                >
                  <input
                    className="ed2-select"
                    inputMode="numeric"
                    aria-label="Width"
                    data-testid="frame-custom-width"
                    value={custom?.width ?? String(frame.width)}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={(event) => setCustom({ width: event.target.value, height: custom?.height ?? String(frame.height) })}
                  />
                  <span className="ed2-muted">×</span>
                  <input
                    className="ed2-select"
                    inputMode="numeric"
                    aria-label="Height"
                    data-testid="frame-custom-height"
                    value={custom?.height ?? String(frame.height)}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={(event) => setCustom({ width: custom?.width ?? String(frame.width), height: event.target.value })}
                  />
                  <button type="submit" className="ed2-btn" data-testid="frame-custom-apply">
                    Apply
                  </button>
                </form>
                <div className="ed2-menu-label">Export frame rate</div>
                <div className="ed2-row ed2-frame-fps" role="group" aria-label="Export frame rate">
                  {[24, 25, 30, 50, 60].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="ed2-chip"
                      aria-pressed={fps === value}
                      data-testid={`frame-fps-${value}`}
                      onClick={() => {
                        setOpen(false);
                        if (value !== fps) onSettings({ fps: value });
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {onLayout ? (
        <div className="relative" ref={splitMenu}>
          <button
            type="button"
            className="ed2-chip"
            aria-pressed={layouts.length > 0}
            aria-expanded={splitOpen}
            data-testid="frame-split"
            disabled={busy}
            title="Speaker in one half, visuals in the other"
            onClick={() => setSplitOpen((value) => !value)}
          >
            Split ▾
          </button>
          {splitOpen ? (
            <div className="ed2-menu" role="menu" data-testid="frame-split-menu">
              <div className="ed2-menu-label">Where</div>
              <div className="ed2-row" style={{ padding: "0 8px 6px" }}>
                <button type="button" className="ed2-chip" aria-pressed={whole} data-testid="split-whole" onClick={() => setWhole(true)}>
                  Whole clip
                </button>
                <button type="button" className="ed2-chip" aria-pressed={!whole} data-testid="split-here" onClick={() => setWhole(false)}>
                  {SPAN}s from playhead
                </button>
              </div>
              <div className="ed2-menu-label">Speaker share</div>
              <div className="ed2-row" style={{ padding: "0 8px 6px" }}>
                {[0.5, 0.6, 0.4].map((value) => (
                  <button key={value} type="button" className="ed2-chip" aria-pressed={ratio === value} data-testid={`split-ratio-${value * 100}`} onClick={() => setRatio(value)}>
                    {Math.round(value * 100)}%
                  </button>
                ))}
              </div>
              <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-bottom" onClick={() => layout("split-bottom")}>
                <span>Speaker bottom</span>
                <span className="ed2-muted">visuals on top</span>
              </button>
              <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-top" onClick={() => layout("split-top")}>
                <span>Speaker top</span>
                <span className="ed2-muted">visuals below</span>
              </button>
              {/* Học Palmier §C3: người nói ở ô góc trên nền visual, hoặc một cột cạnh visual. */}
              <div className="ed2-menu-label">Picture in picture · speaker corner</div>
              <div className="ed2-row ed2-pip-corners" role="group" aria-label="Picture in picture corner">
                {[
                  { anchor: "top-left", label: "↖ Top left", testid: "split-pip-tl" },
                  { anchor: "top-right", label: "↗ Top right", testid: "split-pip-top" },
                  { anchor: "bottom-left", label: "↙ Bottom left", testid: "split-pip-bl" },
                  { anchor: "bottom-right", label: "↘ Bottom right", testid: "split-pip" },
                ].map((corner) => (
                  <button key={corner.anchor} type="button" role="menuitem" className="ed2-chip" data-testid={corner.testid} onClick={() => layout("pip", corner.anchor)}>
                    {corner.label}
                  </button>
                ))}
              </div>
              <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-side" onClick={() => layout("side-by-side", "left")}>
                <span>Side by side</span>
                <span className="ed2-muted">speaker left, visual right</span>
              </button>
              <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-side-right" onClick={() => layout("side-by-side", "right")}>
                <span>Side by side, speaker right</span>
                <span className="ed2-muted">visual left</span>
              </button>
              <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-visual" onClick={() => layout("visual-only")}>
                <span>Visual only</span>
                <span className="ed2-muted">voice keeps playing</span>
              </button>
              {layouts.length ? (
                <button type="button" role="menuitem" className="ed2-menu-item" data-testid="split-remove" onClick={() => layout("full")}>
                  <span>Remove split</span>
                  <span className="ed2-muted">{whole ? "whole clip" : `${SPAN}s from playhead`}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="ed2-sep" aria-hidden />
      {(["fill", "fit"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="ed2-chip"
          aria-pressed={frame.mode === mode}
          data-testid={`frame-mode-${mode}`}
          disabled={busy}
          title={mode === "fill" ? "Fill the frame and follow the speaker" : "Show the whole video with bars"}
          onClick={() => onChange({ mode })}
        >
          {mode === "fill" ? "Fill" : "Fit"}
        </button>
      ))}
    </div>
  );
}
