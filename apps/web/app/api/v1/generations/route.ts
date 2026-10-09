import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { createGeneration } from "@/lib/generate/create";
import { generationView } from "@/lib/generate/models";

export const dynamic = "force-dynamic";

const body = z.object({
  job_id: z.string().uuid(),
  clip_id: z.string().uuid().nullish(),
  model: z.string().min(1).max(100),
  spec: z.record(z.string(), z.unknown()),
  request_id: z.string().uuid(),
});

/**
 * Tạo một generation. Kiểm ba lớp (luật web số 2): zod theo catalog ở đây →
 * `create_generation` (giá, giới hạn, quyền, đặt trước credit + task cùng
 * giao dịch) → worker kiểm lại trước khi gọi provider.
 *
 * Cùng spec trong cùng project đang chạy/đã xong → trả lại lượt cũ
 * (`reused: true`), không trừ credit lần hai.
 */
export const POST = withApi({ body }, async ({ supabase, body }) => {
  const result = await createGeneration(supabase, {
    jobId: body.job_id,
    clipId: body.clip_id ?? null,
    model: body.model,
    spec: body.spec,
    requestId: body.request_id,
  });
  return { generation: generationView(result.generation), reused: result.reused };
});
