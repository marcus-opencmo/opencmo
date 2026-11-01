/**
 * The rail's status lines under Schedule and Analytics (P6 F14). Session A's loader fills it, the shell (Session C)
 * puts it in `ShellState`; a null field means no line, never a made-up number.
 */

import { z } from "zod";

import { iso } from "./common";

export const RailStatusSchema = z.object({
  /** The next slot waiting to go out ("Next post 9:00"); null when nothing is scheduled. */
  nextPostAt: iso.nullable(),
  /** Connected accounts Analytics reads; null when none is connected (the line then says nothing). */
  connectedAccounts: z.number().int().min(1).nullable(),
  /** The founder's timezone, so the time is shown as Schedule shows it. */
  timezone: z.string().max(64),
});
export type RailStatus = z.infer<typeof RailStatusSchema>;

/** "Next post 9:00" today, "Next post Mon 9:00" later, in the founder's timezone as Schedule shows it. */
export function nextPostText(at: string, timezone: string, now = new Date()): string {
  const zone = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", hourCycle: "h23" }).formatToParts(d);
    } catch {
      return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", hour: "numeric", minute: "2-digit", day: "numeric", hourCycle: "h23" }).formatToParts(d);
    }
  };
  const part = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const then = zone(new Date(at));
  const today = zone(now);
  const time = `${part(then, "hour")}:${part(then, "minute")}`;
  const sameDay = part(then, "day") === part(today, "day") && Math.abs(Date.parse(at) - now.getTime()) < 86_400_000;
  return `Next post ${sameDay ? time : `${part(then, "weekday")} ${time}`}`;
}
