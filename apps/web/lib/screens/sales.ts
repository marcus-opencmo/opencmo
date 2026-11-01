/**
 * S10 Sales (`Sales.dc.html`).
 */

import { z } from "zod";

import { QuoteSchema, SalesRuleSchema, ScorePartSchema, iso } from "./common";

export const ThreadSchema = z.object({
  id: z.string(),
  score: z.number().int().min(0).max(100),
  community: z.string().max(80),
  postedAt: iso.nullable(),
  comments: z.number().int().min(0).nullable(),
  title: z.string().max(300),
  url: z.url(),
  /** The subreddit's rule for this thread. `skipped` threads get no draft. */
  rule: SalesRuleSchema,
  parts: z.array(ScorePartSchema),
  quotes: z.array(QuoteSchema),
  draft: z.string().max(10000).nullable(),
  /** "No links · product named once, at the end · r/SaaS allows it". */
  draftChecks: z.string().max(200).nullable(),
  status: z.enum(["open", "replied", "dismissed"]),
  approvalId: z.string().nullable(),
});

export const SalesScreenSchema = z.object({
  /** Product mentions in the last ten replies: at most one in ten may name the product. */
  mentions: z.object({ used: z.number().int().min(0), window: z.number().int().positive() }),
  /** Set when the scan stopped (budget used); the banner offers to finish with more credits. */
  stuck: z.object({ text: z.string().max(200), creditsToFinish: z.number().int().positive(), found: z.number().int().min(0) }).nullable(),
  threads: z.array(ThreadSchema),
  /** The founder's Sales settings (`sales_settings`): subreddits never scanned; pairs of terms that must both appear. */
  settings: z.object({
    excludedSubreddits: z.array(z.string().max(21)).max(50),
    pairs: z.array(z.tuple([z.string().max(60), z.string().max(60)])).max(20),
  }),
  week: z.object({ replied: z.number().int().min(0), dismissed: z.number().int().min(0) }),
});
export type SalesScreen = z.infer<typeof SalesScreenSchema>;
