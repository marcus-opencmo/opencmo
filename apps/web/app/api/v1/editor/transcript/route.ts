import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { clipContext } from "@/lib/api/clips";
import { jsonResponse, notFound, rpcOrThrow, withApi } from "@/lib/api/handler";
import { transcriptFromArtifact } from "@/lib/editor/transcript";

export const dynamic = "force-dynamic";

/**
 * Transcript của một clip, ở hình dạng NATIVE của Diffusion Studio.
 *
 * `<captions src>` nhận `.srt`, `.vtt` hoặc một transcript `.json`. Phải dùng
 * `.json`: parser SRT của DS (`caption/subtitles.ts`) **bịa mốc từng từ theo độ
 * dài ký tự**, vì cue SRT không mang word timing. Preset `classic` — preset cho
 * video dọc — hiện từng từ một, nên chỗ bịa đó lệch nhìn thấy được. Ta CÓ word
 * timing thật từ transcript của engine, và `resolveTranscript` nhận `.json`
 * thẳng, không qua parser.
 *
 * Hình dạng đích và thang thời gian: xem `lib/editor/transcript.ts`, nơi
 * route ops cũng đọc transcript này.
 *
 * Phase 3.1 để engine ghi thẳng file này vào Storage lúc xử lý job; lúc đó
 * route này thành thừa và `media.transcript` trỏ vào một signed URL. Tới đó nó
 * còn ở đây để clip cũ vẫn mở được.
 */

export const GET = withApi({}, async ({ supabase, request }) => {
  const params = new URL(request.url).searchParams;
  const clipId = params.get("clip_id") ?? "";
  if (!clipId) throw new ApiError(422, "clip_id: Required");

  const context = await clipContext(supabase, clipId);

  // Bản người dùng đã sửa: địa chỉ theo nội dung (`editor_transcripts`), nên
  // trả đúng từng byte đã lưu và cho trình duyệt cache mãi — cùng hash là cùng
  // nội dung, không bao giờ đổi.
  const hash = params.get("hash");
  if (hash !== null) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(422, "hash: Invalid");
    const { data: edited } = await supabase
      .from("editor_transcripts")
      .select("body")
      .eq("clip_id", context.clip.id)
      .eq("hash", hash)
      .maybeSingle();
    if (!edited) throw notFound("This transcript is no longer available.");
    return new NextResponse((edited as { body: string }).body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }

  return jsonResponse(await transcriptFromArtifact(supabase, context, clipId));
});

// Trần rộng tay so với một clip ngắn (60–90 giây là ~200 từ), nhưng đủ chặt để
// một client hỏng không đẩy được 8MB vào một hàng. SQL chặn lần nữa ở 512KB.
// `id` ĐỨNG ĐẦU: zod ghi object theo thứ tự của schema, và chuỗi được băm là
// `JSON.stringify` của bản đã qua zod. `normalize` của editor-core đặt `id`
// đầu mỗi từ, nên hai phía ra cùng một chuỗi — cùng hash.
const word = z
  .object({
    id: z.string().min(1).max(40).optional(),
    text: z.string().max(200),
    start: z.number().finite().min(0).max(36_000),
    end: z.number().finite().min(0).max(36_000),
  })
  .refine((w) => w.start <= w.end, "A word ends before it starts.");

const segment = z.object({
  text: z.string().max(2_000),
  words: z.array(word).max(1_000),
});

const body = z.object({
  clip_id: z.string().uuid(),
  transcript: z.array(segment).max(5_000),
});

/**
 * Lưu một transcript đã sửa, trả hash để `<captions src>` trỏ tới
 * `assets/transcripts/<hash>.json`.
 *
 * Hash do SQL tính trên đúng chuỗi được lưu — không nhận hash từ client. Chuỗi
 * là `JSON.stringify` của bản đã qua zod, tức cùng hàm mà client dùng để ghi
 * bản OPFS của nó.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) => {
    await clipContext(supabase, body.clip_id);
    const hash = await rpcOrThrow<string>(supabase, "put_editor_transcript", {
      p_clip_id: body.clip_id,
      p_body: JSON.stringify(body.transcript),
    });
    return { hash };
  },
);
