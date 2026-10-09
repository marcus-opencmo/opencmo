import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), text: z.string().max(4000).optional() }),
  z.object({ action: z.literal("skip"), reason: z.string().trim().max(400).optional() }),
  z.object({ action: z.literal("posted"), url: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("edit"), idea: z.string().trim().min(1).max(300), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("remove") }),
]);

/**
 * Người dùng quyết định một mục: duyệt/bỏ bài X, đánh dấu đã đăng, sửa/xoá mục
 * lịch. Mọi luật (trần 5 bài/ngày, 280 ký tự, chống duyệt trùng) nằm trong RPC.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    const id = params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new ApiError(404, "Item not found.");
    switch (body.action) {
      case "approve":
        return rpcOrThrow(supabase, "cmo_decide_post", { p_id: id, p_action: "approve", p_text: body.text ?? null });
      case "skip":
        return rpcOrThrow(supabase, "cmo_decide_post", { p_id: id, p_action: "skip", p_reason: body.reason ?? null });
      case "posted":
        return rpcOrThrow(supabase, "cmo_mark_posted", { p_id: id, p_url: body.url ?? null });
      case "edit":
        return rpcOrThrow(supabase, "cmo_update_item", { p_id: id, p_idea: body.idea, p_day: body.day });
      case "remove":
        await rpcOrThrow(supabase, "cmo_remove_item", { p_id: id });
        return { ok: true };
    }
  },
);
