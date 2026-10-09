"use client";

/**
 * Cột Approvals: "Awaiting your approval" + "Your departments", hai phần thu gọn được.
 *
 * Thẻ ở đây là bản gọn — agent, mức gấp, tiêu đề, hai dòng xem trước và nút
 * quyết định nhanh. Bấm vào thẻ mở `CardDrawer` với đủ chi tiết. Thẻ Reddit
 * không bao giờ có nút đăng: nút chính chỉ mở bản nháp để người dùng tự đăng.
 */

import { useState } from "react";

import { Icon } from "@/components/icons";
import type { AgentSummary, InboxCard, Workspace } from "@/lib/cmo/workspace";

import { xIntent, type Actions } from "./actions";
import { AgentMark } from "./AgentMark";
import { BriefCards } from "./BriefCards";
import { CardDrawer } from "./CardDrawer";
import { GoalCards } from "./GoalCards";
import { NewVideoPack } from "./NewVideoPack";
import { PanelHead } from "./PanelHead";
import { ago, when } from "./time";

type Props = { ws: Workspace; actions: Actions };

const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const RANK = { high: 0, medium: 1, low: 2 } as const;

function preview(card: InboxCard): string {
  if (card.department === "post") return card.finalText ?? card.text;
  if (card.department === "sales") return `${card.thread.community}: “${card.thread.title}” ${card.thread.snippet}`;
  return `From ${card.source}. ${card.clips.map((c) => c.title).join(" · ")}`;
}

export function FeedPanel({ ws, actions }: Props) {
  const [inboxOpen, setInboxOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Chờ duyệt trước (việc của bạn bây giờ), đã duyệt chờ đăng sau; trong mỗi nhóm theo mức gấp.
  const waiting = (c: InboxCard) => ((c.department === "post" || c.department === "video") && c.state === "approved" ? 1 : 0);
  const cards = [...ws.inbox].sort((a, b) => waiting(a) - waiting(b) || RANK[a.priority] - RANK[b.priority] || b.createdAt.localeCompare(a.createdAt));
  const openCard = ws.inbox.find((c) => c.id === openId) ?? null;
  const agentName = (card: InboxCard) => ws.agents.find((a) => a.department === card.department)?.name ?? "Agent";

  return (
    <section className="cmo-panel is-feed" aria-labelledby="cmo-feed-title">
      <PanelHead id="cmo-feed-title" icon="check" title="Approvals" live={ws.live.inbox || ws.demo} />

      <div className="cmo-section">
        <button type="button" className="cmo-section-head" aria-expanded={inboxOpen} onClick={() => setInboxOpen(!inboxOpen)}>
          <span>Awaiting your approval</span>
          <small>{cards.filter((c) => !waiting(c)).length + ws.goals.filter((g) => g.status === "proposed").length + ws.briefs.length}</small>
          <Icon name={inboxOpen ? "chevron-up" : "chevron-down"} size={16} />
        </button>
        {inboxOpen ? <GoalCards goals={ws.goals} actions={actions} /> : null}
        {inboxOpen ? <BriefCards briefs={ws.briefs} actions={actions} /> : null}
        {inboxOpen ? (
          cards.length === 0 ? (
            <div className="cmo-empty-card">
              <p><strong>Nothing to review yet.</strong></p>
              <p>
                Drafts from your agents land here: posts for X, Reddit conversations worth joining, and clips from your
                videos. Nothing goes out until you approve it.
              </p>
            </div>
          ) : (
            <ol className="cmo-feed">
              {cards.map((card) => (
                <li key={card.id}>
                  <FeedCard card={card} agentName={agentName(card)} actions={actions} onOpen={() => setOpenId(card.id)} />
                </li>
              ))}
            </ol>
          )
        ) : null}
      </div>

      <div className="cmo-section">
        <button type="button" className="cmo-section-head" aria-expanded={agentsOpen} onClick={() => setAgentsOpen(!agentsOpen)}>
          <span>Your departments</span>
          <Icon name={agentsOpen ? "chevron-up" : "chevron-down"} size={16} />
        </button>
        {agentsOpen ? (
          <ul className="cmo-agent-list">
            {ws.agents.map((agent) => <AgentRow key={agent.department} agent={agent} actions={actions} />)}
          </ul>
        ) : null}
      </div>

      <CardDrawer card={openCard} agentName={openCard ? agentName(openCard) : ""} onClose={() => setOpenId(null)} actions={actions} />
    </section>
  );
}

function AgentRow({ agent, actions }: { agent: AgentSummary; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const video = agent.department === "video";
  const unit = agent.ready === 1 ? agent.unit[0] : agent.unit[1];
  return (
    <li className="cmo-agent-row" data-open={open || undefined}>
      <button type="button" className="cmo-agent-sum" aria-expanded={open} onClick={() => setOpen(!open)}>
        <AgentMark department={agent.department} size={30} />
        <span className="cmo-agent-text">
          <b>{agent.name}</b>
          <span>{agent.ready ? `${agent.ready} ${unit} ready` : `No ${agent.unit[1]} waiting`}</span>
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open ? (
        <div className="cmo-agent-more">
          <p>{agent.goal}</p>
          <p className="cmo-muted" suppressHydrationWarning>
            {agent.channels}
            {agent.nextRun ? ` · next run ${when(agent.nextRun)}` : ""}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={!agent.runnable || starting}
            title={agent.runnable ? undefined : agent.department === "sales" ? "Reddit scanning is not set up yet" : "This agent is not connected yet"}
            onClick={async () => {
              // Video cần một video của người dùng — mở hộp chọn thay vì chạy ngay.
              if (video) return setPackOpen(true);
              setStarting(true);
              await actions.run(agent.department === "sales" ? "sales_scan" : "post_draft");
              setStarting(false);
            }}
          >
            {video ? (
              <><Icon name="plus" size={14} /> New video pack</>
            ) : (
              <><Icon name="refresh-cw" size={14} /> Run now</>
            )}
          </button>
        </div>
      ) : null}
      {video ? (
        <NewVideoPack
          open={packOpen}
          onClose={() => setPackOpen(false)}
          onStarted={() => {
            setPackOpen(false);
            actions.toast("Making your clips. Your video pack shows up here in a few minutes.");
            void actions.refresh();
          }}
        />
      ) : null}
    </li>
  );
}

function FeedCard({ card, agentName, actions, onOpen }: { card: InboxCard; agentName: string; actions: Actions; onOpen: () => void }) {
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const approved = (card.department === "post" || card.department === "video") && card.state === "approved";
  const sales = card.department === "sales";

  async function act(fn: () => Promise<boolean>) {
    setBusy(true);
    await fn();
    setBusy(false);
  }

  return (
    <article className={`cmo-feed-card is-${card.priority} dept-${card.department}${approved ? " is-approved" : ""}`} data-testid={`cmo-feed-${card.department}`}>
      <header>
        <AgentMark department={card.department} size={26} />
        <p className="cmo-feed-agent">
          {agentName} · <time dateTime={card.createdAt} suppressHydrationWarning>{ago(card.createdAt)}</time>
        </p>
        {approved ? (
          <span className="cmo-priority is-ready"><span className="cmo-gem is-on" aria-hidden="true" />Approved</span>
        ) : (
          <span className={`cmo-priority is-${card.priority}`}><span className="cmo-gem" aria-hidden="true" />{PRIORITY_LABEL[card.priority]}</span>
        )}
      </header>
      <button type="button" className="cmo-feed-open" onClick={onOpen}>
        <strong>{card.department === "video" ? `${card.clips.length} clips ready` : card.title}</strong>
        <span>{preview(card)}</span>
      </button>
      {sales ? (
        <p className="cmo-feed-score" title="Open the card to see how this score was worked out">
          <b>{card.score}</b> Worth joining · {card.thread.community}
        </p>
      ) : null}
      {card.department === "post" && card.rationale ? (
        <p className="cmo-feed-why">
          <b>Why · </b>
          {card.rationale}
        </p>
      ) : null}
      {skipping ? (
        <form
          className="cmo-skip"
          onSubmit={(e) => {
            e.preventDefault();
            const why = reason.trim() || undefined;
            void act(() => actions.card(card, sales ? { type: "dismiss", reason: why } : { type: "skip", reason: why }));
          }}
        >
          <label htmlFor={`skip-${card.id}`}>{sales ? "Why dismiss it?" : "Why skip it?"} <small>Optional. Your CMO learns from it.</small></label>
          <input
            id={`skip-${card.id}`}
            value={reason}
            maxLength={400}
            onChange={(e) => setReason(e.target.value)}
            placeholder={sales ? "Not our customer, wrong subreddit, too old…" : "Too salesy, wrong topic, already posted…"}
          />
          <div className="cmo-feed-actions">
            <button type="button" className="text-button" onClick={() => setSkipping(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>{sales ? "Dismiss" : card.department === "video" ? "Skip pack" : "Skip post"}</button>
          </div>
        </form>
      ) : (
        <div className="cmo-feed-actions">
          {card.department === "post" ? (
            approved ? (
              <>
                <button type="button" className="text-button" disabled={busy} onClick={() => void act(() => actions.card(card, { type: "posted" }))}>
                  I posted it
                </button>
                <a className="primary-button" href={xIntent(card.finalText ?? card.text)} target="_blank" rel="noopener noreferrer">
                  Post on X <Icon name="external-link" size={14} />
                </a>
              </>
            ) : (
              <>
                <button type="button" className="text-button" disabled={busy} onClick={() => setSkipping(true)}>Ignore</button>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void act(() => actions.card(card, { type: "approve" }))}>
                  Approve
                </button>
              </>
            )
          ) : card.department === "sales" ? (
            <>
              <button type="button" className="text-button" disabled={busy} onClick={() => setSkipping(true)}>Dismiss</button>
              <button type="button" className="primary-button" onClick={onOpen}>View reply</button>
            </>
          ) : (
            approved ? (
              <button type="button" className="primary-button" onClick={onOpen}>Downloads</button>
            ) : (
              <>
                <button type="button" className="text-button" disabled={busy} onClick={() => setSkipping(true)}>Skip</button>
                <button type="button" className="primary-button" onClick={onOpen}>Review clips</button>
              </>
            )
          )}
        </div>
      )}
    </article>
  );
}
