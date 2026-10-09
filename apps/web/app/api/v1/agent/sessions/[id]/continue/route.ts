import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { continueTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({ extend: z.boolean().optional() });

/**
 * Nối tiếp một lượt đang dừng giữa hai request (spec agent-editor §5):
 * - dừng vì trần thời gian của request (`awaiting_continue`, 'time'): tab gọi
 *   ngay, không hỏi ai;
 * - dừng vì hết credit đã giữ ('budget'): chỉ chạy với `extend: true` — người
 *   dùng đã bấm "Continue for N credits", SQL giữ thêm rồi mới chạy.
 */
export const POST = withApi({ body }, async ({ supabase, body, params }) => {
  if (body.extend !== true) {
    // Chỉ lượt dừng vì THỜI GIAN nối tiếp không cần ai: lượt đang chờ câu trả
    // lời hay thẻ duyệt mà đi qua đây thì câu hỏi thành "bỏ qua", thẻ thành Cancel.
    const { data } = await supabase
      .from("agent_turns")
      .select("status, pause_reason")
      .eq("session_id", params.id)
      .order("number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const turn = data as { status: string; pause_reason: string | null } | null;
    if (turn?.status !== "awaiting_continue" || turn.pause_reason !== "time") {
      throw new ApiError(409, "The assistant is not waiting to continue.");
    }
  }
  return continueTurn(supabase, params.id, [], { extend: body.extend === true });
});
