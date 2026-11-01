/**
 * S5 Brain (`Brain.dc.html`): tabs This week / Memory / Past weeks; the order tree with credits and states;
 * what the brain learned, each note with its source.
 */

import { z } from "zod";

import { CmoStateSchema, CreditsSchema, DepartmentSchema, day, iso } from "./common";
import { TeamStepSchema } from "./studio";

/** Same values as `work_orders.status` (brain plan W1-3). */
export const ORDER_STATES = ["queued", "running", "waiting_founder", "waiting_order", "deferred", "done", "failed", "cancelled"] as const;
export const OrderStateSchema = z.enum(ORDER_STATES);
export type OrderState = z.infer<typeof OrderStateSchema>;

export const OrderRowSchema = z.object({
  id: z.string(),
  /** Null for a top-level order of the week (the week root itself is not a row). */
  parentId: z.string().nullable(),
  title: z.string().max(200),
  department: DepartmentSchema,
  dueAt: iso.nullable(),
  /** "Mon–Sat" style range when the order spans days; null when `dueAt` says it. */
  dueText: z.string().max(40).nullable(),
  credits: CreditsSchema,
  state: OrderStateSchema,
  /** The state cell: "1 waits on you", "Stuck: budget", "Waits on video". */
  stateText: z.string().max(80),
  /** A card to open from the row ("Open"). */
  approvalId: z.string().nullable(),
  /** A video order's team steps (P2), the same lines as Studio's Video team panel; absent for other orders. */
  steps: z.array(TeamStepSchema).optional(),
});
export type OrderRow = z.infer<typeof OrderRowSchema>;

/** A note the brain learned. `kind` picks the label; `source` says where it came from. */
export const LearnedSchema = z.object({
  id: z.string(),
  kind: z.enum(["lesson", "rule", "skip_reason", "goal_result", "memory"]),
  /** The label after the kind: "X", "you approved", "Sales", "last week". */
  scope: z.string().max(40),
  text: z.string().max(300),
  source: z.string().max(200),
  at: iso,
  /** The founder may delete it (corrections and memories; lessons are rewritten each Sunday). */
  deletable: z.boolean(),
});
export type Learned = z.infer<typeof LearnedSchema>;

/** A rule from edits waiting for the founder, or active, or rejected (`cmo_corrections`). */
export const CorrectionRowSchema = z.object({
  id: z.string(),
  rule: z.string().max(200),
  status: z.enum(["proposed", "active", "rejected"]),
  at: iso,
  approvalId: z.string().nullable(),
});

export const PastWeekSchema = z.object({
  week: day,
  goal: z.string().max(200).nullable(),
  /** "Missed: 3 of 5 posts went out (Threads disconnected)." */
  result: z.string().max(300),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  credits: CreditsSchema,
});

/** The brain's measures (`brain.md` §10; P6 A4). Each starts with no number until there is data for it. */
export const MEASURE_KEYS = ["plan_accepted", "drafts_as_is", "orders_on_time", "credits_per_approved", "replans"] as const;

export const MeasureSchema = z.object({
  key: z.enum(MEASURE_KEYS),
  /** This week; null = no data yet (drawn as a dash, never zero). `percent` is 0 to 100. */
  value: z.number().min(0).nullable(),
  unit: z.enum(["percent", "credits", "count"]),
  /** Against last week, in the same unit (points for a percent); null when either week has no data. */
  change: z.number().nullable(),
  /** The starting target from `brain.md` §10: "Half of plans", "Falling week over week". */
  target: z.string().max(60),
  /** What the number counts: "4 of 7 plans", "12 approved, 44 credits". */
  note: z.string().max(80).nullable(),
});
export type Measure = z.infer<typeof MeasureSchema>;

export const BrainScreenSchema = z.object({
  cmo: CmoStateSchema,
  week: z.object({
    goal: z.string().max(200).nullable(),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    credits: CreditsSchema,
    /** When the daily progress check runs next. */
    nextCheckAt: iso.nullable(),
  }),
  /** Parents before their children. */
  orders: z.array(OrderRowSchema),
  learned: z.array(LearnedSchema),
  corrections: z.array(CorrectionRowSchema),
  pastWeeks: z.array(PastWeekSchema),
  /** One per `MEASURE_KEYS`, in that order. */
  measures: z.array(MeasureSchema).length(MEASURE_KEYS.length),
});
export type BrainScreen = z.infer<typeof BrainScreenSchema>;
