import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.object({
  name: z.string().max(120).optional(),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  /** `slideshow` (P5): an edit made of slides, opened in the Slides view. */
  kind: z.enum(["video", "slideshow"]).default("video"),
});

/**
 * New edit (F1): một project TRỐNG mở thẳng trong editor, không cần video đã cắt. Trả clip
 * id; document trống được dựng lần đầu `GET /editor/project` mở nó.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body }) => ({
    clip_id: await rpcOrThrow<string>(supabase, body.kind === "slideshow" ? "create_slideshow" : "create_blank_edit", { p_name: body.name ?? null, p_aspect: body.aspect }),
  }),
);
