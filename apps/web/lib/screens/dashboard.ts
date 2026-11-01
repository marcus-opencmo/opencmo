/**
 * S2 Dashboard (`Main.dc.html`, `DashboardPhone.dc.html`): week strip, team graph, live log, results,
 * going out today, and the only approval queue.
 */

import { z } from "zod";

import { ApprovalCardSchema } from "./approval-card";
import { CmoStateSchema, CreditsSchema, DepartmentSchema, LogLineSchema, SlotStatusSchema, WhereSchema, iso } from "./common";

export const WeekStripSchema = z.object({
  /** The approved goal of this week; null before the founder approves one. */
  goal: z.string().max(200).nullable(),
  deliverables: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }),
  /** Departments with a running order, out of the six on the graph. */
  workingNow: z.number().int().min(0).max(6),
  wordsDraftedToday: z.number().int().min(0),
  credits: CreditsSchema,
});

/** A node of the team graph. `line` is what it does now ("Rendering shot 9 of 12 · 62%"). */
export const TeamNodeSchema = z.object({
  department: DepartmentSchema.exclude(["brain"]),
  state: z.enum(["working", "idle", "stuck"]),
  line: z.string().max(120),
  /** Cards of this department waiting on the founder; the node's chip. */
  waiting: z.number().int().min(0),
});

export const TeamSchema = z.object({
  brain: z.object({
    state: z.enum(["on_track", "stuck", "paused"]),
    /** Open orders the daily check watches. */
    watching: z.number().int().min(0),
    nextCheckAt: iso.nullable(),
  }),
  /** Always the six departments in graph order. */
  nodes: z.array(TeamNodeSchema).length(6),
});

/** A row of "Results · last 7 days". A null number means "not reported", never zero. */
export const ResultRowSchema = z.object({
  where: WhereSchema,
  impressions: z.number().int().min(0).nullable(),
  /** Seven days, oldest first; null = the platform sent nothing that day. */
  series: z.array(z.number().int().min(0).nullable()).length(7),
  followers: z.number().int().nullable(),
  best: z.string().max(120).nullable(),
  /** Set when the account stopped sending data: the row shows "reconnect" instead of numbers. */
  noDataSince: iso.nullable(),
});

export const OutTodaySchema = z.object({
  id: z.string(),
  at: iso,
  where: WhereSchema,
  text: z.string().max(300),
  status: SlotStatusSchema,
  /** Why it failed ("reconnect account"), shown with a Fix link. */
  problem: z.string().max(120).nullable(),
  /** The card to open when the time waits on the founder. */
  approvalId: z.string().nullable(),
});

/** The morning digest, shown at the top of the queue (the same content the email carries; `lib/cmo/digest.ts`). */
export const DigestSchema = z.object({
  dateLabel: z.string().max(40),
  waiting: z.array(z.object({ id: z.string(), title: z.string().max(200), department: DepartmentSchema })),
  wentOut: z.array(z.object({ title: z.string().max(200), where: z.string().max(40) })),
  stuck: z.array(z.object({ title: z.string().max(200), department: DepartmentSchema, reason: z.string().max(300) })),
});

export const DashboardScreenSchema = z.object({
  cmo: CmoStateSchema,
  week: WeekStripSchema,
  team: TeamSchema,
  /** Newest first; the Dashboard shows five. */
  log: z.array(LogLineSchema).max(50),
  results: z.object({
    rows: z.array(ResultRowSchema),
    /** "Brain used this": how many lessons, and the line that sums them up. */
    brainUsed: z.object({ lessons: z.number().int().min(0), text: z.string().max(300) }).nullable(),
  }),
  outToday: z.array(OutTodaySchema),
  digest: DigestSchema.nullable(),
  /** Cards with status `waiting`, oldest first. Its length is the headline, the rail badge and the chips. */
  queue: z.array(ApprovalCardSchema),
});
export type DashboardScreen = z.infer<typeof DashboardScreenSchema>;
