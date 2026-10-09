"use client";

import { useRef, useState } from "react";

import { INBOX_CARDS, PROMISES, type InboxCard } from "./data";
import { gsap } from "./motion";

const TAG = { Post: "is-post", Video: "is-video", Sales: "is-sales" } as const;

/**
 * "You stay in control": inbox chơi thử. Approve thì thẻ bay sang phải, Skip thì rơi
 * xuống, Edit sửa ngay trong thẻ. Chỉ thẻ trên cùng bấm được; hai thẻ dưới là chồng giấy.
 */
export function ControlSection() {
  const [cards, setCards] = useState<InboxCard[]>(() => INBOX_CARDS.map((c) => ({ ...c })));
  const [editing, setEditing] = useState<string | null>(null);
  const [approved, setApproved] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [toast, setToast] = useState("");
  const stackRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  };

  const fly = (id: string, dir: 1 | -1, after: () => void) => {
    const el = stackRef.current?.querySelector<HTMLElement>(`[data-card="${id}"]`);
    if (!el) return after();
    el.style.transition = "none";
    gsap.to(el, dir > 0
      ? { x: 320, y: -40, rotate: 8, opacity: 0, duration: 0.6, ease: "power3.in", onComplete: after }
      : { x: -60, y: 120, rotate: -6, opacity: 0, duration: 0.55, ease: "power2.in", onComplete: after });
  };

  const drop = (c: InboxCard) => {
    setCards((all) => all.filter((x) => x.id !== c.id));
    setEditing(null);
  };

  const reset = () => {
    setCards(INBOX_CARDS.map((c) => ({ ...c })));
    setApproved(0);
    setSkipped(0);
    setEditing(null);
    requestAnimationFrame(() => {
      const els = stackRef.current?.querySelectorAll("[data-card]");
      if (els?.length) gsap.from(els, { y: 60, opacity: 0, duration: 0.9, ease: "expo.out", stagger: 0.08 });
    });
  };

  return (
    <section id="control" aria-labelledby="control-title" className="lv-panel-section">
      <div className="lv-container lv-control-grid">
        <div className="lv-stack-26">
          <p data-rise="1" className="lv-eyebrow">You stay in control</p>
          <h2 id="control-title" className="lv-h2">
            <span className="lv-mask"><span data-h="1">Your CMO drafts.</span></span>
            <span className="lv-mask"><span data-h="1" className="lv-accent">You decide.</span></span>
          </h2>
          <p data-rise="1" className="lv-lede">Each morning the departments leave their work in one inbox. Approve, edit or skip in a few minutes. Try it here.</p>
          <ul className="lv-promises">
            {PROMISES.map((p) => (
              <li key={p.title} data-rise="1"><b>{p.title}</b><span>{p.body}</span></li>
            ))}
          </ul>
        </div>

        <div data-rise="1" className="lv-slab lv-inbox">
          <div className="lv-inbox-head">
            <div><span>Needs your attention</span><b>This morning</b></div>
            <span className="lv-inbox-count">{cards.length ? `${cards.length} waiting${approved ? ` · ${approved} approved` : ""}` : ""}</span>
          </div>
          <div ref={stackRef} className="lv-inbox-stack">
            {cards.slice(0, 3).map((c, i) => {
              const top = i === 0, isEditing = editing === c.id;
              return (
                <div
                  key={c.id}
                  data-card={c.id}
                  className="lv-card"
                  style={{ zIndex: 10 - i, transform: `translateY(${i * 18}px) scale(${(1 - i * 0.045).toFixed(3)})`, filter: i ? `brightness(${1 - i * 0.06})` : "none" }}
                  aria-hidden={top ? undefined : true}
                >
                  <div className="lv-card-meta"><span className={`lv-tag ${TAG[c.dept]}`}>{c.dept}</span><span>{c.when}</span></div>
                  <b className="lv-card-title">{c.title}</b>
                  {isEditing ? (
                    <textarea
                      value={c.body}
                      aria-label="Edit draft"
                      rows={4}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCards((all) => all.map((x) => (x.id === c.id ? { ...x, body: v } : x)));
                      }}
                    />
                  ) : (
                    <p className="lv-card-body">{c.body}</p>
                  )}
                  {c.thumbs && <div className="lv-card-thumbs">{Array.from({ length: c.thumbs }, (_, n) => <span key={n} />)}</div>}
                  <div className="lv-card-actions">
                    <button type="button" tabIndex={top ? 0 : -1} onClick={() => top && fly(c.id, -1, () => { drop(c); setSkipped((n) => n + 1); })}>Skip</button>
                    <button type="button" tabIndex={top ? 0 : -1} onClick={() => top && setEditing(isEditing ? null : c.id)}>{isEditing ? "Done" : "Edit"}</button>
                    <button
                      type="button"
                      className="is-primary"
                      tabIndex={top ? 0 : -1}
                      onClick={() => top && fly(c.id, 1, () => {
                        drop(c);
                        setApproved((n) => n + 1);
                        say(c.dept === "Sales" ? "Thread opened. You post the reply yourself." : "Approved. It goes out on schedule.");
                      })}
                    >
                      {c.dept === "Sales" ? "Open thread" : "Approve"}
                    </button>
                  </div>
                </div>
              );
            })}
            {cards.length === 0 && (
              <div className="lv-inbox-empty">
                <b>Inbox clear.</b>
                <span>{approved} approved, {skipped} skipped. Nothing went out that you didn&apos;t choose.</span>
                <button type="button" onClick={reset}>Bring tomorrow&apos;s drafts</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {toast && <div role="status" className="lv-toast">{toast}</div>}
    </section>
  );
}
