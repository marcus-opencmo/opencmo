import { notFound, rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

export type FullEdit = { clip_id: string; ready: boolean; task_id: string | null };

/**
 * "Edit full video" (E2-c): tạo (hoặc lấy lại) clip cả video của một project UPLOAD và
 * task chuẩn bị master. Idempotent — client gọi lại tới khi `ready`.
 */
export const POST = withApi(
  { rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => rpcOrThrow<FullEdit>(supabase, "create_full_edit", { p_job_id: params.id }),
);

/** Trạng thái task chuẩn bị (dưới RLS): `failed` mang câu lỗi tiếng Anh của worker. */
export const GET = withApi({}, async ({ supabase, request }) => {
  const taskId = request.nextUrl.searchParams.get("task") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(taskId)) throw notFound("Task not found.");
  const { data } = await supabase.from("tasks").select("status, error").eq("id", taskId).eq("kind", "prepare_full").maybeSingle();
  if (!data) throw notFound("Task not found.");
  return data as { status: string; error: string | null };
});
