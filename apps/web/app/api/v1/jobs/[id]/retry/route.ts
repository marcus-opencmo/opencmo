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
 * `retry_job()`; ở đây chỉ còn việc đánh thức worker. Its limits (3 in progress, 20 retries an hour) live
 * in the SQL too: a direct RPC call skips the route, and counting here as well would halve them.
 */
export const POST = withApi(
  {},
  async ({ supabase, params }) => {
    const job = firstRow(
      await rpcOrThrow<JobRow | JobRow[]>(supabase, "retry_job", { p_job_id: params.id }),
    ) as JobRow | null;

    if (job) {
      after(async () => { await wakeWorker({ id: job.id }); });
    }
    return projectDetail(supabase, params.id);
  },
);
