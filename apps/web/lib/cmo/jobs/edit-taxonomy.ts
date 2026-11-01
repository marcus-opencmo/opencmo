/**
 * How a founder changed a draft before approving it, and where a draft came from.
 *
 * One list for production (`classify_edits` labels `cmo_draft_outcomes`) and for the evals' judge,
 * so the two can be read side by side. The SQL check constraint on `cmo_draft_outcomes.edit_mode`
 * lists the same values; `jobs.check.ts` keeps them equal.
 */

import { createHash } from "node:crypto";

import type { Brain } from "./types";

export const EDIT_MODES = [
  "NO_MEANINGFUL_EDIT",
  "TOO_SALESY",
  "WRONG_VOICE",
  "INVENTED_CLAIM",
  "TOO_LONG",
  "HOOK_REWRITTEN",
  "CTA_REMOVED",
  "FULL_REWRITE",
] as const;
export type EditMode = (typeof EDIT_MODES)[number];

/** Also the classifier's prompt text: each line says when the label applies. */
export const EDIT_MODE_TEXT: Record<EditMode, string> = {
  NO_MEANINGFUL_EDIT: "Typos, punctuation or a word or two; the post says the same thing.",
  TOO_SALESY: "The founder toned down selling: removed hype, pitches or product mentions.",
  WRONG_VOICE: "Same points, rewritten to sound like the founder (tone, register, phrasing).",
  INVENTED_CLAIM: "The founder removed or corrected a claim, number or story that was not true.",
  TOO_LONG: "The founder mostly cut words; what is left is the draft's own text.",
  HOOK_REWRITTEN: "The first line was replaced; the rest stays close to the draft.",
  CTA_REMOVED: "The closing ask or link-style call to action was removed.",
  FULL_REWRITE: "Little of the draft survives; the founder wrote their own post.",
};

/** Which model and which prompt wrote a draft, kept with it so every outcome traces back. */
export type DraftGen = { model: string; prompt_version: string };

/** First 12 hex characters of the prompt's sha256: changes whenever the prompt text does. */
export function promptVersion(system: string): string {
  return createHash("sha256").update(system).digest("hex").slice(0, 12);
}

/** The model to record for a call: what answered, else who was asked to think. */
export function genModel(answered: string | null, brain: Brain, fake: boolean): string {
  if (brain === "claude") return "founder-claude";
  if (fake) return "fake";
  return answered ?? "unknown";
}
