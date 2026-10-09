"use client";

/**
 * Video brief cards (architecture P3). The CMO writes an editing brief for clips the founder
 * already cut from their own video. Approving only opens the project with the brief filled into
 * the project assistant; the founder sends it there and approves each change. Skipping with a
 * reason teaches the CMO.
 */

import { useState } from "react";

import { Icon } from "@/components/icons";
import type { BriefView } from "@/lib/cmo/workspace";

import type { Actions } from "./actions";
import { AgentMark } from "./AgentMark";
import { ago } from "./time";

export function BriefCards({ briefs, actions }: { briefs: BriefView[]; actions: Actions }) {
  if (!briefs.length) return null;
  return (
    <ol className="cmo-feed cmo-briefs" aria-label="Video briefs">
      {briefs.map((brief) => (
        <li key={brief.id}>
          <BriefCard brief={brief} actions={actions} />
        </li>
      ))}
    </ol>
  );
}

function BriefCard({ brief, actions }: { brief: BriefView; actions: Actions }) {
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(act: { action: "approve" } | { action: "skip"; reason?: string }) {
    setBusy(true);
    await actions.brief(brief, act);
    setBusy(false);
  }

  return (
    <article className="cmo-feed-card dept-video cmo-brief-card" data-testid="cmo-brief-card">
      <header>
        <AgentMark department="video" size={26} />
        <p className="cmo-feed-agent">
          Video brief · <time dateTime={brief.createdAt} suppressHydrationWarning>{ago(brief.createdAt)}</time>
        </p>
      </header>
      <div className="cmo-feed-open">
        <strong>{brief.hook}</strong>
        <span>For {brief.projectTitle}</span>
      </div>
      <dl className="cmo-brief-parts">
        {brief.broll ? (<><dt>B-roll</dt><dd>{brief.broll}</dd></>) : null}
        {brief.visuals ? (<><dt>Visuals</dt><dd>{brief.visuals}</dd></>) : null}
        {brief.pacing ? (<><dt>Pacing</dt><dd>{brief.pacing}</dd></>) : null}
      </dl>
      {skipping ? (
        <form
          className="cmo-skip"
          onSubmit={(e) => {
            e.preventDefault();
            void decide({ action: "skip", reason: reason.trim() || undefined });
          }}
        >
          <label htmlFor={`brief-skip-${brief.id}`}>Why skip it? <small>Optional. Your CMO learns from it.</small></label>
          <input id={`brief-skip-${brief.id}`} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="Wrong hook, too busy, not my style…" />
          <div className="cmo-feed-actions">
            <button type="button" className="text-button" onClick={() => setSkipping(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>Skip brief</button>
          </div>
        </form>
      ) : (
        <div className="cmo-feed-actions">
          <button type="button" className="text-button" disabled={busy} onClick={() => setSkipping(true)}>Skip</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void decide({ action: "approve" })}>
            Open in assistant <Icon name="external-link" size={14} />
          </button>
        </div>
      )}
    </article>
  );
}
