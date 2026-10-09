import { z } from "zod";

import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.object({ clip_id: z.string().uuid(), name: z.string().min(1).max(120) });

/** Đổi tên bản New edit (G1-a). Clip cắt từ video giữ tên của khoảnh khắc. */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) => ({ name: await rpcOrThrow<string>(supabase, "rename_blank_edit", { p_clip_id: body.clip_id, p_name: body.name }) }),
);
