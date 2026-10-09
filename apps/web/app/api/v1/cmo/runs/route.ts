import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { startCmoRun } from "@/lib/cmo/jobs/start";

export const dynamic = "force-dynamic";
// Việc chạy trong `after()` sau khi trả lời: một lượt soạn bài/lập lịch thường 20–90 giây.
export const maxDuration = 300;

const body = z.object({
  kind: z.enum(["plan_week", "post_draft", "sales_scan"]),
  idea: z.string().trim().max(300).optional(),
});

/** "Plan my week", "Run now" của X Agent / Reddit Agent. Trần mỗi ngày + credit kiểm trong `enqueue_cmo_run`. */
export const POST = withApi({ body }, async ({ supabase, body }) =>
  startCmoRun(supabase, body.kind, body.idea ? { idea: body.idea } : {}),
);
