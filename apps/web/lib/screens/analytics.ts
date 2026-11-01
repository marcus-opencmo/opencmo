/**
 * S4 Analytics (`Analytics.dc.html`). A null number is "not reported" (a dash), never zero; a day a platform
 * sent nothing is `null` in `daily` and drawn as missing.
 */

import { z } from "zod";

import { AccountSchema, PlatformSchema, WhereSchema, day, iso } from "./common";

export const RANGES = [7, 30, 90] as const;
export const RangeSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type Range = z.infer<typeof RangeSchema>;

export const KPI_KEYS = ["impressions", "engagements", "engagement_rate", "followers", "video_views", "posts_measured"] as const;

export const KpiSchema = z.object({
  key: z.enum(KPI_KEYS),
  value: z.number().nullable(),
  /** Against the previous range of the same length; null when there is nothing to compare. */
  change: z.number().nullable(),
  /** `percent` = +18%, `points` = −0.3 pts. */
  changeUnit: z.enum(["percent", "points"]),
  /** Small line instead of a change: "across 5 accounts", "4 without data". */
  note: z.string().max(60).nullable(),
});

export const AnalyticsScreenSchema = z.object({
  range: RangeSchema,
  accounts: z.array(AccountSchema),
  kpis: z.array(KpiSchema).length(KPI_KEYS.length),
  /** One entry per day of the range, oldest first. */
  daily: z.array(z.object({ day, values: z.partialRecord(PlatformSchema, z.number().int().min(0).nullable()) })),
  /** "What the Brain takes from this": the line, its evidence, and what it feeds. */
  brainReads: z.array(z.object({ text: z.string().max(200), evidence: z.string().max(200), feeds: z.string().max(120) })),
  byAccount: z.array(
    z.object({
      where: WhereSchema,
      followers: z.number().int().min(0).nullable(),
      change: z.number().int().nullable(),
      posts: z.number().int().min(0),
      medianImpressions: z.number().int().min(0).nullable(),
      engagementRate: z.number().min(0).nullable(),
      worksBest: z.string().max(120).nullable(),
      noDataSince: iso.nullable(),
    }),
  ),
  /** Best and worst first. */
  posts: z.array(
    z.object({
      id: z.string(),
      title: z.string().max(200),
      platform: PlatformSchema,
      impressions: z.number().int().min(0).nullable(),
      engagementRate: z.number().min(0).nullable(),
      /** Multiple of the account's median impressions. */
      vsMedian: z.number().min(0).nullable(),
      read: z.string().max(200).nullable(),
      url: z.url().nullable(),
    }),
  ),
});
export type AnalyticsScreen = z.infer<typeof AnalyticsScreenSchema>;
