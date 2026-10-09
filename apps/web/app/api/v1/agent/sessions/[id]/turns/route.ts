import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { startTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Một request chạy tới `MAX_REQUEST_MS` (240s) rồi tạm dừng; phần còn lại để dừng gọn.
export const maxDuration = 300;

const body = z.object({
  prompt: z.string().trim().min(1).max(4000),
  attachments: z
    .object({
      playhead: z.number().min(0).max(86_400).optional(),
      selection: z.array(z.string().max(64)).max(20).optional(),
      frame: z.string().max(600_000).regex(/^[A-Za-z0-9+/=]+$/, "frame: base64 only").optional(),
      // Tên giọng (chữ, số, cách) — đi thẳng vào lời nhắn cho model.
      voice: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9 ._-]+$/, "voice: letters and numbers only").optional(),
    })
    .optional(),
});

/**
 * Gửi một câu lệnh cho Assistant; trả Server-Sent Events.
 *
 * Mọi lỗi CÓ THỂ báo trước (phiên người khác, đang có lượt chạy, thiếu
 * credit, server không còn khoá cho model của phiên) đi ra dạng JSON trước
 * khi stream mở. Sau đó, lỗi nằm trong event `done` — HTTP 200 đã gửi đi rồi.
 *
 * Event: `turn` {number} · `text`/`thinking` {text} · `tool_start` {id, name}
 * · `tool_result` {id, name, ok, summary} · `project_changed` {version?}
 * · `tool_request` {id, name, input} (tool trình duyệt → route `tool-results`)
 * · `approval_request` {id, name, card} (thẻ duyệt → route `approvals`)
 * · `input_request` {id, name, card} (câu hỏi `ask_user` → route `tool-results`)
 * · `done` {status, reason?, credits, extend?, error} — `awaiting_continue`:
 *   'time' thì gọi route `continue` ngay; 'budget' thì hỏi người dùng rồi
 *   `continue` với `extend: true`.
 */
export const POST = withApi({ body }, async ({ supabase, body, params }) =>
  startTurn(supabase, params.id, body.prompt, body.attachments),
);
