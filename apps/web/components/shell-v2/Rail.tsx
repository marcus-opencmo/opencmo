"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { nextPostText, type RailStatus } from "@/lib/screens/rail";

import { Logo } from "./Logo";
import { NavIcon } from "./NavIcon";
import { NAV_DEPARTMENTS, NAV_MAIN, NAV_MAKE, NAV_SETTINGS, isCurrent, type DepartmentName, type NavEntry } from "./nav";

export type RailProps = {
  segment: string | null;
  entries: (entries: NavEntry[]) => NavEntry[];
  pending: number | null;
  stuck: DepartmentName[];
  /** Uploads being processed: shown on Studio, where they land. */
  processing: number;
  /** Schedule's next post and Analytics' connected accounts (P6 F14); null until loaded or where it cannot be read. */
  status?: RailStatus | null;
  credits: number | null;
  email: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Clicking the screen already open hides the tab panel (and shows it again). */
  onCurrent: () => void;
};

type Status = { text: string; tone: "waiting" | "stuck" | "live" | "info" };


/** A status line only from numbers the shell already has; no line rather than a guessed one. */
function statusOf(entry: NavEntry, props: RailProps): Status | null {
  if (entry.screen === "dashboard" && props.pending) return { text: `${props.pending} waiting on you`, tone: "waiting" };
  if (entry.department && props.stuck.includes(entry.department)) return { text: "Stuck", tone: "stuck" };
  if (entry.department === "studio" && props.processing > 0) return { text: `${props.processing} processing`, tone: "live" };
  if (entry.screen === "schedule" && props.status?.nextPostAt) return { text: nextPostText(props.status.nextPostAt, props.status.timezone), tone: "info" };
  if (entry.screen === "analytics" && props.status?.connectedAccounts) {
    const n = props.status.connectedAccounts;
    return { text: `${n} account${n === 1 ? "" : "s"}`, tone: "info" };
  }
  return null;
}

function RailLink({ entry, props }: { entry: NavEntry; props: RailProps }) {
  const current = isCurrent(entry, props.segment);
  const status = statusOf(entry, props);
  const name = status ? `${entry.label}, ${status.text}` : entry.label;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!current || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    props.onCurrent();
  };
  return (
    <Link
      href={entry.href}
      className="v2-rail-item"
      aria-current={current ? "page" : undefined}
      aria-label={name}
      title={props.collapsed ? name : undefined}
      data-flag={status?.tone}
      onClick={onClick}
    >
      <NavIcon href={entry.href} />
      <span className="v2-rail-text">
        <span className="v2-rail-label">{entry.label}</span>
        {status ? (
          <span className={`v2-rail-status is-${status.tone}`} data-testid={entry.screen === "dashboard" ? "rail-pending" : undefined}>
            {status.text}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function Group({ heading, children }: { heading?: string; children: ReactNode }) {
  return (
    <div className="v2-rail-group">
      {heading ? <span className="v2-rail-heading">{heading}</span> : null}
      {children}
    </div>
  );
}

export function Rail(props: RailProps) {
  const { entries, credits, email, collapsed, onToggleCollapsed } = props;
  const departments = entries(NAV_DEPARTMENTS);
  return (
    <nav aria-label="Main" className="v2-rail" id="v2-rail">
      <div className="v2-rail-top">
        <Link href="/app" className="v2-rail-brand" aria-label="OpenCMO home">
          <Logo />
          <span>OpenCMO</span>
        </Link>
        <button
          type="button"
          className="v2-rail-toggle"
          aria-label={collapsed ? "Expand the rail (⌘B)" : "Collapse the rail (⌘B)"}
          aria-expanded={!collapsed}
          aria-controls="v2-rail"
          onClick={onToggleCollapsed}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" />
            <path d="M9 4v16" />
          </svg>
        </button>
      </div>

      <Group>
        {entries(NAV_MAIN).map((entry) => (
          <RailLink key={entry.href} entry={entry} props={props} />
        ))}
      </Group>

      {departments.length > 0 ? (
        <Group heading="Departments">
          {departments.map((entry) => (
            <RailLink key={entry.href} entry={entry} props={props} />
          ))}
        </Group>
      ) : null}

      <Group heading="Make">
        {NAV_MAKE.map((entry) => (
          <RailLink key={entry.href} entry={entry} props={props} />
        ))}
      </Group>

      <div className="v2-rail-group v2-rail-foot">
        <RailLink entry={NAV_SETTINGS} props={props} />
        <Link href="/app/billing" className="v2-rail-credits" aria-label={credits === null ? "Credits" : `${credits} credits left`}>
          <span className="v2-mono is-small is-muted">Credits</span>
          <span className="v2-rail-credits-value">{credits ?? "–"}</span>
        </Link>
        <details className="v2-rail-account">
          <summary>
            <span className="v2-rail-email">{email ?? "Signed in"}</span>
          </summary>
          <form action="/auth/signout" method="post">
            <button type="submit" className="v2-button is-quiet is-compact">Sign out</button>
          </form>
        </details>
      </div>
    </nav>
  );
}
