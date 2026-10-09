import { z } from "zod";

import { clipContext } from "@/lib/api/clips";
import { withApi } from "@/lib/api/handler";
import { EXPORT_FRAME_NAMES, snapshotForExport } from "@/lib/editor/export";

export const dynamic = "force-dynamic";

const body = z.object({
  clip_id: z.string().uuid(),
  document_hash: z.string().regex(/^[0-9a-f]{64}$/, "Invalid project fingerprint."),
  frame: z.enum(EXPORT_FRAME_NAMES).optional(),
});

/**
 * Chụp project hiện hành thành một revision bất biến.
 *
 * Export xếp hàng trỏ vào một revision chứ không vào `editor_projects`: người
 * dùng bấm Export rồi sửa tiếp là chuyện bình thường, và file giao về phải
 * khớp với thứ họ thấy lúc bấm.
 *
 * `document_hash` là vân tay server đã trả cho bản client đang thấy. SQL ĐỐI
 * CHIẾU nó với bản đang có — database đã sang bản khác (tab khác, Assistant)
 * mà vẫn chụp thì export ra một file không ai từng nhìn thấy.
 *
 * `frame` khác khung hiện tại: đổi khung trên BẢN SAO rồi chụp bản sao
 * (`lib/editor/export.ts`, cùng đường với tool `request_export` của Assistant).
 *
 * Không rate limit riêng: lượt gọi này luôn đi kèm một lượt export, và export
 * đã có quota theo gói.
 */
export const POST = withApi({ body }, async ({ supabase, body }) => {
  const context = await clipContext(supabase, body.clip_id);
  return snapshotForExport(supabase, context, body.clip_id, body.document_hash, body.frame);
});
