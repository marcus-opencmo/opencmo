"use client";

/**
 * Ngăn kéo bên phải khi bấm một thẻ trong Inbox: toàn bộ chi tiết để quyết định.
 *
 * Mỗi loại đúng nút của nó (san-pham.md §3.3):
 * - bài X: Approve · Edit · Skip, ba phiên bản, đếm 280 ký tự;
 * - thread Reddit: Open thread · Copy reply · I replied · Dismiss — KHÔNG có nút đăng;
 * - gói video: xem clip, caption từng nền tảng (Copy) · Approve all · Open in editor · Skip;
 *   đã duyệt thì Download từng clip — người dùng tự đăng, không có nút đăng.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import type { InboxCard, PostCard, SalesCard, VideoCard } from "@/lib/cmo/workspace";

import { xIntent, type Actions } from "./actions";
import { AgentMark } from "./AgentMark";
import { ago, when } from "./time";

type Props = { card: InboxCard | null; agentName: string; onClose: () => void; actions: Actions };

export function CardDrawer({ card, agentName, onClose, actions }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (card && !dialog.open) dialog.showModal();
    if (!card && dialog.open) dialog.close();
  }, [card]);

  // Quyết định xong (thành công) thì đóng ngăn kéo; lỗi thì giữ lại để người dùng sửa.
  const act: Actions["card"] = async (c, a) => {
    const ok = await actions.card(c, a);
    if (ok) onClose();
    return ok;
  };

  return (
    <dialog ref={ref} className="cmo-drawer" aria-labelledby="cmo-drawer-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      {card ? (
        <div className="cmo-drawer-inner" data-testid={`cmo-card-${card.department}`}>
          <header className="cmo-drawer-head">
            <AgentMark department={card.department} size={28} />
            <div>
              <p className="cmo-feed-agent">{agentName} · <time dateTime={card.createdAt} suppressHydrationWarning>{ago(card.createdAt)}</time></p>
              <h2 id="cmo-drawer-title">{card.department === "video" ? `${card.clips.length} clips ready` : card.title}</h2>
            </div>
            <button type="button" className="cmo-icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          </header>
          {card.department === "post" ? <PostDetail key={card.id} card={card} act={act} /> : null}
          {card.department === "sales" ? <SalesDetail key={card.id} card={card} act={act} onToast={actions.toast} /> : null}
          {card.department === "video" ? <VideoDetail key={card.id} card={card} act={act} onToast={actions.toast} /> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function PostDetail({ card, act }: { card: PostCard; act: Actions["card"] }) {
  const versions = card.finalText ? [card.finalText] : [card.text, ...card.alternates];
  const approved = card.state === "approved";
  const [busy, setBusy] = useState(false);
  const run = async (a: Parameters<Actions["card"]>[1]) => {
    setBusy(true);
    await act(card, a);
    setBusy(false);
  };
  const [pick, setPick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.text);
  const current = editing ? text : versions[pick];
  return (
    <>
      <div className="cmo-x-preview">
        <span className="cmo-x-avatar" aria-hidden>You</span>
        <div>
          <p className="cmo-x-name">Your X account</p>
          {editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} aria-label="Post text" />
          ) : (
            <p className="cmo-x-text">{current}</p>
          )}
          <p className={`cmo-x-count ${current.length > 280 ? "is-over" : ""}`}>{current.length}/280</p>
        </div>
      </div>
      {versions.length > 1 && !editing && !approved ? (
        <div className="cmo-versions" role="group" aria-label="Versions">
          {versions.map((_, i) => (
            <button key={i} type="button" aria-pressed={pick === i} onClick={() => setPick(i)}>Version {i + 1}</button>
          ))}
        </div>
      ) : null}
      <p className="cmo-why"><b>Why:</b> {card.rationale}</p>
      {approved ? (
        <>
          <p className="cmo-why"><b>Approved.</b> Post on X opens the post ready to send from your own account. Come back and mark it posted.</p>
          <div className="cmo-card-actions">
            <a className="primary-button" href={xIntent(current)} target="_blank" rel="noopener noreferrer">
              Post on X <Icon name="external-link" size={14} />
            </a>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void run({ type: "posted" })}>I posted it</button>
          </div>
        </>
      ) : (
        <>
          {card.scheduledFor ? <p className="cmo-why" suppressHydrationWarning><b>Goes out:</b> {when(card.scheduledFor)}, on your account, after you approve.</p> : null}
          <div className="cmo-card-actions">
            <button type="button" className="primary-button" disabled={busy || current.length > 280} onClick={() => void run({ type: "approve", text: current })}>
              Approve
            </button>
            {editing ? (
              <button type="button" className="secondary-button" onClick={() => setEditing(false)}>Done</button>
            ) : (
              <button type="button" className="secondary-button" onClick={() => { setText(versions[pick]); setEditing(true); }}>Edit</button>
            )}
            <button type="button" className="text-button" disabled={busy} onClick={() => void run({ type: "skip" })}>Skip</button>
          </div>
        </>
      )}
    </>
  );
}

function SalesDetail({ card, act, onToast }: { card: SalesCard; act: Actions["card"]; onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const run = async (a: Parameters<Actions["card"]>[1]) => {
    setBusy(true);
    await act(card, a);
    setBusy(false);
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(card.reply);
      onToast("Reply copied. Paste it in the thread from your own account");
    } catch {
      onToast("Could not copy. Select the reply and copy it");
    }
  }
  return (
    <>
      <div className="cmo-thread">
        <p className="cmo-thread-meta" suppressHydrationWarning>{[card.thread.community, card.thread.author, card.thread.postedAt ? ago(card.thread.postedAt) : null, `${card.thread.comments} comments`].filter(Boolean).join(" · ")}</p>
        <p className="cmo-thread-title">{card.thread.title}</p>
        <p className="cmo-thread-snippet">{card.thread.snippet}</p>
      </div>
      <button type="button" className="cmo-score" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cmo-score-num">{card.score}</span>
        <span className="cmo-score-label">Worth joining<small>{open ? "Hide why" : "See why"}</small></span>
      </button>
      {open ? (
        <ul className="cmo-parts">
          {card.parts.map((p) => (
            <li key={p.label}>
              <span className="cmo-part-label">{p.label}</span>
              <span className="cmo-part-bar" aria-hidden><span style={{ width: `${(p.score / p.max) * 100}%` }} /></span>
              <span className="cmo-part-score">{p.score}/{p.max}</span>
              <span className="cmo-part-ev">{p.evidence}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cmo-reply">
        <p className="cmo-reply-label">Drafted reply · you post it</p>
        <p>{card.reply}</p>
      </div>
      <p className="cmo-why">Open the thread, read it, and paste the reply from your own Reddit account if it fits. Then mark it replied.</p>
      {dismissing ? (
        <form
          className="cmo-skip"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ type: "dismiss", reason: reason.trim() || undefined });
          }}
        >
          <label htmlFor={`dismiss-${card.id}`}>Why dismiss it? <small>Optional. Your CMO learns from it.</small></label>
          <input id={`dismiss-${card.id}`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="Not our customer, wrong subreddit, too old…" />
          <div className="cmo-feed-actions">
            <button type="button" className="text-button" onClick={() => setDismissing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>Dismiss</button>
          </div>
        </form>
      ) : (
        <div className="cmo-card-actions">
          <a className="primary-button" href={card.thread.url} target="_blank" rel="noopener noreferrer">
            Open thread <Icon name="external-link" size={14} />
          </a>
          <button type="button" className="secondary-button" onClick={copy}>Copy reply</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void run({ type: "replied" })}>I replied</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => setDismissing(true)}>Dismiss</button>
        </div>
      )}
    </>
  );
}

const PLATFORM_LABEL: [string, string][] = [
  ["tiktok", "TikTok"],
  ["reels", "Instagram Reels"],
  ["shorts", "YouTube Shorts title"],
  ["facebook", "Facebook Reels"],
  ["threads", "Threads"],
];

const length = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function VideoDetail({ card, act, onToast }: { card: VideoCard; act: Actions["card"]; onToast: (message: string) => void }) {
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const approved = card.state === "approved";
  const clip = card.clips[pick] ?? card.clips[0];
  const editHref = (id: string) => `/app/editor/${id}`;
  const run = async (a: Parameters<Actions["card"]>[1]) => {
    setBusy(true);
    await act(card, a);
    setBusy(false);
  };
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label} copied. Paste it when you post from your own account`);
    } catch {
      onToast("Could not copy. Select the text and copy it");
    }
  }

  return (
    <>
      <p className="cmo-video-source"><Icon name="film" size={14} /> {card.source}</p>
      <ol className={`cmo-clips${card.state ? " is-real" : ""}`} aria-label="Clips">
        {card.clips.map((c, i) => (
          <li key={c.id} className="cmo-clip">
            <button type="button" className="cmo-clip-pick" aria-pressed={i === pick} onClick={() => setPick(i)} aria-label={`Clip ${i + 1}: ${c.title}`}>
              {c.previewUrl ? (
                <video src={c.previewUrl} preload="metadata" muted playsInline controls={i === pick} onClick={(e) => i !== pick && e.preventDefault()} />
              ) : (
                <span className="cmo-clip-frame" aria-hidden><span>{c.hook}</span></span>
              )}
              <span className="cmo-clip-title">{c.title}</span>
              <span className="cmo-clip-len">{length(c.seconds)}</span>
            </button>
          </li>
        ))}
      </ol>

      {clip?.captions ? (
        <div className="cmo-captions" aria-label={`Captions for clip ${pick + 1}`}>
          {PLATFORM_LABEL.filter(([key]) => clip.captions?.[key]).map(([key, label]) => (
            <div key={key} className="cmo-caption">
              <p className="cmo-caption-head">
                {label}
                <small>{[...(clip.captions?.[key] ?? "")].length} characters</small>
                <button type="button" className="cmo-icon-btn" aria-label={`Copy ${label} caption`} onClick={() => void copy(clip.captions?.[key] ?? "", label)}>
                  <Icon name="copy" size={14} />
                </button>
              </p>
              <p>{clip.captions?.[key]}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="cmo-why"><b>Goes to:</b> {card.platforms.join(", ")}, with a caption written for each.</p>
      )}

      {approved ? (
        <>
          <p className="cmo-why">
            <b>Approved.</b> Your CMO tightened the pauses and the caption timing. Download each clip, then post it from your
            own accounts with the captions above.
          </p>
          <ul className="cmo-downloads">
            {card.clips.map((c, i) => (
              <li key={c.id}>
                <span>Clip {i + 1}</span>
                {c.download?.status === "done" ? (
                  <a href={`/api/v1/tasks/${c.download.taskId}/file`}>Download MP4</a>
                ) : c.download?.status === "failed" || c.download?.status === "cancelled" || !c.download ? (
                  <a href={editHref(c.id)}>Export failed. Open in editor</a>
                ) : (
                  <span className="cmo-muted">Preparing…</span>
                )}
              </li>
            ))}
          </ul>
          <div className="cmo-card-actions">
            {clip ? <a className="secondary-button" href={editHref(clip.id)}>Open clip {pick + 1} in editor</a> : null}
          </div>
        </>
      ) : skipping ? (
        <form
          className="cmo-skip"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ type: "dismiss", reason: reason.trim() || undefined });
          }}
        >
          <label htmlFor={`skip-${card.id}`}>Why skip it? <small>Optional. Your CMO learns from it.</small></label>
          <input id={`skip-${card.id}`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="Wrong moments, too long, not on brand…" />
          <div className="cmo-feed-actions">
            <button type="button" className="text-button" onClick={() => setSkipping(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>Skip pack</button>
          </div>
        </form>
      ) : (
        <>
          <p className="cmo-why">Approve to get downloads: pauses removed and captions timed in short phrases. Nothing is posted for you.</p>
          <div className="cmo-card-actions">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void run({ type: "approve" })}>
              {busy ? "Preparing…" : "Approve all"}
            </button>
            {clip ? <a className="secondary-button" href={editHref(clip.id)}>Open in editor</a> : null}
            <button type="button" className="text-button" disabled={busy} onClick={() => setSkipping(true)}>Skip</button>
          </div>
        </>
      )}
    </>
  );
}
