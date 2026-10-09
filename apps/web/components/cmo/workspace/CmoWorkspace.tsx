"use client";

/**
 * Màn chính sau đăng nhập: AI CMO (docs/cmo/san-pham.md §3.2), style Lapis & Marble.
 * Dải lapis trên cùng; bốn cột Brief · Results · Approvals · Your CMO. Tên và
 * style là của OpenCMO, cố ý không theo Okara. Brief và Results thu được
 * thành dải hẹp (nhớ trong localStorage). Màn hẹp:
 * một cột + tab, mặc định là Approvals.
 *
 * Dữ liệu tới từ `loadWorkspace` theo hợp đồng `lib/cmo/workspace.ts`. Phần chưa
 * có backend (`live.*` false) hiện trạng thái trống thật; dữ liệu mẫu chỉ có khi
 * `demo` (dev/preview), lúc đó thanh trên có nhãn "Demo data".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { Icon, type IconName } from "@/components/icons";
import { Toast } from "@/components/clipping/ui";
import { useShellAccount } from "@/components/clipping/web/WebShell";
import type { DocumentKind } from "@/lib/cmo/documents";
import type { DocumentRow } from "@/lib/cmo/state";
import type { InboxCard, Workspace } from "@/lib/cmo/workspace";

import { isSample, type Actions, type CalendarAct, type CardAct } from "./actions";

import { AgentLog, LOG_HEIGHT } from "./AgentLog";
import { DocumentSheet, isDocView, type DocView } from "./DocumentSheet";
import { ChatPanel } from "./ChatPanel";
import { FeedPanel } from "./FeedPanel";
import { AnalyticsPanel, ContextPanel } from "./SidePanels";
import { TopBar } from "./TopBar";

type Tab = "feed" | "chat" | "context" | "analytics";
const TABS: { id: Tab; label: string }[] = [
  { id: "feed", label: "Approvals" },
  { id: "chat", label: "CMO" },
  { id: "context", label: "Brief" },
  { id: "analytics", label: "Results" },
];
type Side = "context" | "analytics";
const COLLAPSE_KEY = "opencmo.cmo.collapsed";
const CONSOLE_KEY = "opencmo.cmo.console";

/** `?doc=` của URL hiện tại, đọc thẳng từ trình duyệt (không qua router → không gọi lại server). */
const docFromUrl = (): DocView | null => {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("doc");
  return isDocView(value) ? value : null;
};

/** Kết quả rõ ràng của một hành động lên thẻ, để cập nhật màn trước khi server trả lời. */
function optimistic(ws: Workspace, card: InboxCard, act: CardAct): Workspace {
  const removes = act.type === "skip" || act.type === "dismiss" || act.type === "replied" || act.type === "posted";
  if (removes) {
    return {
      ...ws,
      inbox: ws.inbox.filter((c) => c.id !== card.id),
      agents: ws.agents.map((a) => (a.department === card.department ? { ...a, ready: Math.max(0, a.ready - 1) } : a)),
    };
  }
  if (act.type === "approve" && card.department === "post") {
    return { ...ws, inbox: ws.inbox.map((c) => (c.id === card.id ? { ...card, state: "approved" as const, finalText: act.text ?? card.finalText ?? card.text } : c)) };
  }
  return ws;
}

function Collapsed({ icon, label, onOpen }: { icon: IconName; label: string; onOpen: () => void }) {
  return (
    <button type="button" className="cmo-collapsed" onClick={onOpen} aria-label={`Expand ${label}`}>
      <Icon name="chevron-right" size={16} />
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}

export function CmoWorkspace({ initial }: { initial: Workspace }) {
  const [ws, setWs] = useState(initial);
  const [tab, setTab] = useState<Tab>("feed");
  const [logOpen, setLogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Side[]>([]);
  const [logHeight, setLogHeight] = useState(LOG_HEIGHT.initial);
  // `?doc=` là nguồn sự thật: Next đồng bộ useSearchParams với pushState, nên Back/forward
  // và mục "Marketing plan" ở rail (router.push) đều mở/đóng đúng sheet.
  const params = useSearchParams();
  const rawDoc = params.get("doc");
  const doc: DocView | null = isDocView(rawDoc) ? rawDoc : null;
  // Đổi mỗi khi một hành động lên thẻ bắt đầu và khi server xác nhận: lượt poll gửi đi
  // TRƯỚC đó mang trạng thái cũ (thẻ chưa duyệt/chưa bỏ) — áp vào là đè mất cập nhật lạc quan.
  const epoch = useRef(0);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? "[]");
      if (Array.isArray(saved)) setCollapsed(saved.filter((s): s is Side => s === "context" || s === "analytics"));
      const consoleState = JSON.parse(window.localStorage.getItem(CONSOLE_KEY) ?? "{}") as { open?: boolean; height?: number };
      if (typeof consoleState.open === "boolean") setLogOpen(consoleState.open);
      if (typeof consoleState.height === "number") setLogHeight(Math.min(LOG_HEIGHT.max, Math.max(LOG_HEIGHT.min, consoleState.height)));
    } catch {
      // Không đọc được thì giữ mặc định.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CONSOLE_KEY, JSON.stringify({ open: logOpen, height: logHeight }));
    } catch {
      // Không lưu được thì chỉ nhớ trong phiên này.
    }
  }, [logOpen, logHeight]);

  // History API của trình duyệt (Next đồng bộ nó), KHÔNG router.replace: đổi searchParams
  // qua router làm trang động render lại trên server — mở một tài liệu thành một lượt tải.
  const openDoc = useCallback((view: DocView) => {
    const url = `${window.location.pathname}?doc=${view}`;
    if (docFromUrl()) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);
  const closeDoc = useCallback(() => {
    if (docFromUrl()) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const docSaved = useCallback((kind: DocumentKind, row: DocumentRow) => {
    setWs((current) => ({ ...current, documents: { ...current.documents, [kind]: { body: row.body, createdBy: row.created_by, version: row.version } } }));
  }, []);

  function toggle(side: Side) {
    setCollapsed((was) => {
      const next = was.includes(side) ? was.filter((s) => s !== side) : [...was, side];
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // Không lưu được thì chỉ nhớ trong phiên này.
      }
      return next;
    });
  }

  // Bản tải về của gói video dựng trên worker, không nằm trong log CMO — cũng phải chờ.
  const busy =
    ws.log.some((l) => l.status === "queued" || l.status === "running") ||
    ws.inbox.some((c) => c.department === "video" && c.clips.some((clip) => clip.download?.status === "queued" || clip.download?.status === "running"));

  const refresh = useCallback(async () => {
    try {
      const started = epoch.current;
      const next = await api<Workspace>("/cmo/workspace");
      if (epoch.current === started) setWs(next);
    } catch {
      // Mất mạng một nhịp: lượt poll sau thử lại.
    }
  }, []);

  // Số "N waiting" trên rail đọc từ /account: đổi số thẻ chờ duyệt ở đây (duyệt,
  // bỏ, agent vừa soạn xong) thì nhờ shell đọc lại, không đợi lần focus sau.
  const { refreshAccount } = useShellAccount();
  const waitingCount = ws.inbox.filter((c) => !("state" in c) || c.state !== "approved").length;
  const firstCount = useRef(true);
  useEffect(() => {
    if (firstCount.current) {
      firstCount.current = false;
      return;
    }
    refreshAccount();
  }, [waitingCount, refreshAccount]);

  // Có việc đang chạy thì hỏi lại mỗi 4 giây cho tới khi xong — thẻ và lịch hiện ngay khi có.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  const fail = (error: unknown) => setToast(error instanceof ApiError ? error.message : "Something went wrong. Please try again.");

  const actions: Actions = {
    toast: setToast,
    refresh,
    openDoc,
    async card(card: InboxCard, act: CardAct) {
      if (isSample(card.id)) {
        setWs((current) => ({
          ...current,
          inbox: current.inbox.filter((c) => c.id !== card.id),
          agents: current.agents.map((a) => (a.department === card.department ? { ...a, ready: Math.max(0, a.ready - 1) } : a)),
        }));
        const done = { approve: "Approved", posted: "Marked as posted", replied: "Marked as replied", skip: "Skipped", dismiss: "Dismissed" }[act.type];
        setToast(`${done} (demo, nothing was sent)`);
        return true;
      }
      // Đổi màn ngay (thẻ trượt ra, số đếm giảm); server lỗi thì trả về như cũ.
      const before = ws;
      epoch.current += 1;
      setWs((current) => optimistic(current, card, act));
      try {
        if (card.department === "video") {
          // Gói video: duyệt = dựng bản tải về; bỏ = ghi lý do. Không có đường đăng.
          const body = act.type === "approve" ? { action: "approve" } : { action: "dismiss", reason: act.type === "dismiss" || act.type === "skip" ? act.reason : undefined };
          await api(`/cmo/video-packs/${card.id}`, jsonBody(body));
          setToast(act.type === "approve" ? "Approved. Your downloads are being prepared." : "Skipped. Your CMO will pick different moments next time.");
        } else if (card.department === "sales") {
          // Thread Reddit: chỉ "đã tự trả lời" hoặc "bỏ" — không có đường đăng.
          const body = act.type === "replied" ? { action: "replied" } : { action: "dismissed", reason: act.type === "dismiss" ? act.reason : undefined };
          await api(`/cmo/opportunities/${card.id}`, jsonBody(body));
          setToast(act.type === "replied" ? "Marked as replied." : "Dismissed. Your CMO will look for better threads.");
        } else {
          const body =
            act.type === "approve"
              ? { action: "approve", text: act.text }
              : act.type === "skip" || act.type === "dismiss"
                ? { action: "skip", reason: act.reason }
                : { action: "posted", url: act.type === "posted" ? act.url : undefined };
          await api(`/cmo/items/${card.id}`, jsonBody(body));
          setToast(
            act.type === "approve" ? "Approved. Post it on X when you are ready." : act.type === "posted" ? "Marked as posted." : "Skipped. Your CMO will plan around it.",
          );
        }
        epoch.current += 1;
        void refresh();
        return true;
      } catch (error) {
        epoch.current += 1;
        setWs(before);
        fail(error);
        return false;
      }
    },
    async goal(goal, act) {
      try {
        await api(`/cmo/goals/${goal.id}`, jsonBody(act));
        setToast(act.action === "approve" ? "Goal approved. Your CMO plans the week around it." : "Goal dismissed. Ask your CMO for a different one.");
        void refresh();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    async brief(brief, act) {
      try {
        const result = await api<{ href: string | null }>(`/cmo/video-briefs/${brief.id}`, jsonBody(act));
        if (act.action === "approve" && result.href) {
          window.location.assign(result.href);
          return true;
        }
        setToast("Skipped. Your CMO will try a different angle.");
        void refresh();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    async run(kind) {
      if (ws.demo && !ws.live.inbox) {
        setToast("Demo data: nothing was started.");
        return;
      }
      try {
        await api("/cmo/runs", jsonBody({ kind }));
        setToast(
          {
            plan_week: "Planning your week. It takes about a minute.",
            post_draft: "Drafting a post for X. It shows up here in about a minute.",
            sales_scan: "Scanning Reddit. Conversations worth joining show up here in a few minutes.",
          }[kind],
        );
        await refresh();
      } catch (error) {
        fail(error);
      }
    },
    async calendar(id: string, act: CalendarAct) {
      if (isSample(id)) {
        setToast("Demo data: nothing was changed.");
        return false;
      }
      try {
        await api(`/cmo/items/${id}`, jsonBody(act));
        await refresh();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
  };

  const shut = (side: Side) => collapsed.includes(side);

  return (
    <div className="cmo-ws" data-tab={tab} data-testid="cmo-workspace">
      <TopBar ws={ws} logOpen={logOpen} onToggleLog={() => setLogOpen((open) => !open)} onOpenPlan={() => openDoc("product")} />
      <AgentLog open={logOpen} height={logHeight} onHeight={setLogHeight} entries={ws.log} />

      <nav className="cmo-ws-tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "feed" && ws.inbox.length > 0 ? <span className="cmo-count">{ws.inbox.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="cmo-ws-grid" data-context={shut("context") ? "shut" : undefined} data-analytics={shut("analytics") ? "shut" : undefined}>
        <div className="cmo-col is-context">
          {shut("context") ? (
            <Collapsed icon="layers" label="Brief" onOpen={() => toggle("context")} />
          ) : (
            <ContextPanel ws={ws} actions={actions} onCollapse={() => toggle("context")} />
          )}
        </div>
        <div className="cmo-col is-analytics">
          {shut("analytics") ? (
            <Collapsed icon="chart-column" label="Results" onOpen={() => toggle("analytics")} />
          ) : (
            <AnalyticsPanel ws={ws} onCollapse={() => toggle("analytics")} onToast={setToast} />
          )}
        </div>
        <div className="cmo-col is-feed"><FeedPanel ws={ws} actions={actions} /></div>
        <div className="cmo-col is-chat"><ChatPanel ws={ws} onToast={setToast} onWorkStarted={refresh} /></div>
      </div>

      <DocumentSheet view={doc} ws={ws} actions={actions} onOpen={openDoc} onClose={closeDoc} onSaved={docSaved} />
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
