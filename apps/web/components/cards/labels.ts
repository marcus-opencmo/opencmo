/**
 * Display helpers for the `ApprovalCard` contract (`lib/screens/approval-card.ts`): the head line, the note on
 * its right, and the log line a decision writes. Formatting only; the contract owns the data.
 */

import type { ApprovalCard } from "@/lib/screens/approval-card";
import { DEPARTMENT_LABEL, PLATFORM_LABEL, type Department } from "@/lib/screens/common";

export const NUMERAL: Record<Department, string> = { brain: "", research: "I", writer: "II", studio: "III", sales: "IV", schedule: "V", publish: "VI" };

const KIND_LABEL: Record<ApprovalCard["kind"], string> = {
  post: "Post",
  reply: "Reddit reply",
  goal: "Goal + week plan",
  script: "Script",
  price: "Price",
  finished_video: "Finished video",
  shorts_batch: "Shorts",
  slideshow: "Slideshow",
  schedule: "Time",
  correction: "Correction",
};

/** "Writer · Post · X": the head every card and queue row starts with. */
export function cardHead(card: ApprovalCard): string {
  const parts = [DEPARTMENT_LABEL[card.department], KIND_LABEL[card.kind]];
  if (card.body.kind === "post" && card.body.platforms[0]) parts.push(PLATFORM_LABEL[card.body.platforms[0].platform]);
  return parts.join(" · ");
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const dayTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "");

function untilLabel(iso: string, now: number): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return "expired";
  return minutes < 60 ? `expires in ${minutes} min` : `expires in ${Math.round(minutes / 60)} h`;
}

/** Right side of the head: "Thu 09:10", "score 78 / 100", "expires in 3 h". */
export function headNote(card: ApprovalCard, now = Date.now()): string | null {
  const body = card.body;
  switch (body.kind) {
    case "post":
      return card.postAt ? dayTime(card.postAt) : null;
    case "reply":
      return `score ${body.score} / 100`;
    case "goal":
      return `week of ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${body.week}T00:00:00Z`))}`;
    case "script":
      return `${body.beats.length} beats`;
    case "price":
      return `${body.shots} shots`;
    case "finished_video":
      return formatSeconds(body.seconds);
    case "shorts_batch":
      return `${body.shorts.length} × 9:16`;
    case "slideshow":
      return `${body.slides.length} slides · ${[body.previewUrl && "MP4", body.pngSetUrl && "PNG"].filter(Boolean).join(" + ") || "rendering"}`;
    case "schedule":
      return card.expiresAt ? untilLabel(card.expiresAt, now) : null;
    case "correction":
      return body.times ? `from ${body.times} ${body.times === 1 ? "edit" : "edits"}` : null;
  }
}

/** The log line written when the founder approves a card. */
export function approvedLine(card: ApprovalCard): string {
  const body = card.body;
  switch (body.kind) {
    case "post":
      return `You approved the ${PLATFORM_LABEL[body.platforms[0]?.platform ?? "x"]} post`;
    case "reply":
      return `You replied in ${body.community}`;
    case "goal":
      return "You approved the week";
    case "script":
      return "You approved the script";
    case "price":
      return "You approved the video price";
    case "finished_video":
      return "You marked the video finished";
    case "shorts_batch":
      return `You approved ${body.shorts.length} shorts`;
    case "slideshow":
      return "You approved the slideshow";
    case "schedule":
      return "You approved the time";
    case "correction":
      return "You kept a new rule";
  }
}
