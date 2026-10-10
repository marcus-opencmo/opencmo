"use client";

/**
 * Cột Your CMO: chat với agent DUY NHẤT của tầng CMO (scope `cmo` trên vòng lặp
 * Assistant có sẵn). Agent trả lời từ tài liệu và giao việc cho workflow bằng
 * `create_task`; khi thấy tool đó chạy, màn làm mới để thẻ/lịch hiện ra.
 *
 * Server chưa có model (`live.chat` false): ở demo thì chat giả nói thẳng là
 * demo; còn lại ô nhập tắt và nói rõ lý do.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { readStream } from "@/components/clipping/agent-stream";
import { Markdown } from "@/components/editor/assistant/Markdown";
import { Icon } from "@/components/icons";
import type { ChatMessage, Workspace } from "@/lib/cmo/workspace";

import { ago } from "./time";

const SUGGESTIONS = ["Plan my week", "Draft a post for X about what we shipped", "What should I post today?", "Who is my ideal customer?"];

type TurnView = { number: number; prompt: string; status: string; error: string | null; reply: string; actions: { name: string; ok: boolean; summary: string }[] };
type SessionView = { id: string; turns: TurnView[] };
type PastSession = { id: string; title: string; created_at: string };
type Loaded = { available: boolean; session: SessionView | null; sessions: PastSession[] };
type Done = { status?: string; reason?: string; extend?: number; error?: string | null };

function toMessages(session: SessionView | null): ChatMessage[] {
  if (!session) return [];
  return session.turns.flatMap((turn) => [
    { id: `${turn.number}-u`, role: "user" as const, text: turn.prompt },
    {
      id: `${turn.number}-c`,
      role: "cmo" as const,
      text: turn.reply || (turn.status === "failed" ? (turn.error ?? "Something went wrong. Please try again.") : turn.actions.map((a) => a.summary).join(". ")),
    },
  ]);
}

/** Nhãn "đang làm" theo tool CMO đang gọi (research đọc mạng xã hội, create_task giao việc). */
function workingLabel(tool: string): string {
  if (tool === "create_task") return "Handing it to an agent…";
  if (/reddit|subreddit/.test(tool)) return "Reading Reddit…";
  if (tool === "x_profile" || tool === "find_outliers") return "Reading X…";
  if (tool === "search_videos" || tool === "get_transcript") return "Watching videos…";
  if (tool === "search_threads") return "Reading Threads…";
  return "Reading your plan…";
}

// Tools whose result is a new card, calendar item or document version; the workspace reloads so it shows up.
const CARD_TOOLS = new Set(["create_task", "set_week_goal", "create_video_brief", "update_document"]);

export function ChatPanel({ ws, onToast, onWorkStarted }: { ws: Workspace; onToast: (message: string) => void; onWorkStarted: () => void | Promise<void> }) {
  const live = ws.live.chat;
  const [messages, setMessages] = useState<ChatMessage[]>(ws.chat);
  const [title, setTitle] = useState(ws.chatTitle);
  const [session, setSession] = useState<SessionView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [extend, setExtend] = useState<number | null>(null);
  const [rated, setRated] = useState<Record<string, "up" | "down">>({});
  const [past, setPast] = useState<PastSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Lần tải đầu: khung chờ thay cho lời chào, để lời chào không nháy rồi bị thay bằng cuộc chat cũ.
  const [loading, setLoading] = useState(live);
  const listRef = useRef<HTMLOListElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const enabled = live || ws.demo;

  const load = useCallback(async (sessionId?: string) => {
    const loaded = await api<Loaded>(`/agent/sessions?scope=cmo${sessionId ? `&session_id=${sessionId}` : ""}`);
    setSession(loaded.session);
    setMessages(toMessages(loaded.session));
    setTitle(loaded.session?.turns[0]?.prompt.slice(0, 60) ?? null);
    setPast(loaded.sessions ?? []);
    setExtend(null);
  }, []);

  useEffect(() => {
    if (!live) return;
    load()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [live, load]);

  // Bấm ra ngoài hoặc Esc thì đóng danh sách lịch sử.
  useEffect(() => {
    if (!historyOpen) return;
    const away = (event: PointerEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === "Escape" && setHistoryOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [historyOpen]);

  async function openPast(id: string) {
    setHistoryOpen(false);
    if (id === session?.id) return;
    try {
      await load(id);
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Could not open that conversation.");
    }
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, working]);

  const stream = useCallback(
    async (sessionId: string, path: string, body: unknown, prompt: string | null) => {
      setBusy(true);
      setExtend(null);
      const replyId = `${Date.now()}-c`;
      if (prompt !== null) {
        setMessages((m) => [...m, { id: `${Date.now()}-u`, role: "user", text: prompt }, { id: replyId, role: "cmo", text: "" }]);
      } else {
        setMessages((m) => [...m, { id: replyId, role: "cmo", text: "" }]);
      }
      const append = (more: string) => setMessages((m) => m.map((msg) => (msg.id === replyId ? { ...msg, text: msg.text + more } : msg)));
      let done: Done = {};
      try {
        const response = await fetch(`/api/v1/agent/sessions/${sessionId}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        await readStream(response, (event, data) => {
          if (event === "text") append(String(data.text));
          if (event === "tool_start") setWorking(workingLabel(String(data.name)));
          if (event === "tool_result") {
            setWorking(null);
            if (CARD_TOOLS.has(String(data.name)) && data.ok) void onWorkStarted();
          }
          if (event === "done") done = data as Done;
        });
      } catch (error) {
        append(error instanceof ApiError ? error.message : "Connection lost. Check your internet and try again.");
      } finally {
        setWorking(null);
        setBusy(false);
      }
      if (done.status === "awaiting_continue" && done.reason === "time") {
        await stream(sessionId, "continue", {}, null);
        return;
      }
      if (done.status === "awaiting_continue" && done.reason === "budget") setExtend(done.extend ?? 10);
      if (done.status === "failed" && done.error) append(done.error);
    },
    [onWorkStarted],
  );

  async function send(text: string) {
    const value = text.trim();
    if (!value || !enabled || busy) return;
    setDraft("");
    setTitle((t) => t ?? value.slice(0, 60));
    if (!live) {
      const id = String(Date.now());
      setMessages((m) => [
        ...m,
        { id: `${id}-u`, role: "user", text: value },
        { id: `${id}-c`, role: "cmo", text: "This is demo data, so I can't answer for real yet. Once the CMO is connected, I'll answer from your documents and plan the work." },
      ]);
      return;
    }
    let current = session;
    try {
      if (!current) {
        current = await api<SessionView>("/agent/sessions", jsonBody({ scope: "cmo" }));
        setSession(current);
      }
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Your CMO is not available right now.");
      return;
    }
    await stream(current.id, "turns", { prompt: value }, value);
  }

  async function newChat() {
    if (!live) {
      setMessages([]);
      setTitle(null);
      return;
    }
    try {
      const fresh = await api<SessionView>("/agent/sessions", jsonBody({ scope: "cmo", new: true }));
      setSession(fresh);
      setMessages([]);
      setTitle(null);
      setExtend(null);
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Could not start a new chat.");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      onToast("Copied");
    } catch {
      onToast("Could not copy. Select the text and copy it");
    }
  }

  return (
    <section className="cmo-panel cmo-chat" aria-labelledby="cmo-chat-title">
      <header className="cmo-chat-head">
        <span className="cmo-chat-tab">
          <Icon name="message-circle" size={15} />
          <h2 id="cmo-chat-title">{title ?? "Your CMO"}</h2>
        </span>
        <span className={`cmo-gem ${enabled ? "is-on" : ""}`} title={enabled ? "Connected" : "Not connected yet"} />
        <button type="button" className="cmo-icon-btn" aria-label="New conversation" title="New conversation" disabled={!enabled || busy || messages.length === 0} onClick={() => void newChat()}>
          <Icon name="plus" size={16} />
        </button>
        {live ? (
          <div className="cmo-history" ref={historyRef}>
            <button
              type="button"
              className="cmo-icon-btn"
              aria-label="Past conversations"
              title="Past conversations"
              aria-expanded={historyOpen}
              aria-controls="cmo-history-list"
              disabled={busy}
              onClick={() => {
                if (historyOpen) return setHistoryOpen(false);
                setHistoryOpen(true);
                // Danh sách lấy lại mỗi lần mở: server là nguồn thật (gồm cả cuộc ở tab khác).
                void api<Loaded>(`/agent/sessions?scope=cmo${session ? `&session_id=${session.id}` : ""}`)
                  .then((loaded) => setPast(loaded.sessions ?? []))
                  .catch(() => undefined);
              }}
            >
              <Icon name="history" size={16} />
            </button>
            {historyOpen ? (
              <div id="cmo-history-list" className="cmo-menu cmo-history-menu" role="menu" aria-label="Past conversations">
                <p className="cmo-menu-label">Past conversations</p>
                {past.length ? (
                  past.map((item) => (
                    <button key={item.id} type="button" role="menuitem" className={`cmo-menu-item${item.id === session?.id ? " is-current" : ""}`} onClick={() => void openPast(item.id)}>
                      <span className="cmo-history-title">{item.title}</span>
                      <time dateTime={item.created_at} suppressHydrationWarning>{ago(item.created_at)}</time>
                    </button>
                  ))
                ) : (
                  <p className="cmo-muted cmo-history-empty">Your conversations show up here.</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      <ol className="cmo-messages" aria-live="polite" ref={listRef}>
        {loading ? (
          <li className="cmo-skeleton" aria-label="Loading conversation">
            <span />
            <span />
            <span />
          </li>
        ) : messages.length === 0 ? (
          <li className="cmo-msg is-cmo">
            <div className="cmo-msg-body">
              <p>
                {enabled
                  ? "I know your product from your website and documents. Ask me what to post, who your customer is, or to plan the week."
                  : "Chat is not connected on this server yet. Your plan, calendar and drafts still work."}
              </p>
            </div>
          </li>
        ) : (
          messages.map((m) => (
            <li key={m.id} className={`cmo-msg is-${m.role}`}>
              <div className="cmo-msg-body">
                {m.role === "cmo" ? (m.text ? <Markdown text={m.text} className="cmo-md" /> : <p className="cmo-muted">Thinking…</p>) : <p>{m.text}</p>}
              </div>
              {m.role === "cmo" && m.text ? (
                <div className="cmo-msg-tools">
                  <button type="button" className="cmo-icon-btn" aria-label="Copy" onClick={() => copy(m.text)}>
                    <Icon name="copy" size={14} />
                  </button>
                  <button type="button" className="cmo-icon-btn" aria-label="Good answer" aria-pressed={rated[m.id] === "up"} onClick={() => setRated((r) => ({ ...r, [m.id]: "up" }))}>
                    <Icon name="thumbs-up" size={14} />
                  </button>
                  <button type="button" className="cmo-icon-btn" aria-label="Bad answer" aria-pressed={rated[m.id] === "down"} onClick={() => setRated((r) => ({ ...r, [m.id]: "down" }))}>
                    <Icon name="thumbs-down" size={14} />
                  </button>
                </div>
              ) : null}
            </li>
          ))
        )}
        {working ? <li className="cmo-msg is-cmo"><p className="cmo-muted">{working}</p></li> : null}
      </ol>

      {extend !== null && session ? (
        <div className="cmo-extend">
          <p>This answer used the credits held for it.</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void stream(session.id, "continue", { extend: true }, null)}>
            Continue for {extend} credits
          </button>
        </div>
      ) : null}

      {messages.length === 0 && !loading ? (
        <div className="cmo-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={!enabled || busy} onClick={() => void send(s)}>{s}</button>
          ))}
        </div>
      ) : null}

      <form
        className="cmo-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="cmo-ask-input" className="sr-only">Ask your CMO</label>
        <textarea
          id="cmo-ask-input"
          rows={3}
          placeholder={enabled ? "Ask your CMO…" : "Chat is not connected yet"}
          value={draft}
          disabled={!enabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="cmo-ask-bar">
          <span className="cmo-muted">{!enabled ? "" : busy ? "Your CMO is answering…" : "Enter to send"}</span>
          <button type="submit" className="cmo-send" aria-label="Send" disabled={!enabled || busy || !draft.trim()}>
            <Icon name="arrow-up" size={18} />
          </button>
        </div>
      </form>
    </section>
  );
}
