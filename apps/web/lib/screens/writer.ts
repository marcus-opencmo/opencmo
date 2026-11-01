/**
 * S8 Writer (`Writer.dc.html`).
 */

import { z } from "zod";

import { PlatformSchema, iso } from "./common";

export const WRITER_KINDS = ["post", "caption", "video_brief", "slide_text"] as const;
export const WRITER_COLUMNS = ["drafting", "waiting", "scheduled", "posted"] as const;

export const DraftSchema = z.object({
  id: z.string(),
  kind: z.enum(WRITER_KINDS),
  platform: PlatformSchema,
  /** When it goes out (or went out); null while drafting without a slot. */
  at: iso.nullable(),
  /** Day label when there is no exact time yet ("Fri"). */
  dayText: z.string().max(20).nullable(),
  title: z.string().max(300),
  column: z.enum(WRITER_COLUMNS),
  versions: z.number().int().min(1).max(3),
  /** "You edited 2 lines · results tomorrow", "Approved as drafted". */
  note: z.string().max(120).nullable(),
  approvalId: z.string().nullable(),
});

export const VoiceLineSchema = z.object({ text: z.string().max(200), source: z.string().max(120) });

export const WriterScreenSchema = z.object({
  drafts: z.array(DraftSchema),
  voice: z.object({ lines: z.array(VoiceLineSchema), wordsCut: z.array(z.string().max(40)) }),
});
export type WriterScreen = z.infer<typeof WriterScreenSchema>;
