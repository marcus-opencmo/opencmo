/**
 * S7 Research (`Research.dc.html`).
 */

import { z } from "zod";

import { PlatformSchema, iso } from "./common";

export const InsightSchema = z.object({
  id: z.string(),
  type: z.enum(["hook", "format", "idea"]),
  /** Filter tab it belongs to. */
  scope: z.enum(["competitors", "niche_video"]),
  /** "X", "Shorts", "LinkedIn". */
  platform: z.string().max(40),
  text: z.string().max(300),
  evidence: z.string().max(200),
  /** "used in Thursday's post", "fed the video brief"; null = not used yet. */
  usedIn: z.string().max(120).nullable(),
  /** Every insight points to the post it came from; one without a link is dropped, never shown. */
  sources: z.array(z.url()).min(1),
  /** Niche video insights (P5 R2): the short's numbers as read; never the video itself. */
  video: z
    .object({
      views: z.number().int().min(0).nullable(),
      /** Views over the median of the same search: why it counts as an outlier. */
      outlier: z.number().min(0).nullable(),
      seconds: z.number().positive().nullable(),
      format: z.string().max(60).nullable(),
    })
    .optional(),
});

export const ResearchScreenSchema = z.object({
  lastRunAt: iso.nullable(),
  nextRunAt: iso.nullable(),
  insights: z.array(InsightSchema),
  /** Insights dropped this week for having no source link. */
  dropped: z.number().int().min(0),
  /** "Your results · 24 h after posting". */
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string().max(200),
      platform: PlatformSchema,
      views: z.number().int().min(0).nullable(),
      replies: z.number().int().min(0).nullable(),
    }),
  ),
});
export type ResearchScreen = z.infer<typeof ResearchScreenSchema>;
