import { z } from "zod";

import { clipContext } from "@/lib/api/clips";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { withDocument, type StoredProject } from "@/lib/editor/document";

export const dynamic = "force-dynamic";

const body = z.object({
  clip_id: z.string().uuid(),
  expected_version: z.number().int().min(1),
});

/**
 * Đưa project về bản engine sinh ra lúc mở lần đầu.
 *
 * Có `expected_version` như một lượt lưu thường: reset ở tab này không được
 * lặng lẽ đè lên bài tab kia vừa lưu. Lệch thì 409 kèm project hiện hành.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) => {
    await clipContext(supabase, body.clip_id);
    return withDocument(
      await rpcOrThrow<StoredProject>(supabase, "reset_editor_project", {
        p_clip_id: body.clip_id,
        p_expected_version: body.expected_version,
      }),
    );
  },
);
