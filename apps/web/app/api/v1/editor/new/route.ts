import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.object({
  name: z.string().max(120).optional(),
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
});

/**
 * New edit (F1): một project TRỐNG mở thẳng trong editor, không cần video đã cắt. Trả clip
 * id; document trống được dựng lần đầu `GET /editor/project` mở nó.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body }) => ({
    clip_id: await rpcOrThrow<string>(supabase, "create_blank_edit", { p_name: body.name ?? null, p_aspect: body.aspect }),
  }),
);
