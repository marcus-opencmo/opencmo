import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { continueTurn } from "@/lib/agent/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** JPEG base64: một contact sheet ≤12 ô hay ≤4 ảnh rời. Trần rộng tay nhưng chặn một client hỏng. */
const image = z.string().max(600_000).regex(/^[A-Za-z0-9+/=]+$/, "images: base64 only");

/** Số liệu của tool tab (sóng âm, mốc thời gian) — nhỏ, JSON thuần. */
const data = z.unknown().refine((value) => JSON.stringify(value ?? null).length <= 20_000, "data: too large");

const body = z.object({
  results: z
    .array(
      z.object({
        tool_use_id: z.string().min(1).max(128),
        images: z.array(image).max(4).optional(),
        data: data.optional(),
        error: z.string().max(300).optional(),
        /** Quyết định ở thẻ duyệt, gửi CÙNG kết quả tool tab của cùng bước. */
        approved: z.boolean().optional(),
        /** Câu trả lời cho `ask_user`. */
        answer: z
          .object({
            choices: z.array(z.string().max(120)).max(6).optional(),
            text: z.string().max(2000).optional(),
            skipped: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(8),
});

/**
 * Trình duyệt trả kết quả tool phía tab (`capture`, `media_waveform`,
 * `media_grab`) hay câu trả lời của người dùng (`ask_user`) cho lượt đang chờ,
 * rồi lượt chạy tiếp — cùng Server-Sent Events với route `turns`. Lượt không
 * chờ gì (đã Stop, đã trả) thì 409, trước khi stream mở.
 */
export const POST = withApi({ body }, async ({ supabase, body, params }) => continueTurn(supabase, params.id, body.results));
