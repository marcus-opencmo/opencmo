import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { continueTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const body = z.object({
  decisions: z
    .array(z.object({ tool_use_id: z.string().min(1).max(128), approved: z.boolean() }))
    .min(1)
    .max(8),
});

/**
 * Approve/Cancel một thẻ duyệt (`apply_to_clips`), rồi lượt chạy tiếp — cùng
 * Server-Sent Events với route `turns`. Tool đang chờ mà không có quyết định
 * nào thì tính là Cancel: Assistant không bao giờ tự ghi lên nhiều clip.
 */
export const POST = withApi({ body }, async ({ supabase, body, params }) =>
  continueTurn(
    supabase,
    params.id,
    body.decisions.map((decision) => ({ tool_use_id: decision.tool_use_id, approved: decision.approved })),
  ),
);
