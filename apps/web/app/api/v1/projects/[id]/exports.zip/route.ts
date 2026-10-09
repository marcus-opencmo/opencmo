import { after } from "next/server";

import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { taskShape, type RawTask } from "@/lib/api/tasks";
import { wakeWorker } from "@/lib/modal";

export const dynamic = "force-dynamic";

const body = z.object({
  clip_ids: z.array(z.string().uuid()).min(1).max(10),
  request_id: z.string().uuid(),
  variant: z.enum(["original", "edited"]).default("edited"),
});

/**
 * Gói nhiều clip thành một ZIP.
 *
 * `request_zip()` chốt ảnh chụp id export NGAY lúc bấm. Worker chạy sau vài
 * phút, và "export mới nhất" lúc đó có thể là một bản khác với bản người dùng
 * đang nhìn — người ta sẽ tải về một file không giống thứ họ vừa duyệt.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "zip", limit: 20, windowSeconds: 3600 } },
  async ({ supabase, params, body }) => {
    const task = firstRow(
      await rpcOrThrow<RawTask | RawTask[]>(supabase, body.variant === "original" ? "request_original_zip" : "request_zip", {
        p_job_id: params.id,
        p_clip_ids: body.clip_ids,
        p_request_id: body.request_id,
      }),
    );
    if (!task) throw new ApiError(500, "Could not start the download. Please try again.");

    after(async () => { await wakeWorker({ task_id: task.id }); });
    return taskShape(task, null);
  },
);
