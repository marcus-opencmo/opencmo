"use client";

/**
 * Thanh trên cùng của Dashboard: dấu OpenCMO · chọn project · Activity · một câu
 * trạng thái của CMO · công tắc theme. Màn này "bleed" (ẩn top bar chung), nên
 * công tắc theme phải nằm ở đây.
 */

import Link from "next/link";
import { useRef } from "react";

import { Icon } from "@/components/icons";
import { ThemeSwitch } from "@/components/theme";
import type { Workspace } from "@/lib/cmo/workspace";

type Props = { ws: Workspace; logOpen: boolean; onToggleLog: () => void; onOpenPlan: () => void };

export function TopBar({ ws, logOpen, onToggleLog, onOpenPlan }: Props) {
  const menu = useRef<HTMLDetailsElement>(null);
  const running = ws.log.some((l) => l.status === "running" || l.status === "queued");
  const initials = ws.project.name.replace(/^https?:\/\//, "").slice(0, 2).toUpperCase();
  const close = () => menu.current?.removeAttribute("open");

  return (
    <header className="cmo-bar">
      <span className="cmo-bar-mark">
        <img src="/icon.svg" alt="" width={22} height={22} />
        <span>OpenCMO</span>
      </span>

      <details className="cmo-project" ref={menu}>
        <summary aria-label={`Project: ${ws.project.name}`}>
          <span className="cmo-project-logo" aria-hidden="true">{initials}</span>
          <span className="cmo-project-name">{ws.project.name}</span>
          <Icon name="chevron-down" size={14} />
        </summary>
        <div className="cmo-menu" role="menu">
          <p className="cmo-menu-label">Project</p>
          <span className="cmo-menu-item is-current" role="menuitem" aria-current="true">
            <Icon name="check" size={14} /> {ws.project.name}
          </span>
          <hr />
          <button
            type="button"
            role="menuitem"
            className="cmo-menu-item"
            onClick={() => {
              close();
              onOpenPlan();
            }}
          >
            <Icon name="file-text" size={14} /> Marketing plan
          </button>
          <Link role="menuitem" className="cmo-menu-item" href="/app/brand" onClick={close}>
            <Icon name="palette" size={14} /> Brand kit
          </Link>
        </div>
      </details>

      <button type="button" className="cmo-bar-btn" onClick={onToggleLog} aria-expanded={logOpen} aria-controls="cmo-console" data-testid="cmo-log-open">
        <Icon name={logOpen ? "chevron-up" : "chevron-down"} size={14} /> Activity
        {running ? <span className="cmo-dot is-running" aria-label="A task is running" /> : null}
      </button>

      <p className={`cmo-status is-${ws.status.tone}`} role="status">
        <span className="cmo-gem" aria-hidden="true" />
        <span className="cmo-status-text">{ws.status.text}</span>
      </p>

      {ws.demo ? (
        <span className="cmo-demo-pill" title="Sample cards, numbers and chat to show the finished screen. Buttons here do not post anything.">
          Demo data
        </span>
      ) : null}
      <ThemeSwitch className="cmo-theme" />
    </header>
  );
}
