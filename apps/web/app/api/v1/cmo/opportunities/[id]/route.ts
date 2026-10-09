import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("replied") }),
  z.object({ action: z.literal("dismissed"), reason: z.string().trim().max(400).optional() }),
]);

/**
 * Người dùng quyết một thread Reddit (W4): đã tự trả lời, hoặc bỏ (lý do thành
 * trí nhớ). KHÔNG có hành động đăng — Sales chỉ soạn, người dùng tự đăng.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    const id = params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new ApiError(404, "Conversation not found.");
    return rpcOrThrow(supabase, "cmo_decide_opportunity", {
      p_id: id,
      p_action: body.action,
      p_reason: body.action === "dismissed" ? (body.reason ?? null) : null,
    });
  },
);
