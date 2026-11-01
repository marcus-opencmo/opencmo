"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { NAV_DEPARTMENTS, NAV_MAIN, NAV_MAKE, NAV_SETTINGS, isCurrent, type NavEntry } from "./nav";

const ICON = {
  today: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  approve: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 4h16v16H4zM4 14h5l1 2h4l1-2h5" />
    </svg>
  ),
  calendar: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="1" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  chat: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  ),
  more: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
};

/**
 * Phone navigation (DashboardPhone.dc.html): Today · Approve · Calendar · Chat · More; More opens a sheet with the rest.
 * Chat opens the shell's CMO chat as a full-screen sheet: on a phone there is no room for it as a column.
 */
export function TabBar({
  segment,
  entries,
  pending,
  credits,
  onChat,
}: {
  segment: string | null;
  entries: (entries: NavEntry[]) => NavEntry[];
  pending: number | null;
  credits: number | null;
  onChat: () => void;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  // Following a link inside the sheet changes the route but leaves the dialog open.
  useEffect(() => {
    sheet.current?.close();
  }, [pathname]);

  const calendar = entries(NAV_DEPARTMENTS).find((entry) => entry.screen === "schedule");
  const more = [...entries(NAV_MAIN).filter((entry) => entry.screen !== "dashboard"), ...entries(NAV_DEPARTMENTS), ...NAV_MAKE, NAV_SETTINGS];
  const today = segment === null;
  const approving = segment === "inbox";
  const moreCurrent = !today && !approving && !(calendar && isCurrent(calendar, segment));

  return (
    <>
      <nav aria-label="Main" className="v2-tabbar" style={{ gridTemplateColumns: `repeat(${calendar ? 5 : 4}, minmax(0, 1fr))` }}>
        <Link href="/app" className="v2-tabbar-item" aria-current={today ? "page" : undefined}>
          {ICON.today}
          Today
        </Link>
        <Link href="/app/inbox" className="v2-tabbar-item" aria-current={approving ? "page" : undefined}>
          {ICON.approve}
          {pending ? `Approve · ${pending}` : "Approve"}
        </Link>
        {calendar ? (
          <Link href={calendar.href} className="v2-tabbar-item" aria-current={isCurrent(calendar, segment) ? "page" : undefined}>
            {ICON.calendar}
            Calendar
          </Link>
        ) : null}
        <button type="button" className="v2-tabbar-item" aria-controls="v2-chat" onClick={onChat}>
          {ICON.chat}
          Chat
        </button>
        <button type="button" className="v2-tabbar-item" aria-haspopup="dialog" aria-current={moreCurrent ? "page" : undefined} onClick={() => sheet.current?.showModal()}>
          {ICON.more}
          More
        </button>
      </nav>

      <dialog ref={sheet} className="v2-sheet" aria-label="More" onClick={(event) => event.target === sheet.current && sheet.current?.close()}>
        <div className="v2-sheet-body">
          <div className="v2-sheet-head">
            <span className="v2-mono is-small is-muted">More</span>
            <button type="button" className="v2-button is-quiet is-compact" onClick={() => sheet.current?.close()}>
              Close
            </button>
          </div>
          <ul className="v2-sheet-list">
            {more.map((entry) => (
              <li key={entry.href}>
                <Link href={entry.href} aria-current={isCurrent(entry, segment) ? "page" : undefined}>
                  {entry.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/app/billing">
                Credits <span className="v2-num">{credits ?? "–"}</span>
              </Link>
            </li>
          </ul>
          <form action="/auth/signout" method="post">
            <button type="submit" className="v2-button is-secondary" style={{ width: "100%" }}>
              Sign out
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
