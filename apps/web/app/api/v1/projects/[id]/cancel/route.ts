import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { projectDetail } from "@/lib/api/projects";

export const dynamic = "force-dynamic";

/**
 * Huỷ chỉ đổi trạng thái. Worker thấy job không còn 'running' ở nhịp heartbeat
 * kế tiếp và tự dừng — không có đường nào giết một container Modal từ đây.
 */
export const POST = withApi(
  { rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    await rpcOrThrow(supabase, "cancel_job", { p_job_id: params.id });
    return projectDetail(supabase, params.id);
  },
);
