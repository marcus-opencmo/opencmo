import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/**
 * Huỷ một export (E2-d2). Đang chờ thì huỷ ngay; đang chạy thì worker thấy ở nhịp
 * heartbeat kế tiếp, dừng exporter và không tải file nào lên.
 */
export const POST = withApi(
  { rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    const task = await rpcOrThrow<{ id: string; status: string }>(supabase, "cancel_export", { p_task_id: params.id });
    return { id: task.id, status: task.status };
  },
);
