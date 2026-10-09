"use client";

/**
 * Activity: mỗi lượt việc (W0–W7) là một chuỗi bước có trạng thái (san-pham.md §4.3).
 *
 * Bảng console mở/thu NGAY DƯỚI thanh trên và đẩy 4 cột xuống — người dùng vẫn
 * thấy thẻ và chat trong lúc đọc CMO đang làm gì (trước đây là hộp thoại che
 * hết màn). Kéo mép dưới đổi chiều cao; mở/thu và chiều cao nhớ theo trình duyệt.
 */

import { useCallback, useEffect, useRef } from "react";

import { JOB_TITLE, type LogEntry } from "@/lib/cmo/workspace";

import { ago } from "./time";

export const LOG_HEIGHT = { min: 120, max: 420, initial: 200 };

const MARK: Record<string, string> = { done: "✓", failed: "✕", running: "›", queued: "·", skipped: "–" };

export function AgentLog({ open, height, onHeight, entries }: { open: boolean; height: number; onHeight: (height: number) => void; entries: LogEntry[] }) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = entries[0]?.id;

  // Việc mới nhất ở trên cùng: việc mới tới thì cuộn về đầu.
  useEffect(() => {
    list.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [latest]);

  const move = useCallback(
    (event: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      onHeight(Math.min(LOG_HEIGHT.max, Math.max(LOG_HEIGHT.min, Math.round(d.from + event.clientY - d.y))));
    },
    [onHeight],
  );
  const stop = useCallback(() => {
    drag.current = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  }, [move]);

  return (
    <section id="cmo-console" className="cmo-console" data-open={open || undefined} style={{ height: open ? height : 0 }} aria-label="Activity" aria-hidden={!open} data-testid="cmo-log">
      <div className="cmo-console-scroll" ref={list}>
        {entries.length === 0 ? (
          <p className="cmo-console-line is-muted">&gt; Nothing has run yet. Every task your CMO runs shows up here, step by step.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`cmo-console-entry is-${entry.status}`}>
              <p className="cmo-console-line is-head">
                <span className="cmo-console-mark">{MARK[entry.status] ?? "›"}</span>
                <span className="cmo-job">{entry.job}</span>
                <strong>{JOB_TITLE[entry.job] ?? entry.title}</strong>
                <time dateTime={entry.startedAt} suppressHydrationWarning>{ago(entry.startedAt)}</time>
              </p>
              {entry.detail ? <p className="cmo-console-line is-detail">{entry.detail}</p> : null}
              {entry.steps.map((step, i) => (
                <p key={i} className={`cmo-console-line is-step is-${step.status}`}>
                  <span className="cmo-console-mark">{MARK[step.status] ?? "·"}</span>
                  <code>{step.tool}</code>
                  <span>{step.label}</span>
                </p>
              ))}
            </div>
          ))
        )}
      </div>
      <span
        className="cmo-console-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Activity"
        aria-valuemin={LOG_HEIGHT.min}
        aria-valuemax={LOG_HEIGHT.max}
        aria-valuenow={height}
        tabIndex={open ? 0 : -1}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") onHeight(Math.max(LOG_HEIGHT.min, height - 20));
          if (e.key === "ArrowDown") onHeight(Math.min(LOG_HEIGHT.max, height + 20));
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          drag.current = { y: e.clientY, from: height };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
        }}
      />
    </section>
  );
}
