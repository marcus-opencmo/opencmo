import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const body = z.object({
  action: z.enum(["approve", "reject"]),
  goal: z.string().trim().min(3).max(300).optional(),
  target: z.number().int().min(1).max(1_000_000).optional(),
});

/**
 * The founder approves (optionally editing the wording or target) or rejects a weekly goal the
 * CMO proposed. Ownership and limits live in `cmo_decide_goal`.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    if (!/^[0-9a-f-]{36}$/i.test(params.id ?? "")) throw new ApiError(404, "Goal not found.");
    return rpcOrThrow(supabase, "cmo_decide_goal", {
      p_id: params.id,
      p_action: body.action,
      p_goal: body.goal ?? null,
      p_target: body.target ?? null,
    });
  },
);
