import { z } from "zod";

import { notFound, rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

export type MediaCaptions = { task_id: string; credits: number };
export type MediaCaptionsStatus = { status: string; error: string | null; output: { hash?: string; src?: string } | null };

const body = z.object({
  clip_id: z.string().uuid(),
  media_id: z.string().uuid(),
  source_in: z.number().min(0).optional(),
  source_out: z.number().positive().optional(),
  request_id: z.string().uuid().optional(),
});

/**
 * Phụ đề cho một file thư viện (E4-e): trừ 1 credit/phút của đoạn đang dùng rồi xếp task
 * `transcribe_media` cho worker. Hỏng thì trigger SQL hoàn credit — route không giữ tiền.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }) =>
    rpcOrThrow<MediaCaptions>(supabase, "request_media_captions", {
      p_clip_id: body.clip_id,
      p_media_id: body.media_id,
      p_source_in: body.source_in ?? 0,
      p_source_out: body.source_out ?? null,
      p_request_id: body.request_id ?? null,
    }),
);

/** Trạng thái task (dưới RLS): `done` mang `output.src` cho lớp captions, `failed` mang câu lỗi tiếng Anh. */
export const GET = withApi({}, async ({ supabase, request }) => {
  const taskId = request.nextUrl.searchParams.get("task") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(taskId)) throw notFound("Task not found.");
  const { data } = await supabase.from("tasks").select("status, error, output").eq("id", taskId).eq("kind", "transcribe_media").maybeSingle();
  if (!data) throw notFound("Task not found.");
  return data as MediaCaptionsStatus;
});
