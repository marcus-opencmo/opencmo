"use client";

import Link from "next/link";

import { isCurrent, type NavEntry } from "./nav";

/**
 * The strip on top of the tab panel: the screens opened this session, like Claude Code's open files. Each is a link
 * (the URL stays the source of truth); Dashboard is pinned so the panel is never empty.
 */
export function TabStrip({
  tabs,
  segment,
  onClose,
  onHide,
  onChat,
}: {
  tabs: NavEntry[];
  segment: string | null;
  onClose: (entry: NavEntry) => void;
  onHide: () => void;
  /** Below the compact width the chat is a drawer; this opens it. */
  onChat: () => void;
}) {
  return (
    <div className="v2-tabstrip">
      <button type="button" className="v2-tabstrip-chat" onClick={onChat}>
        <span className="v2-mark is-small" aria-hidden="true" />
        Chat
      </button>
      <nav aria-label="Open tabs" className="v2-tabstrip-tabs">
        {tabs.map((entry) => {
          const current = isCurrent(entry, segment);
          const pinned = entry.screen === "dashboard";
          return (
            <span key={entry.href} className="v2-tab" data-current={current ? "" : undefined}>
              <Link href={entry.href} className="v2-tab-link" aria-current={current ? "page" : undefined}>
                {entry.label}
              </Link>
              {pinned ? null : (
                <button type="button" className="v2-tab-close" aria-label={`Close ${entry.label}`} onClick={() => onClose(entry)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          );
        })}
      </nav>
      <button type="button" className="v2-tabstrip-hide" aria-label="Hide the tab panel (⌘\)" title="Hide the tab panel (⌘\)" onClick={onHide}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" />
          <path d="M15 4v16" />
        </svg>
      </button>
    </div>
  );
}
