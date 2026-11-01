import { after } from "next/server";

import { firstRow, notFound, rpcOrThrow, withApi } from "@/lib/api/handler";
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
    // Not a job id is "not found", not a Postgres cast error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(params.id ?? ""))) throw notFound("Project not found.");
    const job = firstRow(
      await rpcOrThrow<JobRow | JobRow[]>(supabase, "retry_job", { p_job_id: params.id }),
    ) as JobRow | null;

    if (job) {
      after(async () => { await wakeWorker({ id: job.id }); });
    }
    return projectDetail(supabase, params.id);
  },
);
