/**
 * Shared pieces of the v2 screen contracts (docs/plans/cmo/2026-10-27-ui-build-plan.md, Task U0).
 *
 * Pure module: client components import the schemas and types; loaders on the server fill them.
 * Times are ISO strings with an offset; the UI formats them in the founder's time zone.
 */

import { z } from "zod";

export const iso = z.iso.datetime({ offset: true });
/** A calendar day, `YYYY-MM-DD`. */
export const day = z.iso.date();

export const DEPARTMENTS = ["brain", "research", "writer", "studio", "sales", "schedule", "publish"] as const;
export const DepartmentSchema = z.enum(DEPARTMENTS);
export type Department = z.infer<typeof DepartmentSchema>;

export const DEPARTMENT_LABEL: Record<Department, string> = {
  brain: "Brain",
  research: "Research",
  writer: "Writer",
  studio: "Studio",
  sales: "Sales",
  schedule: "Schedule",
  publish: "Publish",
};

/** The six departments the team graph draws around the Brain, in the frame's order (I to VI). */
export const TEAM: Exclude<Department, "brain">[] = ["research", "writer", "studio", "sales", "schedule", "publish"];

export const PLATFORMS = ["x", "threads", "linkedin", "tiktok", "youtube", "instagram", "reddit"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

export const PLATFORM_LABEL: Record<Platform, string> = {
  x: "X",
  threads: "Threads",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram",
  reddit: "Reddit",
};

/** Where a post goes: a platform and the founder's account on it. */
export const WhereSchema = z.object({ platform: PlatformSchema, handle: z.string().max(80) });
export type Where = z.infer<typeof WhereSchema>;

/**
 * A connected (or connectable) account. `reconnect` = it stopped sending data or rejects posts;
 * `noDataSince` says from when, so a gap is shown as missing, never as zero.
 */
export const AccountSchema = WhereSchema.extend({
  id: z.string(),
  /** The platform's avatar, as Zernio reports it on connect (P4 F1); absent before an account is connected. */
  avatarUrl: z.url().nullable().optional(),
  status: z.enum(["connected", "reconnect", "not_connected"]),
  syncedAt: iso.nullable(),
  noDataSince: iso.nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const CreditsSchema = z.object({ used: z.number().int().min(0), budget: z.number().int().min(0) });
export type Credits = z.infer<typeof CreditsSchema>;

/** What the founder's CMO is doing overall: the Pause CMO button and the header line read it. */
export const CmoStateSchema = z.object({
  /** Who does the thinking: our models, or the founder's own Claude through MCP. */
  mode: z.enum(["opencmo", "claude"]),
  pausedAt: iso.nullable(),
});
export type CmoState = z.infer<typeof CmoStateSchema>;

/** One row of the live log: who did what, when. `you` is the founder's own action. */
export const LogLineSchema = z.object({
  id: z.string(),
  at: iso,
  who: z.union([DepartmentSchema, z.literal("you")]),
  text: z.string().max(200),
});
export type LogLine = z.infer<typeof LogLineSchema>;

/** A post or slot on the calendar: Going out today, Schedule, Writer columns. */
export const SLOT_STATUSES = ["proposed", "waiting_founder", "scheduled", "posted", "failed"] as const;
export const SlotStatusSchema = z.enum(SLOT_STATUSES);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

/** A score part of a Reddit thread, with the quote that earned it. */
export const ScorePartSchema = z.object({
  label: z.enum(["Pain", "Fit", "Timing", "Reach", "Evidence"]),
  score: z.number().min(0),
  max: z.number().positive(),
});
export type ScorePart = z.infer<typeof ScorePartSchema>;

export const QuoteSchema = z.object({ text: z.string().max(400), from: z.string().max(80) });
export type Quote = z.infer<typeof QuoteSchema>;

/**
 * The rule a Sales thread was drafted under (P5 R1; SQL `opportunities.rule`: `mention_ok` → `mention_allowed`,
 * `skip` → `skipped`). `text` says why: "r/SaaS forbids self-promotion", "you named the product in 1 of the last 10
 * replies". A `skipped` thread gets no draft and no card.
 */
export const SalesRuleSchema = z.object({ kind: z.enum(["mention_allowed", "help_only", "skipped"]), text: z.string().max(200) });
export type SalesRule = z.infer<typeof SalesRuleSchema>;
