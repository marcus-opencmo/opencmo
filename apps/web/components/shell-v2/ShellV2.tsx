"use client";

/**
 * The v2 shell (NEXT_PUBLIC_OPENCMO_UI=v2): three columns on desktop, rail · CMO chat · tab panel
 * (docs/plans/cmo/2026-10-30-three-column-shell-plan.md); tab bar on a phone, where the chat is a full-screen sheet.
 *
 * Same contract as `WebShell`: rendered by `app/app/layout.tsx`, so it lives across navigation and keeps one Realtime
 * channel for jobs, one toast, the account numbers and now the chat, which keeps its draft and session across screens.
 * Pages call `useShellAccount()` under either shell. The editor keeps today's full-width shell until it joins the frame
 * (step S4 of the plan).
 */

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "@/components/clipping/api";
import { useActiveJobs } from "@/components/clipping/ActiveJobs";
import { Toast } from "@/components/clipping/ui";
import {
  ShellAccountContext,
  WebShell,
  type AccountSummary,
} from "@/components/clipping/web/WebShell";

import { ChatPanel, type ChatSource } from "@/components/cmo/workspace/ChatPanel";
import { studioItemHref } from "@/components/screens/studio/href";
import type { RailStatus } from "@/lib/screens/rail";

import { CHAT, DEFAULT_PREF, RAIL, applyColumns, clampColumns, readPref, writePref, type ColumnsPref } from "./columns";

import { Logo } from "./Logo";
import { NAV_DEPARTMENTS, NAV_MAIN, NAV_MAKE, NAV_SETTINGS, isShown, type DepartmentName, type NavEntry } from "./nav";
import { Rail } from "./Rail";
import { Sash } from "./Sash";
import { ShellStateContext, type ShellState } from "./ShellState";
import { TabBar } from "./TabBar";
import { TabStrip } from "./TabStrip";
import { useScreensAvailable } from "./useScreensAvailable";

type Props = {
  credits?: number | null;
  plan?: string | null;
  email?: string | null;
  userId?: string | null;
  pending?: number | null;
  /** False when no CMO chat model is configured: the chat column then says so itself. */
  chatLive: boolean;
  /** Production: hide every screen whose data is not live. */
  hideSample: boolean;
  children: ReactNode;
};

/** Segments that keep today's shell. `video` only redirects to the editor. */
const CLASSIC: ReadonlySet<string> = new Set(["video"]);
/** The editor sits in column 3; column 2 then holds the clip's Assistant and the rail is the icon strip. */
const EDITOR = "editor";
const TABS_KEY = "opencmo.tabs";
const MAX_TABS = 8;
/** Segments drawn without the rail and tab bar (Setup.dc.html): first run has nothing to navigate to yet. */
const BARE: ReadonlySet<string> = new Set(["setup"]);

export function ShellV2(props: Props) {
  const segment = useSelectedLayoutSegment();
  if (segment !== null && CLASSIC.has(segment)) {
    const { hideSample: _hideSample, chatLive: _chatLive, ...account } = props;
    return <WebShell {...account} />;
  }
  return <V2Frame {...props} segment={segment} />;
}

function V2Frame({
  credits,
  plan,
  email,
  userId,
  pending,
  chatLive,
  hideSample,
  children,
  segment,
}: Props & { segment: string | null }) {
  const router = useRouter();
  const [account, setAccount] = useState({
    credits: credits ?? null,
    plan: plan ?? null,
    pending: pending ?? null,
  });
  // The Dashboard's queue, once it has reported one: it wins over the server count so every number on screen agrees.
  const [queue, setQueue] = useState<{
    pending: number;
    stuck: DepartmentName[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reading = useRef(false);
  // The rail's Schedule and Analytics lines (P6 F14); read with the account summary, never guessed.
  const [railStatus, setRailStatus] = useState<RailStatus | null>(null);

  const refreshAccount = useCallback(() => {
    if (reading.current) return;
    reading.current = true;
    void api<RailStatus>("/screens/rail")
      .then(setRailStatus)
      .catch(() => {
        // No line rather than a stale or made-up one.
      });
    void api<AccountSummary>("/account")
      .then((summary) =>
        setAccount({
          credits: summary.credits,
          plan: summary.plan,
          pending: summary.cmo_pending,
        }),
      )
      .catch(() => {
        // A hint in the frame only: keep the old numbers rather than cover the page's own errors.
      })
      .finally(() => {
        reading.current = false;
      });
  }, []);

  // Read once on load; `refreshAccount` reads it again when the window comes back.
  useEffect(() => {
    void api<RailStatus>("/screens/rail")
      .then(setRailStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAccount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshAccount]);

  // A client navigation from the editor (classic shell) lands here without the boot script running again.
  useEffect(() => {
    document.documentElement.dataset.ui = "v2";
  }, []);

  const {
    active,
    toast: jobToast,
    clearToast,
  } = useActiveJobs(userId ?? null, refreshAccount);
  const available = useScreensAvailable();
  const entries = useCallback(
    (list: NavEntry[]) =>
      list.filter((entry) => isShown(entry, hideSample, available)),
    [hideSample, available],
  );

  const reportQueue = useCallback((count: number, stuck: DepartmentName[]) => {
    setQueue((was) =>
      was && was.pending === count && was.stuck.join() === stuck.join()
        ? was
        : { pending: count, stuck },
    );
  }, []);
  // Columns: what the person chose, and the window it has to fit. The boot script in layout.tsx already drew the same
  // widths before React ran, so the first render here changes nothing on screen.
  const [pref, setPref] = useState<ColumnsPref>(DEFAULT_PREF);
  const [viewport, setViewport] = useState(1440);
  useEffect(() => {
    setPref(readPref());
    const measure = () => setViewport(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const inEditor = segment === EDITOR;
  // The editor needs the width: the rail is the icon strip there, whatever was chosen elsewhere.
  const columns = clampColumns(viewport, inEditor ? { ...pref, railCollapsed: true } : pref);
  useLayoutEffect(() => applyColumns(columns), [columns.rail, columns.chat, columns.railCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = useCallback((next: Partial<ColumnsPref>) => {
    setPref((was) => {
      const pref = { ...was, ...next };
      writePref(pref);
      return pref;
    });
  }, []);
  const toggleRail = useCallback(() => choose({ railCollapsed: !columns.railCollapsed }), [choose, columns.railCollapsed]);

  // The tab panel can be hidden (the chat then takes its space); the chat is a drawer below the compact width.
  const [panelHidden, setPanelHidden] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const togglePanel = useCallback(() => setPanelHidden((was) => !was), []);
  const chatColumn = useRef<HTMLElement>(null);
  const focusChat = useCallback(() => {
    setPanelHidden(false);
    setChatOpen(true);
    // After the drawer (if any) is shown: a hidden textarea cannot take focus.
    requestAnimationFrame(() => chatColumn.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
  }, []);
  const [workVersion, setWorkVersion] = useState(0);
  const [clipAssistantSlot, setClipAssistantSlot] = useState<HTMLElement | null>(null);

  // Open tabs: every screen visited this session, Dashboard first and pinned.
  const tabEntries = useMemo(() => [...entries(NAV_MAIN), ...entries(NAV_DEPARTMENTS), ...NAV_MAKE, NAV_SETTINGS], [entries]);
  const currentEntry = tabEntries.find((entry) => entry.segments.includes(segment)) ?? null;
  const [openHrefs, setOpenHrefs] = useState<string[]>(["/app"]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? "null") as unknown;
      if (Array.isArray(saved)) setOpenHrefs(["/app", ...saved.filter((href): href is string => typeof href === "string" && href !== "/app")]);
    } catch {
      // A blocked or broken session store: start with Dashboard only.
    }
  }, []);
  // A new screen shows the panel and closes the chat drawer. Only on a real change: parents' effects run after their
  // children's, so on first mount this would undo a page's own `focusChat()` (the Dashboard's `?ask=1`).
  const shownEntry = useRef(currentEntry);
  useEffect(() => {
    if (shownEntry.current !== currentEntry) {
      shownEntry.current = currentEntry;
      setPanelHidden(false);
      setChatOpen(false);
    }
    if (!currentEntry) return;
    setOpenHrefs((was) => (was.includes(currentEntry.href) ? was : ["/app", ...[...was.slice(1), currentEntry.href].slice(-(MAX_TABS - 1))]));
  }, [currentEntry]);
  useEffect(() => {
    try {
      sessionStorage.setItem(TABS_KEY, JSON.stringify(openHrefs));
    } catch {
      // As above.
    }
  }, [openHrefs]);
  const tabs = openHrefs.map((href) => tabEntries.find((entry) => entry.href === href)).filter((entry): entry is NavEntry => Boolean(entry));
  const closeTab = useCallback(
    (entry: NavEntry) => {
      const index = openHrefs.indexOf(entry.href);
      const rest = openHrefs.filter((href) => href !== entry.href);
      setOpenHrefs(rest);
      if (currentEntry?.href === entry.href) router.push(rest[Math.max(0, index - 1)] ?? "/app");
    },
    [openHrefs, currentEntry, router],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChatOpen(false);
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key === "\\") {
        event.preventDefault();
        togglePanel();
      } else if (event.key.toLowerCase() === "b" && !inEditor && !(event.target instanceof HTMLElement && event.target.isContentEditable)) {
        // Not in the editor: ⌘B splits a clip there.
        event.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, toggleRail, inEditor]);

  const chatSource = useMemo<ChatSource>(() => ({ live: { chat: chatLive }, chat: [], chatTitle: null, demo: false }), [chatLive]);

  const state = useMemo<ShellState>(
    () => ({
      pending: queue?.pending ?? account.pending,
      stuck: queue?.stuck ?? [],
      reportQueue,
      toast: setMessage,
      focusChat,
      workVersion,
      clipAssistantSlot,
    }),
    [queue, account.pending, reportQueue, focusChat, workVersion, clipAssistantSlot],
  );

  const shown = message ?? jobToast?.text ?? null;
  const jobAction = useMemo(
    () =>
      !message && jobToast
        ? {
            label: "Open",
            onClick: () => router.push(studioItemHref(jobToast.projectId)),
          }
        : undefined,
    [message, jobToast, router],
  );

  return (
    <ShellAccountContext.Provider
      value={{
        credits: account.credits,
        plan: account.plan,
        userId: userId ?? null,
        refreshAccount,
      }}
    >
      <ShellStateContext.Provider value={state}>
        {segment !== null && BARE.has(segment) ? (
          <div className="v2 v2-shell is-bare">
            <main className="v2-main">
              <div className="v2-bare-brand">
                <Logo />
                <span>OpenCMO</span>
              </div>
              {children}
            </main>
          </div>
        ) : (
          <div className="v2 v2-shell is-cols" data-panel={panelHidden ? "hidden" : undefined} data-chat={chatOpen ? "open" : undefined}>
            <Rail
              segment={segment}
              entries={entries}
              pending={state.pending}
              stuck={state.stuck}
              processing={active.length}
              status={railStatus}
              credits={account.credits}
              email={email ?? null}
              collapsed={columns.railCollapsed}
              onToggleCollapsed={toggleRail}
              onCurrent={togglePanel}
            />
            <Sash
              label="Resize the rail"
              controls="v2-rail"
              value={columns.rail}
              min={RAIL.min}
              max={RAIL.max}
              onLive={(rail) => applyColumns({ ...columns, rail })}
              onCommit={(rail) => choose({ rail })}
              onReset={() => choose({ rail: RAIL.base })}
            />
            <aside className="v2-chatcol" id="v2-chat" aria-label={inEditor ? "Assistant" : "Your CMO"} data-clip={inEditor ? "" : undefined} ref={chatColumn}>
              <div className="v2-chatcol-head">
                <button type="button" className="v2-button is-quiet is-compact" onClick={() => setChatOpen(false)}>
                  Close
                </button>
              </div>
              {/* Hidden, not unmounted, in the editor: the CMO chat keeps its draft for the way back. */}
              <ChatPanel ws={chatSource} onToast={setMessage} onWorkStarted={() => setWorkVersion((n) => n + 1)} />
              {inEditor ? <div className="v2-clip-slot" ref={setClipAssistantSlot} /> : null}
            </aside>
            <Sash
              label="Resize the chat"
              controls="v2-chat"
              value={columns.chat}
              min={CHAT.min}
              max={columns.chatMax}
              onLive={(chat) => applyColumns({ ...columns, chat })}
              onCommit={(chat) => choose({ chat })}
              onReset={() => choose({ chat: CHAT.base })}
            />
            <main className="v2-main">
              <TabStrip tabs={tabs} segment={segment} onClose={closeTab} onHide={togglePanel} onChat={focusChat} />
              <div className="v2-main-body">{children}</div>
            </main>
            {chatOpen ? <div className="v2-chat-scrim" aria-hidden="true" onClick={() => setChatOpen(false)} /> : null}
            <TabBar
              segment={segment}
              entries={entries}
              pending={state.pending}
              credits={account.credits}
              onChat={focusChat}
            />
          </div>
        )}
        <Toast
          message={shown}
          onDone={() => (message ? setMessage(null) : clearToast())}
          action={jobAction}
          tone={message ? "info" : jobToast?.tone}
        />
      </ShellStateContext.Provider>
    </ShellAccountContext.Provider>
  );
}
