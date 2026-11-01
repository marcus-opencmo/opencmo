/**
 * S6 Library (`Library.dc.html`): Business (four documents), Brand Kit, Voice, Skills. One copy of each thing,
 * read by the brain and every department (docs/architecture/brain.md §8b).
 */

import { z } from "zod";

import { PlatformSchema, iso } from "./common";

/** Same kinds as `marketing_documents.kind` (`lib/cmo/documents.ts`). */
export const LibraryDocumentSchema = z.object({
  kind: z.enum(["product", "strategy", "competitors", "content_strategy"]),
  title: z.string().max(80),
  summary: z.string().max(300),
  fields: z.number().int().min(0),
  /** Who wrote the current version; `agent` + no edit = "drafted from your site, not edited yet". */
  editedBy: z.enum(["agent", "user"]),
  editedAt: iso,
  /** Extra line after the field count: "Research updates the outliers · you pick the competitors". */
  note: z.string().max(120).nullable(),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * A view of one `brand_kits` row. Not editor-core's `BrandKitSchema` on purpose: this module is imported by
 * client pages, and editor-core pulls the renderer's font table in with it.
 */
export const LibraryBrandKitSchema = z.object({
  id: z.string(),
  name: z.string().max(60),
  colors: z.object({ primary: hex, secondary: hex, accent: hex, text: hex, background: hex }),
  fonts: z.object({ heading: z.string().max(60), body: z.string().max(60) }),
  captionStyle: z.string().max(40),
  aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]),
  fit: z.enum(["cover", "contain", "fill"]),
  logo: z
    .object({
      /** Signed URL of the logo in the `brand` bucket. */
      url: z.url().nullable(),
      corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
      /** Width as a share of the frame: 0.08 = "8% of the frame". */
      size: z.number().min(0.05).max(0.4),
    })
    .nullable(),
});

/**
 * One voice note (P3 F5): what Writer learned about how the founder writes, from one decision (an approval as is,
 * an edit or a skip reason). Newer notes weigh more; a note expires after 60 days. The founder can delete any.
 */
export const VoiceNoteSchema = z.object({
  id: z.string(),
  text: z.string().max(600),
  /** The platform the decision was for; null = all platforms. */
  platform: PlatformSchema.nullable(),
  /** From what: "Approved as drafted", "From your edit: wrong voice", "From a skip reason". */
  source: z.string().max(200),
  at: iso,
  /** 1 for a note learned today, falling with age to 0 when it expires; the writer reads the heaviest first. */
  weight: z.number().min(0).max(1),
  /** An older note this one replaced, quoted. */
  replaces: z.string().max(200).nullable(),
});

/** Agents that read skills, as the Library names them. */
export const SKILL_READERS = ["Writer", "Checker", "Sales", "CMO chat", "Studio", "Editor Assistant"] as const;

/** One skill, read only (P3 C1): what it is for and which agents read it. */
export const LibrarySkillSchema = z.object({
  id: z.string(),
  name: z.string().max(80),
  origin: z.enum(["built_in", "yours"]),
  /** What it is for: "Guidance, never a hard filter". */
  note: z.string().max(200),
  readBy: z.array(z.enum(SKILL_READERS)).min(1),
});

export const LibraryScreenSchema = z.object({
  /** The site Research read: "Research drafted these from opencmo.io". */
  site: z.string().max(200).nullable(),
  documents: z.array(LibraryDocumentSchema).max(4),
  brandKits: z.array(LibraryBrandKitSchema),
  voice: z.object({ notes: z.array(VoiceNoteSchema), wordsCut: z.array(z.string().max(40)) }),
  skills: z.object({ writing: z.array(LibrarySkillSchema), video: z.array(LibrarySkillSchema) }),
});
export type LibraryScreen = z.infer<typeof LibraryScreenSchema>;
