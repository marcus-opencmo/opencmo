"use client";

/**
 * One approval card (Cards.dc.html): head = department · kind, body = the thing itself, foot = price, account, time,
 * then exactly one filled button that does what the head names. Renders the `ApprovalCard` contract
 * (`lib/screens/approval-card.ts`) in the Dashboard queue (collapsible) and on `/app/inbox/[id]`.
 */

import Link from "next/link";
import { useState } from "react";

import { useShellState } from "@/components/shell-v2/ShellState";
import { ApiError } from "@/components/clipping/api";
import { Button, ButtonLink } from "@/components/ui";
import { intentFor } from "@/lib/departments/publish/intent";
import { isPublishPlatform } from "@/lib/departments/publish/types";
import { PRIMARY_ACTION, type ApprovalCard as Card, type Caption, type ScheduleOptions } from "@/lib/screens/approval-card";

import {
  CorrectionBody,
  FinishedVideoBody,
  GoalBody,
  PostBody,
  PriceBody,
  ReplyBody,
  ScheduleBody,
  ScriptBody,
  ShortsBody,
  SlideshowBody,
} from "./bodies";
import { blockedReason, editCaption, type Decision } from "./decide";
import { renderAgain, saveSlideText, slidesHref } from "./slides";
import { NUMERAL, cardHead, headNote } from "./labels";
import { approveBlocked, fromLocalInput, sameOptions, savedOptions, toLocalInput } from "./schedule";

export type DecideHandler = (card: Card, decision: Decision) => Promise<boolean>;

type Variant = "primary" | "secondary" | "quiet";
type Action =
  | {
      label: string;
      variant: Variant;
      run: () => void;
      disabled?: string;
      /** Set on declines: checked on its own. */
      declines?: boolean;
      /** The decision this button sends, when a card's problem allows some actions and not others. */
      checks?: Decision["action"];
    }
  | { label: string; variant: Variant; href: string };

const STATE_LABEL = { failed: "Failed", missed: "Missed", no_account: "Copy and open", unconfirmed: "Not confirmed" } as const;

const PROBLEM_LABEL = { expired: "Expired", decided_elsewhere: "Decided", needs_credits: "Credits", failed: "Failed" } as const;

/** The decline action of each kind: its label and the decision it sends with the optional reason. */
const DECLINE: Partial<Record<Card["kind"], { label: string; action: "skip" | "dismissed" | "reject" | "cancel" | "send_back" }>> = {
  post: { label: "Skip with reason", action: "skip" },
  reply: { label: "Dismiss", action: "dismissed" },
  goal: { label: "Reject", action: "reject" },
  script: { label: "Cancel", action: "cancel" },
  price: { label: "Cancel", action: "cancel" },
  finished_video: { label: "Send back", action: "send_back" },
  shorts_batch: { label: "Send back", action: "send_back" },
  slideshow: { label: "Send back", action: "send_back" },
  correction: { label: "Dismiss", action: "reject" },
  schedule: { label: "Cancel", action: "cancel" },
};

function firstText(card: Card): string {
  if (card.body.kind === "post") return card.body.platforms[0]?.versions[0] ?? "";
  if (card.body.kind === "correction") return card.body.rule;
  return "";
}

function decidedNote(card: Card): string | null {
  if (card.status === "waiting" || card.problem) return null;
  return card.status === "skipped" || card.status === "cancelled" ? "You set this card aside." : "You decided this card.";
}

export function ApprovalCard({
  card: given,
  sample,
  onDecide,
  open = true,
  onToggle,
  headingLevel = "h3",
}: {
  card: Card;
  /** Fixture card (outside production only): decisions change this screen and nothing else. */
  sample: boolean;
  onDecide: DecideHandler;
  /** Queue only: whether the body shows. */
  open?: boolean;
  /** Queue only: makes the head a toggle. */
  onToggle?: () => void;
  headingLevel?: "h2" | "h3";
}) {
  const { toast } = useShellState();
  // A saved caption changes the card in place (new hash); a newer card from the parent replaces it.
  const [changed, setChanged] = useState<{ from: Card; card: Card } | null>(null);
  const card = changed && changed.from === given ? changed.card : given;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [declining, setDeclining] = useState(false);
  /** Price card: the keyframe picker is open. */
  const [redoing, setRedoing] = useState(false);
  const [keyframe, setKeyframe] = useState(0);
  /** Script card: the beat being edited. */
  const [beat, setBeat] = useState(0);
  const [reason, setReason] = useState("");
  /** Schedule card: the platform's fields as the founder is changing them, and the change-time picker. */
  const [options, setOptions] = useState<ScheduleOptions>(() => (card.body.kind === "schedule" ? card.body.options : {}));
  const [moving, setMoving] = useState(false);
  const [newTime, setNewTime] = useState("");
  const [shown, setShown] = useState(() => firstText(card));
  /** Slideshow card: a slide's words were saved, so its renders are older than the edit and a new render runs. */
  const [slideEdited, setSlideEdited] = useState(false);
  /** Slideshow card: a decision was refused (the slideshow was edited elsewhere since it was rendered). */
  const [slideStale, setSlideStale] = useState(false);
  const [draft, setDraft] = useState(() => firstText(card));
  const beats = card.body.kind === "script" ? card.body.beats : [];

  const blocked = blockedReason(card, sample);
  const captionsBlocked = blocked ?? (busy ? "Wait for the decision to finish." : null);
  const Heading = headingLevel;
  const head = cardHead(card);
  const numeral = NUMERAL[card.department];
  const note = headNote(card);
  const bodyId = `card-${card.id}-body`;
  const decline = DECLINE[card.kind];

  async function run(decision: Decision): Promise<boolean> {
    if (busy || blockedReason(card, sample, decision.action)) return false;
    setBusy(true);
    const ok = await onDecide(card, decision);
    // A decided card leaves the queue and unmounts; only a refused one comes back to edit.
    if (!ok) setBusy(false);
    // A slideshow refused after an edit in the Slides view can be rendered again from here.
    if (!ok && card.kind === "slideshow") setSlideStale(true);
    return ok;
  }

  /**
   * The copy-and-open moment of a post with no connected account (P4 F9): X and Threads open their composer with the
   * words in it, LinkedIn's text is copied first. The tab opens and the text is copied inside the click (later ones
   * are blocked); the founder then says "I posted it". A sample card opens nothing and copies nothing.
   */
  async function copyAndOpen(body: Extract<Card["body"], { kind: "schedule" }>) {
    const text = body.preview.text ?? "";
    const target = isPublishPlatform(body.where.platform) ? intentFor(body.where.platform, text) : null;
    if (!target) return;
    if (sample) return toast("Sample card: nothing was copied or opened.");
    const copied = target.copy ? (navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false)) : Promise.resolve(true);
    const tab = window.open(target.url, "_blank", "noopener,noreferrer");
    if (!(await copied)) toast("Copy did not work here. Select the post and copy it yourself.");
    else toast(tab === null && !target.copy ? "Your browser blocked the new tab. Open the platform yourself and post it from your account." : "Post it from your account, then tell us here.");
  }

  async function saveSlide(index: number, heading: string, words: string): Promise<boolean> {
    try {
      const next = await saveSlideText(card, index, heading, words, sample);
      setChanged({ from: given, card: next });
      setSlideEdited(true);
      toast(sample ? "Slide saved (sample, nothing was sent)." : "Slide saved. The slideshow renders again and comes back as a new card.");
      return true;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
      return false;
    }
  }

  async function rerender() {
    if (busy) return;
    setBusy(true);
    try {
      await renderAgain(card, sample);
      setSlideEdited(true);
      setSlideStale(false);
      toast(sample ? "Rendering again (sample, nothing was sent)." : "Rendering again. A new card replaces this one when it is ready.");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCaption(caption: Caption): Promise<boolean> {
    try {
      const next = await editCaption(card, caption, sample);
      setChanged({ from: given, card: next });
      toast(sample ? "Caption saved (sample, nothing was sent)." : "Caption saved. Approve the card when the words are right.");
      return true;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Something went wrong. Please try again.");
      return false;
    }
  }

  function approve() {
    // The first version is what the card's hash covers as is; any other text is sent as the founder's edit.
    if (card.kind === "post") {
      const text = editing ? draft.trim() : shown;
      return run({ action: "approve", text: text !== firstText(card) ? text : undefined });
    }
    if (card.kind === "correction" && editing) return run({ action: "edit", text: draft.trim() });
    if (card.kind === "script" && editing) {
      const words = draft.trim();
      // An unchanged beat approves the script as the card's hash covers it.
      return run(words && words !== beats[beat]?.words ? { action: "edit", beat, text: words } : { action: "approve" });
    }
    return run({ action: "approve" });
  }

  async function copyReply() {
    if (card.body.kind !== "reply") return;
    try {
      await navigator.clipboard.writeText(card.body.draft);
      toast("Reply copied. Paste it in the thread and post it from your own account.");
    } catch {
      toast("Copy did not work here. Select the reply and copy it yourself.");
    }
    window.open(card.body.threadUrl, "_blank", "noopener,noreferrer");
  }

  const editAction = (label = "Edit"): Action => ({
    label: editing ? "Stop editing" : label,
    variant: "secondary",
    run: () => {
      if (!editing) setDraft(card.kind === "post" ? shown : card.body.kind === "correction" ? card.body.rule : card.body.kind === "script" ? (beats[beat]?.words ?? "") : draft);
      setEditing((was) => !was);
    },
  });
  const declineAction: Action[] = decline ? [{ label: decline.label, variant: "quiet", run: () => setDeclining(true), declines: true }] : [];
  const declineBlocked = decline ? blockedReason(card, sample, decline.action) : blocked;
  const blockedFor = (action: Extract<Action, { run: () => void }>) =>
    action.declines ? declineBlocked : action.checks ? blockedReason(card, sample, action.checks) : blocked;
  const primary = (label = PRIMARY_ACTION[card.kind]): Action => ({ label, variant: "primary", run: approve });

  const actions: Action[] = (() => {
    switch (card.body.kind) {
      case "post":
        // A thread (P6 W4) is approved as written: one edited post would no longer match the thread it opens.
        if (card.body.platforms.some((p) => p.thread)) return [primary("Approve thread"), ...declineAction];
        return [primary(editing ? "Approve edit" : "Approve"), editAction(), ...declineAction];
      case "reply":
        return [
          { label: PRIMARY_ACTION.reply, variant: "primary", run: copyReply },
          { label: "I replied", variant: "secondary", run: () => run({ action: "replied" }) },
          ...declineAction,
        ];
      case "goal":
        return [primary(), { label: "Edit plan", variant: "secondary", href: "/app/brain" }, ...declineAction];
      case "script":
        return [primary(editing ? "Approve edit" : PRIMARY_ACTION.script), editAction("Edit a beat"), ...declineAction];
      case "price":
        // Redo exists only for a contact sheet: a price for shots alone has no keyframe to make again.
        return [primary(), ...(card.body.keyframes.length > 0 ? [{ label: "Redo a keyframe", variant: "secondary" as const, run: () => setRedoing(true) }] : []), ...declineAction];
      case "finished_video":
        return [primary(), { label: "Open in editor", variant: "secondary", href: `/app/editor/${encodeURIComponent(card.body.clipId)}` }, ...declineAction];
      case "shorts_batch":
        return [primary(), ...declineAction];
      case "slideshow":
        // Approving words the renders do not show yet would approve a video nobody saw: wait for the new card.
        if (slideStale && !slideEdited) return [{ label: "Render again", variant: "primary", run: () => void rerender() }, { label: "Open in Slides", variant: "secondary", href: slidesHref(card.body.clipId) }, ...declineAction];
        return [{ ...primary(), disabled: slideEdited ? "The slideshow renders again with your words; approve the new card." : undefined }, { label: "Open in Slides", variant: "secondary", href: slidesHref(card.body.clipId) }, ...declineAction];
      case "schedule": {
        const body = card.body;
        const changeTime: Action = {
          label: "Change time",
          variant: "secondary",
          checks: "change_time",
          run: () => {
            setNewTime(toLocalInput(body.at, body.timezone));
            setMoving(true);
          },
        };
        if (body.state === "no_account") {
          const target = isPublishPlatform(body.where.platform) ? intentFor(body.where.platform, body.preview.text ?? "") : null;
          return [
            ...(target ? [{ label: target.copy ? target.label : `Copy and ${target.label.toLowerCase()}`, variant: "primary" as const, run: () => void copyAndOpen(body) }] : []),
            { label: "I posted it", variant: target ? ("secondary" as const) : ("primary" as const), checks: "posted", run: () => void run({ action: "posted" }) },
            ...declineAction,
          ];
        }
        // Zernio took it and never confirmed it: it may be live, so the founder checks. No Retry: it could post twice.
        if (body.state === "unconfirmed")
          return [{ label: "It went out", variant: "primary", checks: "posted", run: () => void run({ action: "posted" }) }, changeTime, ...declineAction];
        // A failed post keeps its card open with the reason while its window lasts (A1); Retry posts it now.
        if (card.problem?.kind === "failed" || body.state === "failed") return [{ label: "Retry", variant: "primary", checks: "retry", run: () => void run({ action: "retry" }) }, changeTime, ...declineAction];
        if (!sameOptions(options, body.options))
          return [
            { label: "Save changes", variant: "primary", run: () => void run({ action: "set_options", options: savedOptions(body, options) }) },
            { label: "Undo changes", variant: "secondary", run: () => setOptions(body.options) },
          ];
        return [{ ...primary(), disabled: approveBlocked(body, options) ?? undefined }, changeTime, ...declineAction];
      }
      case "correction":
        return [primary(editing ? "Keep edited rule" : PRIMARY_ACTION.correction), editAction(), ...declineAction];
    }
  })();

  // The price card shows its price large in the body; `meta` already names the account and time.
  const foot = [card.priceCredits !== null && card.kind !== "price" ? `${card.priceCredits} credits` : null, card.meta || null].filter(Boolean).join(" · ");
  const decided = decidedNote(card);

  const headRow = (
    <span className="v2-card-head">
      <span>
        {numeral ? <span className="v2-card-numeral">{numeral} </span> : null}
        {head}
      </span>
      {note ? <span>{note}</span> : null}
    </span>
  );

  return (
    <article className="v2-card" data-open={open || undefined} data-status={card.status} data-testid="approval-card" data-card-id={card.id} aria-label={`${head}: ${card.title}`}>
      {onToggle ? (
        <Heading className="v2-card-heading">
          <button type="button" className="v2-card-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
            {headRow}
            <span className="v2-card-title">{card.title}</span>
          </button>
        </Heading>
      ) : (
        <Heading className="v2-card-heading is-static">
          {headRow}
          <span className="v2-visually-hidden">{card.title}</span>
        </Heading>
      )}

      {open ? (
        <div id={bodyId} className="v2-card-body">
          {card.body.kind === "post" ? (
            <PostBody body={card.body} cardId={card.id} editing={editing} draft={draft} onDraft={setDraft} onPick={setShown} />
          ) : card.body.kind === "reply" ? (
            <ReplyBody body={card.body} />
          ) : card.body.kind === "goal" ? (
            <GoalBody body={card.body} />
          ) : card.body.kind === "script" ? (
            <ScriptBody
              body={card.body}
              cardId={card.id}
              editing={editing}
              beat={beat}
              draft={draft}
              onDraft={setDraft}
              onBeat={(index) => {
                setBeat(index);
                setDraft(beats[index]?.words ?? "");
              }}
            />
          ) : card.body.kind === "price" ? (
            <PriceBody body={card.body} price={card.priceCredits} />
          ) : card.body.kind === "finished_video" ? (
            <FinishedVideoBody body={card.body} cardId={card.id} editable={captionsBlocked} onSaveCaption={saveCaption} />
          ) : card.body.kind === "shorts_batch" ? (
            <ShortsBody body={card.body} cardId={card.id} editable={captionsBlocked} onSaveCaption={saveCaption} />
          ) : card.body.kind === "slideshow" ? (
            <SlideshowBody body={card.body} cardId={card.id} editable={captionsBlocked} edited={slideEdited} onSaveSlide={saveSlide} onSaveCaption={saveCaption} />
          ) : card.body.kind === "schedule" ? (
            <ScheduleBody body={card.body} cardId={card.id} options={options} onOptions={setOptions} editable={blocked ?? (busy ? "Wait for the decision to finish." : card.body.state === "failed" || card.body.state === "no_account" || card.body.state === "unconfirmed" ? "It posts as you approved it; change the time to start again." : null)} />
          ) : (
            <CorrectionBody body={card.body} editing={editing} draft={draft} onDraft={setDraft} />
          )}

          {foot ? <div className="v2-card-meta">{foot}</div> : null}

          {"lookNote" in card.body && card.body.lookNote ? (
            <p className="v2-card-state is-expired" data-testid="look-note">
              <b>Look check</b>
              <span>{card.body.lookNote.replace(/^look check:\s*/i, "").replace(/^./, (c) => c.toUpperCase())}</span>
            </p>
          ) : null}

          {card.body.kind === "schedule" && card.body.lastError && !card.problem && card.status === "waiting" && card.body.state !== "waiting" ? (
            <p className={`v2-card-state ${card.body.state === "failed" || card.body.state === "unconfirmed" ? "is-failed" : "is-expired"}`}>
              <b>{STATE_LABEL[card.body.state]}</b>
              <span>
                {card.body.lastError}
                {card.body.state === "missed" ? " This is a new time: approve it, change it or cancel." : ""}
              </span>
            </p>
          ) : null}
          {card.body.kind === "schedule" && card.body.publishedUrl ? (
            <p className="v2-card-state is-decided_elsewhere">
              <b>Published</b>
              <a href={card.body.publishedUrl} target="_blank" rel="noopener noreferrer">
                Open the post
              </a>
            </p>
          ) : null}

          {card.problem ? (
            <p className={`v2-card-state is-${card.problem.kind}`}>
              <b>{PROBLEM_LABEL[card.problem.kind]}</b>
              <span>{card.problem.text}</span>
              {card.problem.kind === "needs_credits" ? <Link href="/app/billing">Top up</Link> : null}
            </p>
          ) : decided ? (
            <p className="v2-card-state is-decided_elsewhere">
              <b>Decided</b>
              <span>{decided}</span>
            </p>
          ) : null}

          {moving && card.body.kind === "schedule" ? (
            <form
              className="v2-card-decline"
              onSubmit={(event) => {
                event.preventDefault();
                if (card.body.kind !== "schedule") return;
                const at = fromLocalInput(newTime, card.body.timezone);
                if (at) void run({ action: "change_time", publishAt: at });
              }}
            >
              <label className="v2-field" htmlFor={`${card.id}-time`}>
                <span>New time, your time ({card.body.timezone}). A new card asks you to approve it.</span>
                <input id={`${card.id}-time`} className="v2-input is-compact" type="datetime-local" required value={newTime} autoFocus onChange={(event) => setNewTime(event.target.value)} />
              </label>
              <div className="v2-actions">
                <Button type="submit" variant="primary" compact disabled={busy || !fromLocalInput(newTime, card.body.timezone)}>
                  Save new time
                </Button>
                <Button variant="quiet" compact onClick={() => setMoving(false)}>
                  Keep this time
                </Button>
              </div>
            </form>
          ) : redoing && card.body.kind === "price" ? (
            <form
              className="v2-card-decline"
              onSubmit={(event) => {
                event.preventDefault();
                void run({ action: "redo", index: keyframe });
              }}
            >
              <fieldset className="v2-field">
                <legend>Which keyframe should be made again? Only that one is redone; its price comes on a new card.</legend>
                <div className="v2-card-keyframes">
                  {card.body.keyframes.map((frame) => (
                    <label key={frame.index} className="v2-card-keyframe" title={frame.label}>
                      <input type="radio" name={`${card.id}-keyframe`} value={frame.index} checked={keyframe === frame.index} onChange={() => setKeyframe(frame.index)} />
                      <span>
                        <span className="v2-visually-hidden">Keyframe </span>
                        {String(frame.index + 1).padStart(2, "0")}
                        {frame.garbled ? <span className="v2-visually-hidden"> (text may be garbled)</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="v2-actions">
                <Button type="submit" variant="primary" compact disabled={busy}>
                  Redo keyframe {keyframe + 1}
                </Button>
                <Button variant="quiet" compact onClick={() => setRedoing(false)}>
                  Keep it
                </Button>
              </div>
            </form>
          ) : declining && decline ? (
            <form
              className="v2-card-decline"
              onSubmit={(event) => {
                event.preventDefault();
                void run({ action: decline.action, reason: reason.trim() || undefined });
              }}
            >
              <label className="v2-field">
                <span>Why? Your CMO learns from it (optional)</span>
                <input className="v2-input" value={reason} maxLength={400} autoFocus onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="v2-actions">
                <Button type="submit" variant="primary" compact disabled={busy}>
                  {decline.label}
                </Button>
                <Button variant="quiet" compact onClick={() => setDeclining(false)}>
                  Keep it
                </Button>
              </div>
            </form>
          ) : card.status !== "waiting" || card.problem?.kind === "decided_elsewhere" ? null : (
            <div className="v2-actions">
              {actions.map((action) =>
                "href" in action ? (
                  <ButtonLink key={action.label} variant={action.variant} compact href={action.href}>
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    key={action.label}
                    variant={action.variant}
                    compact
                    disabled={busy || !!action.disabled || (!!blockedFor(action) && action.label !== "Stop editing")}
                    title={action.disabled ?? blockedFor(action) ?? undefined}
                    onClick={action.run}
                  >
                    {action.label}
                  </Button>
                ),
              )}
            </div>
          )}
          {blocked && card.status === "waiting" && !card.problem ? <p className="v2-card-meta">{blocked}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
