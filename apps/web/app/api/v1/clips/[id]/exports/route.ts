import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { exportPlan, startDocumentExport } from "@/lib/editor/export";

export const dynamic = "force-dynamic";

const body = z.object({
  // Chỉ còn một đường: worker vẽ document của editor revision (spec editor-rewrite §7).
  // `mode` cũ (`server`) render lại từ settings bằng ffmpeg+ASS và đã gỡ ở R1;
  // vẫn nhận `"document"` để client cũ đang mở không vỡ.
  mode: z.literal("document").optional(),
  revision_id: z.string().uuid(),
  request_id: z.string().uuid(),
});

/**
 * Export chỉ nhận revision ĐÃ LƯU: file người dùng tải về phải khớp với thứ họ
 * thấy lúc bấm, và revision là bất biến nên nó khớp mãi mãi.
 */
export const POST = withApi(
  { body },
  async ({ supabase, user, params, body }) => {
    const { resolution } = await exportPlan(supabase, user.id);
    const task = await startDocumentExport(supabase, params.id, body.revision_id, body.request_id, resolution);
    // Tiến độ và link tải đọc qua `GET /tasks/[id]`.
    return { task_id: task.id, status: task.status, resolution };
  },
);
