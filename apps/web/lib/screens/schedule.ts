/**
 * S11 Schedule (`Schedule.dc.html`).
 */

import { z } from "zod";

import { AccountSchema, SlotStatusSchema, WhereSchema, iso } from "./common";

export const SlotSchema = z.object({
  id: z.string(),
  at: iso,
  where: WhereSchema,
  title: z.string().max(300),
  status: SlotStatusSchema,
  /** "4.1k views", "reconnect". */
  note: z.string().max(80).nullable(),
  approvalId: z.string().nullable(),
  /** The live post, once it went out (P4 C2): the calendar's Posted marker links to it. */
  url: z.url().nullable().optional(),
});

export const ScheduleScreenSchema = z.object({
  /** IANA name; every time on the page is shown in it. */
  timezone: z.string().max(64),
  from: iso,
  to: iso,
  slots: z.array(SlotSchema),
  accounts: z.array(AccountSchema),
  rules: z.array(z.string().max(200)),
});
export type ScheduleScreen = z.infer<typeof ScheduleScreenSchema>;
