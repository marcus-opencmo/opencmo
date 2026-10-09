import { z } from "zod";
import { OP_NAMES } from "@opencmo/editor-core";

import { clipContext } from "@/lib/api/clips";
import { withApi } from "@/lib/api/handler";
import { applyToClip } from "@/lib/editor/apply";

export const dynamic = "force-dynamic";
// `@opencmo/clip-doc` dịch TSX bằng trình biên dịch TypeScript: chạy trên Node, không trên edge.
export const runtime = "nodejs";

const body = z
  .object({
    clip_id: z.string().uuid(),
    expected_version: z.number().int().min(1),
    // Schema của từng op nằm ở `@opencmo/editor-core` và được kiểm ở đó —
    // một chỗ duy nhất, cùng câu lỗi ở trình duyệt và ở đây.
    ops: z
      .array(z.object({ op: z.enum(OP_NAMES as [string, ...string[]]) }).passthrough())
      .max(50),
    checkpoint: z
      .object({
        kind: z.enum(["manual", "agent"]),
        label: z.string().trim().min(1).max(200),
      })
      .optional(),
  })
  .refine((value) => value.ops.length > 0 || value.checkpoint, "ops: Nothing to do.");

/**
 * Áp một chuỗi op của `@opencmo/editor-core` lên project của một clip, trên
 * server. Đây là đường ghi của mọi thứ KHÔNG phải tab editor đang mở clip đó:
 * "áp style cho mọi clip", và agent ở P2 (spec AI Studio §5).
 *
 * Clip của người khác → 404 trước mọi thứ khác; thứ tự CAS → áp → checkpoint
 * → lưu nằm ở `lib/editor/apply.ts`, dùng chung với Assistant.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) => {
    const context = await clipContext(supabase, body.clip_id);
    const applied = await applyToClip(supabase, context, body.clip_id, body.ops, {
      expectedVersion: body.expected_version,
      checkpoint: body.checkpoint ?? null,
    });
    const checkpoint = applied.checkpoint;
    return {
      project: applied.project,
      results: applied.results,
      checkpoint: checkpoint && {
        id: checkpoint.id,
        number: checkpoint.number,
        kind: checkpoint.kind,
        label: checkpoint.label,
        created_at: checkpoint.created_at,
      },
    };
  },
);
