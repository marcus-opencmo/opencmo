/**
 * S9 Studio (`Studio.dc.html`).
 */

import { z } from "zod";

import { iso } from "./common";

export const STUDIO_KINDS = ["video", "short", "slideshow", "post_image", "upload"] as const;

export const StudioItemSchema = z.object({
  id: z.string(),
  kind: z.enum(STUDIO_KINDS),
  title: z.string().max(200),
  /** "AI video · 60 s · rendering 62%", "Your upload · edited yesterday". */
  subtitle: z.string().max(200),
  status: z.enum(["uploading", "processing", "running", "waiting_founder", "ready", "finished", "failed", "cancelled"]),
  /** 0–100 while uploading, processing or running. */
  progress: z.number().min(0).max(100).nullable(),
  favorite: z.boolean(),
  createdAt: iso,
  editedAt: iso.nullable(),
  /** The failure line, with "credits refunded" when they were. */
  failure: z.string().max(200).nullable(),
  /** Today's project id (`/api/v1/projects/:id`) for uploads and their edits. */
  projectId: z.string().nullable(),
  editorHref: z.string().max(200).nullable(),
  approvalId: z.string().nullable(),
  /** An own edit the founder can mark finished (Shorts are cut only from finished edits). */
  canMarkFinished: z.boolean(),
  /** P2 (C's request): the edit Mark finished and Cut shorts act on, the document hash the founder sees (sent with
   * Mark finished), and whether it is finished at that document. Optional: upload cards built on the page set them
   * from `editStates`. */
  clipId: z.string().nullable().optional(),
  documentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  canCutShorts: z.boolean().optional(),
  /** The item drawer (`?item=<id>`): edits made from this upload. */
  edits: z.array(z.object({ id: z.string(), title: z.string().max(200), editedAt: iso, editorHref: z.string().max(200) })),
});
export type StudioItem = z.infer<typeof StudioItemSchema>;

/** One line of the Video team's progress ("Keyframes · you approved the price"). Also under a video order on Brain. */
export const TeamStepSchema = z.object({ label: z.string().max(80), state: z.enum(["done", "running", "todo"]) });
export type TeamStep = z.infer<typeof TeamStepSchema>;

export const StudioScreenSchema = z.object({
  items: z.array(StudioItemSchema),
  /** "Video team · now": the long take in progress, one line per step. */
  team: z
    .object({
      title: z.string().max(200),
      steps: z.array(TeamStepSchema),
    })
    .nullable(),
  /**
   * Every recent edit's state for Mark finished and Cut shorts (P2): the uploads' edits come from `/api/v1/projects`
   * on the page, so their finished state comes from here, by clip id.
   */
  editStates: z.array(
    z.object({ clipId: z.string(), documentHash: z.string().regex(/^[0-9a-f]{64}$/), finishedAt: iso.nullable(), kind: z.enum(["full", "blank", "short", "slideshow"]) }),
  ),
});
export type StudioScreen = z.infer<typeof StudioScreenSchema>;
