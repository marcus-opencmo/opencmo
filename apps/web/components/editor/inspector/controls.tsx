"use client";

/**
 * Ô điều khiển của inspector. Mọi ô ghi qua MỘT hàm `edit` (op của
 * editor-core); ô số kéo được nhãn để tua giá trị — trong lúc kéo chỉ là bản
 * xem trước, thả tay mới thành một bước Undo.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export type Edit = (ops: unknown[], options?: { preview?: boolean }) => void;

export function Section({
  title,
  children,
  action,
  testid,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testid?: string;
}) {
  return (
    <section className="ed2-ins-section" data-testid={testid}>
      <header className="ed2-ins-head">
        <span>{title}</span>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ed2-ins-row">
      <span className="ed2-ins-label">{label}</span>
      <div className="ed2-ins-control">{children}</div>
    </div>
  );
}

export function AddButton({ label, onClick, testid }: { label: string; onClick: () => void; testid?: string }) {
  return (
    <button type="button" className="ed2-ins-add" aria-label={label} title={label} data-testid={testid} onClick={onClick}>
      +
    </button>
  );
}

export function RemoveButton({ label, onClick, testid }: { label: string; onClick: () => void; testid?: string }) {
  return (
    <button type="button" className="ed2-ins-remove" aria-label={label} title={label} data-testid={testid} onClick={onClick}>
      −
    </button>
  );
}

/** Kim cương keyframe: đặc = có keyframe ở playhead, rỗng = có track, mờ = chưa có. */
export type Diamond = { state: "on" | "track" | "off"; toggle: () => void };

const round = (value: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(value.toFixed(decimals));
};

export function NumberField({
  label,
  value,
  onCommit,
  onPreview,
  step = 1,
  min,
  max,
  unit,
  scale = 1,
  diamond,
  testid,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  onPreview?: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  /** Hệ số hiển thị: 100 cho phần trăm của một giá trị 0–1. */
  scale?: number;
  diamond?: Diamond;
  testid?: string;
}) {
  const shown = round(value * scale, step);
  const [text, setText] = useState(String(shown));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(shown));
  }, [shown, focused]);

  const clamp = (next: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
  const commitText = () => {
    const parsed = Number(text.replace(",", "."));
    if (Number.isFinite(parsed) && round(parsed, step) !== shown) onCommit(clamp(parsed) / scale);
    else setText(String(shown));
  };

  const drag = useRef<{ x: number; from: number; last: number; moved: boolean } | null>(null);
  return (
    <div className="ed2-num" data-testid={testid}>
      <span
        className="ed2-num-label"
        title="Drag to change"
        onPointerDown={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, from: shown, last: shown, moved: false };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          const dx = event.clientX - d.x;
          if (!d.moved && Math.abs(dx) < 3) return;
          d.moved = true;
          d.last = clamp(round(d.from + Math.round(dx / 2) * step, step));
          setText(String(d.last));
          onPreview?.(d.last / scale);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved && d.last !== d.from) onCommit(d.last / scale);
          else if (d?.moved) onPreview?.(d.from / scale);
        }}
      >
        {label}
      </span>
      <input
        className="ed2-num-input"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commitText();
        }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setText(String(shown));
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const next = clamp(round(shown + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1), step));
            onCommit(next / scale);
          }
        }}
      />
      {unit ? <span className="ed2-num-unit">{unit}</span> : null}
      {diamond ? (
        <button
          type="button"
          className={`ed2-diamond is-${diamond.state}`}
          aria-label={diamond.state === "on" ? `Remove ${label} keyframe` : `Add ${label} keyframe`}
          data-testid={testid ? `${testid}-keyframe` : undefined}
          onClick={diamond.toggle}
        />
      ) : null}
    </div>
  );
}

/** Màu của document viết HOA `#RRGGBB`, như fork. */
export const hex = (value: string) => value.toUpperCase();

export function ColorField({
  value,
  onCommit,
  diamond,
  testid,
  label = "Color",
}: {
  value: string;
  onCommit: (value: string) => void;
  diamond?: Diamond;
  testid?: string;
  label?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const six = /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : "#000000";
  return (
    <div className="ed2-color" data-testid={testid}>
      <input
        type="color"
        aria-label={label}
        value={six.toLowerCase()}
        onChange={(event) => onCommit(hex(event.target.value))}
      />
      <input
        className="ed2-num-input"
        aria-label={`${label} hex`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        onBlur={() => {
          const clean = text.trim().startsWith("#") ? text.trim() : `#${text.trim()}`;
          if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(clean) && hex(clean) !== value) onCommit(hex(clean));
          else setText(value);
        }}
      />
      {diamond ? (
        <button
          type="button"
          className={`ed2-diamond is-${diamond.state}`}
          aria-label={diamond.state === "on" ? "Remove color keyframe" : "Add color keyframe"}
          onClick={diamond.toggle}
        />
      ) : null}
    </div>
  );
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  label,
  testid,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  testid?: string;
}) {
  return (
    <select
      className="ed2-select"
      aria-label={label}
      data-testid={testid}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="ed2-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="ed2-seg-item"
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EyeButton({ hidden, onToggle, testid }: { hidden: boolean; onToggle: () => void; testid?: string }) {
  return (
    <button
      type="button"
      className="ed2-toggle"
      aria-pressed={hidden}
      aria-label={hidden ? "Show" : "Hide"}
      data-testid={testid}
      onClick={onToggle}
    >
      {hidden ? "◌" : "◉"}
    </button>
  );
}
