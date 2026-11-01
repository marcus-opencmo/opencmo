"use client";

import { useEffect, useState } from "react";

import { api, jsonBody } from "@/components/clipping/api";
import { Button, ButtonLink, MonoLabel } from "@/components/ui";
import type { SalesScreen as Data } from "@/lib/screens/sales";

import { ago } from "../format";
import { cx, ErrorNote, PageHeader, Screen, SkeletonBlocks } from "../parts";
import { isSample, useScreen } from "../useScreen";
import { SalesSettings } from "./SalesSettings";

type Thread = Data["threads"][number];

const DISMISS_REASONS = ["Not our customer", "Already solved", "Too old", "Wrong community"] as const;

/**
 * Sales drafts replies; the founder posts them on their own account. There is no post button here, ever
 * (CLAUDE.md, "Assist, never act"): Copy and open thread puts the draft on the clipboard and opens Reddit.
 */
export function SalesScreen() {
  const [state] = useScreen("sales");
  const data = state.status === "ready" ? state.data : null;

  return (
    <Screen label="Sales">
      <PageHeader
        numeral="IV"
        eyebrow="Sales"
        title="People who need what you built."
        sub="Threads scored with quotes from the thread. Replies are drafts: you post them yourself."
        sample={state.status === "ready" && isSample(state.live)}
        actions={data && <MentionMeter used={data.mentions.used} window={data.mentions.window} />}
      />
      {state.status === "loading" && <SkeletonBlocks />}
      {state.status === "error" && <ErrorNote>{state.message}</ErrorNote>}
      {state.status === "ready" && (
        <>
          <SalesBody data={state.data} live={!!state.live.threads} />
          <SalesSettings initial={state.data.settings} live={!!state.live.settings} />
        </>
      )}
    </Screen>
  );
}

function MentionMeter({ used, window }: { used: number; window: number }) {
  return (
    <div className="scr-meter" role="img" aria-label={`Product mentions: ${used} of the last ${window} replies`}>
      <MonoLabel small>Product mentions, last {window} replies</MonoLabel>
      <span className="scr-meter-cells" aria-hidden="true">
        {Array.from({ length: window }, (_, i) => (
          <i key={i} className={i < used ? "is-used" : undefined} />
        ))}
      </span>
      <span className="scr-tiny scr-muted">
        {used} of {window} · {used === 0 ? "this reply may name the product once" : "the next replies help without naming it"}
      </span>
    </div>
  );
}

function SalesBody({ data, live }: { data: Data; live: boolean }) {
  const [threads, setThreads] = useState(data.threads);
  const [week, setWeek] = useState(data.week);
  const [stuck, setStuck] = useState(data.stuck);
  const open = threads.filter((t) => t.status === "open");
  const [selectedId, setSelectedId] = useState<string | null>(open[0]?.id ?? null);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);

  // On a phone the detail sits under the list: bring it into view when the founder picks a thread.
  useEffect(() => {
    if (!picked || window.matchMedia("(min-width: 900px)").matches) return;
    document.getElementById("thread-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [picked]);

  async function decide(thread: Thread, action: "replied" | "dismissed", reason?: string) {
    setError(null);
    try {
      // Sample threads change only in the browser; live ones go through the ownership-checking RPC.
      if (live) await api(`/cmo/opportunities/${encodeURIComponent(thread.id)}`, jsonBody({ action, reason }));
      setThreads((all) => all.map((t) => (t.id === thread.id ? { ...t, status: action } : t)));
      setWeek((w) => (action === "replied" ? { ...w, replied: w.replied + 1 } : { ...w, dismissed: w.dismissed + 1 }));
      const next = open.find((t) => t.id !== thread.id);
      setSelectedId(next?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that. Please try again.");
    }
  }

  return (
    <>
      {stuck && (
        <div role="alert" className="scr-banner is-stuck">
          <p>
            <b>{stuck.text.split(". ")[0]}.</b> {stuck.text.split(". ").slice(1).join(". ")}
            {/* Only a scan stopped by its budget left threads behind; one that found nothing worth joining did not. */}
            {stuck.found > 0 ? ` ${stuck.found} threads found before it stopped are below.` : ""}
          </p>
          <span className="scr-head-actions">
            {stuck.found > 0 ? (
              <Button variant="primary" disabled title="Raising the week's budget arrives with the brain's budget controls">
                Add {stuck.creditsToFinish} credits and finish
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  const panel = document.getElementById("sales-settings-title");
                  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
                  panel?.focus({ preventScroll: true });
                }}
              >
                Change where Sales looks
              </Button>
            )}
            <Button variant="secondary" onClick={() => setStuck(null)}>
              Wait for Monday
            </Button>
          </span>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {threads.length === 0 ? (
        <p className="scr-muted">No threads yet. Sales scans the communities your customers use and scores what it finds.</p>
      ) : (
        <div className="scr-sales">
          <div className="v2-panel scr-thread-list">
            <ul aria-label="Threads">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={t.id === selectedId || undefined}
                    className={cx("scr-thread", t.status !== "open" && "is-done", t.rule.kind === "skipped" && "is-skipped")}
                    onClick={() => {
                      setSelectedId(t.id);
                      setPicked((n) => n + 1);
                    }}
                  >
                    <span className="scr-thread-score">{t.score}</span>
                    <span className="scr-thread-text">
                      <span className="scr-thread-meta">
                        {[t.community, t.postedAt && ago(t.postedAt).replace(" ago", ""), t.comments != null && `${t.comments} comments`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <b>{t.title}</b>
                      <span className={cx("scr-small", `is-rule-${t.rule.kind}`)}>
                        {t.status === "replied" ? "You replied" : t.status === "dismissed" ? "Dismissed" : t.rule.text}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="v2-panel-foot">
              <span>
                Replied this week: {week.replied} · dismissed: {week.dismissed}
              </span>
            </div>
          </div>
          {selected ? (
            <ThreadDetail key={selected.id} thread={selected} onDecide={decide} />
          ) : (
            <div className="v2-panel v2-panel-body scr-muted">All threads handled. New ones come with the next scan.</div>
          )}
        </div>
      )}
    </>
  );
}

function ThreadDetail({
  thread,
  onDecide,
}: {
  thread: Thread;
  onDecide: (thread: Thread, action: "replied" | "dismissed", reason?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(thread.draft ?? "");
  const [copied, setCopied] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState<string>(DISMISS_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const skipped = thread.rule.kind === "skipped";
  const done = thread.status !== "open";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyAndOpen() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      // The thread still opens; the founder can select the draft and copy it by hand.
    }
    window.open(thread.url, "_blank", "noopener,noreferrer");
  }

  async function run(action: "replied" | "dismissed", why?: string) {
    setBusy(true);
    await onDecide(thread, action, why);
    setBusy(false);
  }

  return (
    <section className="v2-panel scr-white scr-thread-detail" aria-labelledby="thread-title">
      <MonoLabel small>
        {thread.community}
        {thread.postedAt ? ` · posted ${ago(thread.postedAt)}` : ""}
      </MonoLabel>
      <h2 id="thread-title" className="scr-thread-title">
        <a href={thread.url} target="_blank" rel="noopener noreferrer">
          {thread.title}
        </a>
      </h2>
      {thread.parts.length > 0 && (
        <div className="scr-scores">
          {thread.parts.map((p) => (
            <span key={p.label}>
              <span className="scr-small scr-muted">{p.label}</span>
              <b className="scr-num">
                {p.score}/{p.max}
              </b>
            </span>
          ))}
        </div>
      )}
      {thread.quotes.length > 0 && (
        <div className="scr-quotes">
          <MonoLabel small>Evidence, copied from the thread</MonoLabel>
          {thread.quotes.map((q) => (
            <blockquote key={q.text}>
              “{q.text}” <span className="scr-tiny scr-muted">· {q.from}</span>
            </blockquote>
          ))}
        </div>
      )}
      {skipped ? (
        <p className="scr-muted">{thread.rule.text}. Sales did not draft a reply.</p>
      ) : thread.draft === null ? (
        <p className="scr-muted">No draft yet. Sales drafts replies for the highest-scored threads first.</p>
      ) : (
        <>
          <label className="v2-field" htmlFor="reply-draft">
            <MonoLabel small>Reply draft · {words} words</MonoLabel>
            <textarea id="reply-draft" className="v2-input" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={done} />
          </label>
          {thread.draftChecks && <p className="scr-tiny scr-muted">{thread.draftChecks}</p>}
        </>
      )}
      {!done && (
        <div className="v2-actions">
          {!skipped && thread.draft !== null && (
            <Button variant="primary" onClick={() => void copyAndOpen()} disabled={!draft.trim()}>
              {copied ? "Copied · thread opened" : "Copy and open thread"}
            </Button>
          )}
          {!skipped && (
            <Button variant="secondary" onClick={() => void run("replied")} disabled={busy}>
              I replied
            </Button>
          )}
          {!dismissing ? (
            <Button variant="quiet" onClick={() => setDismissing(true)}>
              Dismiss with reason
            </Button>
          ) : (
            <span className="scr-dismiss">
              <label className="scr-sr-only" htmlFor="dismiss-reason">
                Reason
              </label>
              <select id="dismiss-reason" className="v2-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {DISMISS_REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <Button variant="danger" compact onClick={() => void run("dismissed", reason)} disabled={busy}>
                Dismiss
              </Button>
            </span>
          )}
        </div>
      )}
      {done && <ButtonLink href={thread.url} target="_blank" rel="noopener noreferrer" compact>Open thread</ButtonLink>}
    </section>
  );
}
