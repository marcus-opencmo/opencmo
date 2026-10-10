"use client";

/**
 * Assistant ở trang project (spec AI Studio P4): đọc mọi clip, đề xuất một
 * thay đổi cho nhiều clip, và CHỈ ghi sau khi người dùng bấm Approve trên thẻ
 * duyệt. Clip lỗi được liệt kê với nút Retry — Retry chạy lại đúng các op đó
 * qua `/editor/ops`, không gọi model lần nữa (không tốn credit).
 *
 * Mọi chữ ở đây là tiếng Anh: người dùng cuối nhìn thấy.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, jsonBody } from "../api";
import { readStream } from "../agent-stream";

type ApprovalCard = { clips: { id: string; label: string }[]; changes: string[] };
type FailedClip = { clip_id: string; label: string; error?: string };
type Action = { name: string; ok: boolean; summary: string; failed?: FailedClip[]; ops?: unknown[] };
type Turn = {
  number: number;
  prompt: string;
  status: "running" | "awaiting_browser" | "awaiting_approval" | "done" | "failed" | "stopped";
  error: string | null;
  reply: string;
  actions: Action[];
  pending: { id: string; name: string; input: unknown; card?: ApprovalCard }[];
  credits: number | null;
  can_undo: boolean;
  undone: boolean;
};
type Session = { id: string; locked: boolean; turns: Turn[] };
type Loaded = { available: boolean; session: Session | null };

/** Phần đang stream của lượt hiện tại — thay bằng bản từ server khi `done`. */
type Live = { prompt: string; reply: string; actions: Action[] };

const EXAMPLES = ["Which clip has the strongest hook?", "Use the same caption style on every clip"];

export function ProjectAssistant({ jobId, brief = null, onChanged }: { jobId: string; brief?: string | null; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Clip đã Retry thành công, theo `lượt:clip` — chỉ trong tab này. */
  const [retried, setRetried] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const shownBrief = useRef<string | null>(null);

  const load = useCallback(async () => {
    const next = await api<Loaded>(`/agent/sessions?job_id=${jobId}`);
    setLoaded(next);
    return next;
  }, [jobId]);

  useEffect(() => {
    void load().catch(() => setLoaded({ available: false, session: null }));
  }, [load]);

  // A brief from the CMO: open the panel with it ready to send. The founder sends it, and the
  // assistant still asks before changing any clip.
  useEffect(() => {
    if (!brief) return;
    setOpen(true);
    setPrompt(brief);
  }, [brief]);

  // The panel sits below every clip, so a founder arriving from the brief card would not see it.
  useEffect(() => {
    if (!brief || !loaded || shownBrief.current === brief) return;
    shownBrief.current = brief;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    sectionRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [brief, loaded]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [loaded, live]);

  const stream = useCallback(
    async (path: string, body: unknown, livePrompt: string | null) => {
      setBusy(true);
      setError(null);
      if (livePrompt !== null) setLive({ prompt: livePrompt, reply: "", actions: [] });
      let changed = false;
      try {
        const response = await fetch(`/api/v1${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        await readStream(response, (event, data) => {
          if (event === "text") setLive((current) => current && { ...current, reply: current.reply + String(data.text) });
          if (event === "tool_result") {
            setLive((current) => current && { ...current, actions: [...current.actions, { name: String(data.name), ok: Boolean(data.ok), summary: String(data.summary) }] });
          }
          if (event === "project_changed") changed = true;
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Connection lost. Check your internet and try again.");
      } finally {
        setLive(null);
        setBusy(false);
        await load().catch(() => undefined);
        if (changed) onChanged();
      }
    },
    [load, onChanged],
  );

  async function send(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    setPrompt("");
    let session = loaded?.session;
    try {
      if (!session) {
        session = await api<Session>("/agent/sessions", jsonBody({ job_id: jobId }));
        setLoaded((current) => current && { ...current, session: session! });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      return;
    }
    await stream(`/agent/sessions/${session.id}/turns`, { prompt: value }, value);
  }

  async function decide(turn: Turn, approved: boolean) {
    if (!loaded?.session) return;
    await stream(
      `/agent/sessions/${loaded.session.id}/approvals`,
      { decisions: turn.pending.map((call) => ({ tool_use_id: call.id, approved })) },
      null,
    );
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const undo = (turn: Turn) =>
    run(async () => {
      await api(`/agent/sessions/${loaded!.session!.id}/turns/${turn.number}/undo`, jsonBody({}));
      await load();
      onChanged();
    });

  const stop = () =>
    run(async () => {
      await api(`/agent/sessions/${loaded!.session!.id}/stop`, jsonBody({}));
    });

  /** Retry: cùng op, từng clip lỗi, qua đường ghi của editor (CAS + checkpoint). */
  const retry = (turn: Turn, action: Action) =>
    run(async () => {
      const failures: string[] = [];
      for (const clip of action.failed ?? []) {
        const key = `${turn.number}:${clip.clip_id}`;
        if (retried.has(key)) continue;
        try {
          const project = await api<{ version: number }>(`/editor/project?clip_id=${clip.clip_id}`);
          await api(
            "/editor/ops",
            jsonBody({
              clip_id: clip.clip_id,
              expected_version: project.version,
              ops: action.ops ?? [],
              checkpoint: { kind: "manual", label: `Before retrying assistant request ${turn.number}` },
            }),
          );
          setRetried((current) => new Set(current).add(key));
        } catch (err) {
          failures.push(`${clip.label}: ${err instanceof ApiError ? err.message : "failed"}`);
        }
      }
      onChanged();
      if (failures.length) throw new ApiError(`Some clips still failed. ${failures.join(" ")}`, 409, null);
    });

  if (!loaded) return null;
  const session = loaded.session;
  const turns = session?.turns ?? [];
  const running = busy || turns.some((turn) => turn.status === "running");
  const waiting = turns.find((turn) => turn.status === "awaiting_approval");

  return (
    <section ref={sectionRef} className="project-assistant" aria-label="Assistant">
      <button type="button" className="project-assistant-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Assistant</span>
        <small>{loaded.available ? "Ask about your clips or change many at once" : "Not available yet"}</small>
      </button>

      {open && (
        <div className="project-assistant-body">
          {!loaded.available && <p className="project-assistant-note">The assistant is not available yet.</p>}

          {loaded.available && (
            <>
              <div className="project-assistant-turns" ref={listRef}>
                {turns.length === 0 && !live && (
                  <div className="project-assistant-examples">
                    {EXAMPLES.map((example) => (
                      <button key={example} type="button" className="secondary-button" disabled={running} onClick={() => void send(example)}>
                        {example}
                      </button>
                    ))}
                  </div>
                )}

                {turns.map((turn) => (
                  <article key={turn.number} className={`assistant-turn${turn.undone ? " is-undone" : ""}`}>
                    <p className="assistant-prompt">{turn.prompt}</p>
                    {turn.actions.map((action, index) => (
                      <div key={index} className={`assistant-action${action.ok ? "" : " is-failed"}`}>
                        <span>{action.summary}</span>
                        {action.failed && action.failed.some((clip) => !retried.has(`${turn.number}:${clip.clip_id}`)) && (
                          <div className="assistant-failed">
                            <ul>
                              {action.failed
                                .filter((clip) => !retried.has(`${turn.number}:${clip.clip_id}`))
                                .map((clip) => (
                                  <li key={clip.clip_id}>
                                    <strong>{clip.label}</strong> — {clip.error ?? "This clip could not be changed."}
                                  </li>
                                ))}
                            </ul>
                            {!turn.undone && (
                              <button type="button" className="secondary-button" disabled={running} onClick={() => void retry(turn, action)}>
                                Retry
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {turn.reply && <p className="assistant-reply">{turn.reply}</p>}

                    {turn.status === "awaiting_approval" &&
                      turn.pending.map((call) =>
                        call.card ? (
                          <div key={call.id} className="assistant-approval">
                            <h3>
                              Change {call.card.clips.length} {call.card.clips.length === 1 ? "clip" : "clips"}?
                            </h3>
                            <ul className="assistant-changes">
                              {call.card.changes.map((change, index) => (
                                <li key={index}>{change}</li>
                              ))}
                            </ul>
                            <ul className="assistant-clips">
                              {call.card.clips.map((clip) => (
                                <li key={clip.id}>{clip.label}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null,
                      )}
                    {turn.status === "awaiting_approval" && (
                      <div className="panel-actions">
                        <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(turn, true)}>
                          Approve
                        </button>
                        <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide(turn, false)}>
                          Cancel
                        </button>
                      </div>
                    )}

                    {turn.status === "failed" && <p className="assistant-error">{turn.error ?? "The assistant stopped with an error."}</p>}
                    {turn.status === "stopped" && <p className="assistant-meta">Stopped.</p>}
                    <p className="assistant-meta">
                      {turn.credits !== null && `${turn.credits} ${turn.credits === 1 ? "credit" : "credits"}`}
                      {turn.undone && " · Undone"}
                      {turn.can_undo && (
                        <button type="button" className="text-button" disabled={running} onClick={() => void undo(turn)}>
                          Undo
                        </button>
                      )}
                    </p>
                  </article>
                ))}

                {live && (
                  <article className="assistant-turn is-live">
                    <p className="assistant-prompt">{live.prompt}</p>
                    {live.actions.map((action, index) => (
                      <div key={index} className={`assistant-action${action.ok ? "" : " is-failed"}`}>
                        <span>{action.summary}</span>
                      </div>
                    ))}
                    <p className="assistant-reply">{live.reply || "Thinking…"}</p>
                  </article>
                )}
              </div>

              {error && <p className="assistant-error" role="alert">{error}</p>}

              <form
                className="project-assistant-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(prompt);
                }}
              >
                <textarea
                  value={prompt}
                  maxLength={4000}
                  rows={2}
                  placeholder={waiting ? "Approve or cancel the change first" : "Ask about your clips, or change several at once"}
                  disabled={running || Boolean(waiting)}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(prompt);
                    }
                  }}
                />
                {running && live ? (
                  <button type="button" className="secondary-button" onClick={() => void stop()}>
                    Stop
                  </button>
                ) : (
                  <button type="submit" className="primary-button" disabled={running || Boolean(waiting) || !prompt.trim()}>
                    Send
                  </button>
                )}
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
