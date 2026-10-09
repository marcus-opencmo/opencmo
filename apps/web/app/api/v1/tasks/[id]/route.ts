import { withApi } from "@/lib/api/handler";
import { taskById, taskWithUrl } from "@/lib/api/tasks";

export const dynamic = "force-dynamic";

/**
 * Trạng thái một việc chạy nền.
 *
 * Client gọi lại đây sau mỗi sự kiện Realtime trên bảng `tasks` — payload của
 * Realtime chỉ để KÍCH đọc lại, không phải nguồn sự thật (mẫu `JobLive.tsx`).
 */
export const GET = withApi({}, async ({ supabase, params }) =>
  taskWithUrl(await taskById(supabase, params.id)),
);
