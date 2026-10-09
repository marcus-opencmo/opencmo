import { after } from "next/server";

import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { sourceProblem } from "@/lib/api/source";
import { kickCmoQueue } from "@/lib/cmo/jobs/start";
import { wakeWorker } from "@/lib/modal";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  source: z.string().trim().min(1).max(2000),
  /** Link (không phải file tải lên) phải được xác nhận là video của chính người dùng — luật sản phẩm 3. */
  confirmed: z.boolean().default(false),
  clips: z.number().int().min(1).max(10).default(5),
});

type Created = {
  job: { id: string; user_id: string; source_url: string; clips_requested: number; watermark: boolean };
  run: { id: string; status: string };
};

/**
 * "New video pack" (W5): job cắt clip + xác nhận chính chủ + lượt W5 trong MỘT
 * giao dịch (`create_video_pack`). Credit cắt clip giữ ở `create_job` như form cũ.
 */
export const POST = withApi({ body }, async ({ supabase, user, body }) => {
  const problem = sourceProblem(body.source, user.id);
  if (problem) throw new ApiError(422, problem);
  if (!body.source.startsWith("storage://") && !body.confirmed) {
    throw new ApiError(422, "Confirm that this is your own video.");
  }
  const created = await rpcOrThrow<Created>(supabase, "create_video_pack", {
    p_source: body.source,
    p_confirmed: body.confirmed,
    p_clips: body.clips,
  });
  if (!created?.job?.id) throw new ApiError(500, "Could not start this video pack.");
  // Worker hỏng thức cũng không sao: job ở 'queued', sweep() nhặt sau.
  after(async () => {
    await wakeWorker({
      id: created.job.id,
      user_id: created.job.user_id,
      source_url: created.job.source_url,
      clips_requested: created.job.clips_requested,
      watermark: created.job.watermark,
    });
  });
  // W5 sẽ hoãn ngay (clip chưa có) — chạy để Activity hiện bước "Making clips".
  kickCmoQueue(created.run.id);
  return { job_id: created.job.id, run_id: created.run.id };
});
