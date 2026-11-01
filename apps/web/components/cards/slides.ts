/**
 * Quick text edits on a slideshow card (P5 C0). The card has no text action of its own: the words live in the edit,
 * so a change goes through the same `set_slide_text` op the Slides view runs (`POST /editor/ops`), then the slideshow
 * renders again (`POST /studio/[clip]/slideshow-render`) and a new card replaces this one. The renders of the old text
 * are never approved.
 */

import { slideSpans, type ClipDocument } from "@opencmo/clip-doc";
import { SLIDE_TEXT_MAX } from "@opencmo/editor-core";

import { ApiError, api, jsonBody } from "@/components/clipping/api";
import type { ApprovalCard } from "@/lib/screens/approval-card";

export { SLIDE_TEXT_MAX };

/** A card slide's text is `heading` then, on the next line, the body (`slideshow/build.ts` writes it so). */
export function splitSlideText(text: string): { heading: string; body: string } {
  const [heading = "", ...rest] = text.split("\n");
  return { heading: heading.trim(), body: rest.join(" ").trim() };
}

export const joinSlideText = (heading: string, body: string): string => (body.trim() ? `${heading.trim()}\n${body.trim()}` : heading.trim());

/** Why these words cannot be saved, or null when they can. */
export function slideTextProblem(heading: string, body: string): string | null {
  if (!heading.trim()) return "A slide needs a heading.";
  if (heading.trim().length > SLIDE_TEXT_MAX.heading) return `Keep the heading under ${SLIDE_TEXT_MAX.heading} characters so it fits the frame.`;
  if (body.trim().length > SLIDE_TEXT_MAX.body) return `Keep the body under ${SLIDE_TEXT_MAX.body} characters so it fits the frame.`;
  return null;
}

type Project = { document: ClipDocument; version: number };

/**
 * Saves slide `index`'s words in the edit. Sample cards change on this screen only. The slide is found by position
 * in the document as it is now: the card's slides are in play order, like `slideSpans`.
 */
export async function saveSlideText(card: ApprovalCard, index: number, heading: string, body: string, sample: boolean): Promise<ApprovalCard> {
  if (card.body.kind !== "slideshow") throw new ApiError("This card has no slides.", 0, null);
  const text = joinSlideText(heading, body);
  const slides = card.body.slides.map((slide, at) => (at === index ? { ...slide, text } : slide));
  const changed = { ...card, body: { ...card.body, slides } };
  if (sample) return changed;
  const clip = card.body.clipId;
  const project = await api<Project>(`/editor/project?clip_id=${encodeURIComponent(clip)}`);
  const spans = slideSpans(project.document);
  const id = spans[index]?.id;
  if (!id || spans.length !== card.body.slides.length) throw new ApiError("The slideshow changed since this card was made. Open it in Slides.", 409, null);
  await api(`/editor/ops`, jsonBody({ clip_id: clip, expected_version: project.version, ops: [{ op: "set_slide_text", slide_id: id, heading: heading.trim(), body: body.trim() }] }));
  await renderAgain(card, false);
  return changed;
}

/**
 * A new MP4 and PNG set of the slideshow as it is saved now (after a text edit here or in the Slides view): the old
 * card closes and a new one comes when both are done. Sample cards send nothing.
 */
export async function renderAgain(card: ApprovalCard, sample: boolean): Promise<void> {
  if (card.body.kind !== "slideshow") throw new ApiError("This card has no slides.", 0, null);
  if (sample) return;
  await api(`/studio/${encodeURIComponent(card.body.clipId)}/slideshow-render`, jsonBody({}));
}

/** The Slides view of a slideshow's edit. */
export const slidesHref = (clipId: string): string => `/app/editor/${encodeURIComponent(clipId)}?view=slides`;
