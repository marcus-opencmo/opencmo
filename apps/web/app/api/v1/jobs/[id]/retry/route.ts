import { after } from "next/server";

import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { projectDetail } from "@/lib/api/projects";
import { wakeWorker } from "@/lib/modal";
import type { JobRow } from "@/lib/api/shapes";

export const dynamic = "force-dynamic";

/**
 * Chạy lại project đã hỏng.
 *
 * Giữ credit, xoá lỗi cũ và đưa job về hàng đợi nằm trong MỘT giao dịch ở
 * `retry_job()`; ở đây chỉ còn việc đánh thức worker.
 */
export const POST = withApi(
  { rateLimit: { bucket: "retry", limit: 20, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    const job = firstRow(
      await rpcOrThrow<JobRow | JobRow[]>(supabase, "retry_job", { p_job_id: params.id }),
    ) as (JobRow & { user_id: string; watermark: boolean }) | null;

    if (job) {
      after(async () => { await wakeWorker({
        id: job.id,
        user_id: job.user_id,
        source_url: job.source_url,
        clips_requested: job.clips_requested,
        watermark: job.watermark,
      }); });
    }
    return projectDetail(supabase, params.id);
  },
);
