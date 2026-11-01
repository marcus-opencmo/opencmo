import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { brainMode } from "@/lib/cmo/brain";
import { startCmoRun } from "@/lib/cmo/jobs/start";

export const dynamic = "force-dynamic";
// Việc chạy trong `after()` sau khi trả lời: một lượt soạn bài/lập lịch thường 20–90 giây.
export const maxDuration = 300;

const body = z.object({
  kind: z.enum(["plan_week", "post_draft", "sales_scan"]),
  idea: z.string().trim().max(300).optional(),
});

/**
 * "Plan my week", "Run now" của X Agent / Reddit Agent. Trần mỗi ngày + credit kiểm trong `enqueue_cmo_run`.
 * In mode B the task goes to the founder's Claude inbox instead of failing for credits.
 */
export const POST = withApi({ body, rateLimit: { bucket: "cmo-runs", limit: 60, windowSeconds: 3600 } }, async ({ supabase, user, body }) => {
  const input: Record<string, unknown> = body.idea ? { idea: body.idea } : {};
  if ((await brainMode(supabase, user.id)).brain === "claude") input.brain = "claude";
  return startCmoRun(supabase, body.kind, input);
});
