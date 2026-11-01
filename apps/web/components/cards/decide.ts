/**
 * Decisions on approval cards, through `POST /api/v1/approvals/[id]` (`approval_decide`). The card's
 * `contentHash` goes back with every decision, so a screen that shows an older version is refused instead of
 * approving text the founder never saw. Fixture cards (outside production only) never reach the network.
 */

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import { CAPTION_ACTION, DECIDABLE_IN_WAVE_1, type ApprovalCard, type Caption, type ScheduleOptions } from "@/lib/screens/approval-card";
import { PLATFORM_LABEL } from "@/lib/screens/common";

import { formatWhen } from "./schedule";

/** The actions `approval_decide` accepts, per kind (contract doc S3). */
export type Decision =
  | { action: "approve"; text?: string }
  /** `beat` (script cards): the beat whose words `text` replaces; absent, `text` is the whole draft. */
  | { action: "edit"; text: string; beat?: number }
  | { action: "skip"; reason?: string }
  | { action: "replied" }
  | { action: "dismissed"; reason?: string }
  | { action: "reject"; reason?: string }
  /** Price card (card 2): make keyframe `index` (0-based) again; a new card replaces this one. */
  | { action: "redo"; index: number }
  /** Script and price cards: stop the video here; nothing more is spent (keyframes already made stay paid for). */
  | { action: "cancel"; reason?: string }
  /** Finished video and shorts batch: not yet, with what to change. */
  | { action: "send_back"; reason?: string }
  /** Schedule (P4): a new time in UTC `YYYY-MM-DDTHH:MM:SSZ`; the slot moves and a new card asks again. */
  | { action: "change_time"; publishAt: string }
  /** Schedule: the platform's fields changed; a new card asks again. */
  | { action: "set_options"; options: ScheduleOptions }
  /** Schedule: a failed post goes again on the same approval while its time is still in the window. */
  | { action: "retry" }
  /** Schedule, no account connected: the founder copied it and posted it themselves (`schedule_mark_posted`). */
  | { action: "posted" };

/** Declining spends nothing, so a card that waits on credits can still be cancelled or set aside. */
const DECLINES: ReadonlySet<Decision["action"]> = new Set(["skip", "dismissed", "reject", "cancel", "send_back"]);

/** What a schedule card whose post failed still offers: try again, move it, or drop it. */
const AFTER_FAILURE: ReadonlySet<Decision["action"]> = new Set(["retry", "change_time", "cancel", "posted"]);

/** Why the card cannot be decided here (with `action`, that decision), or null when it can. */
export function blockedReason(card: ApprovalCard, sample: boolean, action?: Decision["action"]): string | null {
  const allowed =
    (card.problem?.kind === "needs_credits" && action && DECLINES.has(action)) || (card.problem?.kind === "failed" && card.kind === "schedule" && action && AFTER_FAILURE.has(action));
  if (card.problem && !allowed) return card.problem.text;
  if (card.status !== "waiting") return "This card was already decided.";
  if (sample) return null;
  if (!DECIDABLE_IN_WAVE_1.has(card.kind)) return "Decisions on this card open with its department's release.";
  return null;
}

/** Sends the decision; returns the card as the server has it now. Sample cards resolve locally. */
export async function decide(card: ApprovalCard, decision: Decision, sample: boolean): Promise<ApprovalCard | null> {
  if (sample) return null;
  const reason = blockedReason(card, sample, decision.action);
  if (reason) throw new ApiError(reason, 0, null);
  // Not a decision on the card: the slot route marks the copied post as posted and closes the card itself.
  if (decision.action === "posted" && card.body.kind === "schedule") {
    return api<ApprovalCard>(`/schedule/slots/${encodeURIComponent(card.body.slotId)}`, jsonBody({ action: "posted" }));
  }
  const { action, ...rest } = decision;
  return api<ApprovalCard>(`/approvals/${encodeURIComponent(card.id)}`, jsonBody({ action, contentHash: card.contentHash, ...rest }));
}

/** The card with one caption's words replaced, as the server answers it but with the old hash (sample cards only). */
function withCaption(card: ApprovalCard, caption: Caption): ApprovalCard {
  const swap = (list: Caption[]) => list.map((c) => (c.id === caption.id ? caption : c));
  if (card.body.kind === "finished_video") return { ...card, body: { ...card.body, captions: swap(card.body.captions) } };
  if (card.body.kind === "shorts_batch") return { ...card, body: { ...card.body, shorts: card.body.shorts.map((s) => ({ ...s, captions: swap(s.captions) })) } };
  if (card.body.kind === "slideshow") return { ...card, body: { ...card.body, captions: swap(card.body.captions ?? []) } };
  return card;
}

/**
 * Changes one caption on a finished video or shorts card before it is approved. Not a decision: the card stays
 * waiting, with a new `contentHash` the next decision must send. Sample cards change on this screen only.
 */
export async function editCaption(card: ApprovalCard, caption: Caption, sample: boolean): Promise<ApprovalCard> {
  if (sample) return withCaption(card, caption);
  const reason = blockedReason(card, sample);
  if (reason) throw new ApiError(reason, 0, null);
  const next = await api<ApprovalCard>(
    `/approvals/${encodeURIComponent(card.id)}`,
    jsonBody({ action: CAPTION_ACTION, contentHash: card.contentHash, caption: caption.id, text: caption.text, ...(caption.title !== null ? { title: caption.title } : {}) }),
  );
  // The answer is not signed: keep this card's previews and take the new hash and the captions as saved.
  const saved = (
    next.body.kind === "finished_video" || next.body.kind === "slideshow"
      ? (next.body.captions ?? [])
      : next.body.kind === "shorts_batch"
        ? next.body.shorts.flatMap((s) => s.captions)
        : []
  ).find(
    (c) => c.id === caption.id,
  );
  return { ...withCaption(card, saved ?? caption), contentHash: next.contentHash };
}

/** What the toast says after a decision went through. */
export function decidedMessage(card: ApprovalCard, decision: Decision, sample: boolean): string {
  const suffix = sample ? " (sample, nothing was sent)" : "";
  switch (decision.action) {
    case "replied":
      return `Marked as replied${suffix}.`;
    case "dismissed":
      return `Dismissed${suffix}.`;
    case "skip":
      return `Skipped${suffix}.`;
    case "reject":
      return card.kind === "correction" ? `Dismissed. Drafts stay as they are${suffix}.` : `Rejected${suffix}.`;
    case "redo":
      return `Making keyframe ${decision.index + 1} again. A new card comes when it is ready${suffix}.`;
    case "change_time":
      return `New time saved. A new card asks you to approve it${suffix}.`;
    case "set_options":
      return `Changes saved. A new card asks you to approve them${suffix}.`;
    case "posted":
      return card.body.kind === "schedule" && card.body.state === "unconfirmed"
        ? `Marked as live. It will not be posted again${suffix}.`
        : `Marked as posted. Nothing else goes out for it${suffix}.`;
    case "retry":
      return `Trying again. If its time has passed, a card with a new time comes instead${suffix}.`;
    case "cancel":
      if (card.kind === "schedule") return `Cancelled. Nothing will be posted${suffix}.`;
      // Card 2 comes after the keyframes were made and paid for: only card 1 is cancelled before any spend.
      return card.kind === "price" ? `Cancelled. Nothing more will be spent${suffix}.` : `Cancelled. No credits were spent${suffix}.`;
    case "send_back":
      return card.kind === "finished_video" ? `Sent back. The edit stays open in the editor${suffix}.` : `Sent back with your note${suffix}.`;
    case "edit":
      if (card.kind === "correction") return `Kept your version of the rule. Every draft follows it${suffix}.`;
      if (card.kind === "script") return `Beat changed. The script is planned again and comes back as a new card${suffix}.`;
      return `Approved${suffix}.`;
    default:
      // Since P4 an approved post gets its time on a schedule card; it is never opened or posted from here.
      if (card.kind === "post") return `Approved. A schedule card asks you for its time${suffix}.`;
      if (card.kind === "script") return `Script approved. The keyframes are being made${suffix}.`;
      if (card.kind === "price") return `Price approved. The video is being made${suffix}.`;
      if (card.kind === "finished_video") return `Marked finished. Shorts can be cut from it${suffix}.`;
      if (card.kind === "correction") return `Kept as a rule. Every draft follows it${suffix}.`;
      if (card.body.kind === "schedule") {
        const when = formatWhen(card.body.at, card.body.timezone);
        return card.body.mode === "publish"
          ? `Approved. It posts on ${PLATFORM_LABEL[card.body.where.platform]} on ${when}, your time${suffix}.`
          : `Approved. On ${when} a card gives you the post to copy and open${suffix}.`;
      }
      if (card.body.kind === "shorts_batch") return `Approved ${card.body.shorts.length} shorts. They are ready to schedule${suffix}.`;
      if (card.body.kind === "slideshow") return `Approved the slideshow. It is ready to schedule${suffix}.`;
      return `Approved${suffix}.`;
  }
}
