import "server-only";

/**
 * Việc tốn credit của phụ đề (E4-e), dùng chung cho route của inspector và tool của agent:
 * một đường trừ phí, một đường hoàn — agent và nút bấm không thể tính giá khác nhau.
 */

import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { notFound, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { LlmError, llmReady, structured } from "@/lib/cmo/jobs/llm";
import { aiFakeEnabled } from "@/lib/generate/models";

import { applyTranslation, captionSeconds, fakeTranslate, parseTranscript, type TranscriptLine } from "./captions-translate";

export const TRANSLATE_FAILED = "Could not translate these captions. Your credits were refunded.";
export const CAPTIONS_FAILED = "Could not create captions. Your credits were refunded.";

/** Đọc transcript đã lưu (dưới RLS) thành các dòng; rỗng hoặc hỏng thì lỗi tiếng Anh. */
export async function storedLines(supabase: SupabaseClient, clipId: string, hash: string): Promise<TranscriptLine[]> {
  const { data } = await supabase.from("editor_transcripts").select("body").eq("clip_id", clipId).eq("hash", hash).maybeSingle();
  if (!data) throw notFound("These captions are no longer available.");
  let lines: TranscriptLine[];
  try {
    lines = parseTranscript((data as { body: string }).body);
  } catch {
    throw new ApiError(422, "These captions can't be translated.");
  }
  if (!lines.length) throw new ApiError(422, "These captions are empty.");
  return lines;
}

async function translateLines(lines: TranscriptLine[], language: string): Promise<string[]> {
  if (aiFakeEnabled()) return fakeTranslate(lines, language);
  if (!llmReady("captions")) throw new LlmError("Translation is not set up on this server yet.");
  const out = await structured({
    agent: "captions",
    label: "captions.translate",
    failure: TRANSLATE_FAILED,
    maxTokens: 16_000,
    system:
      `You translate video captions into ${language}. Translate each numbered line on its own, keeping its meaning and spoken tone. ` +
      "Return exactly one translated line per input line, in the same order. Keep names and brand names as they are. Do not add notes.",
    prompt: lines.map((line, index) => `${index + 1}. ${line.text}`).join("\n"),
    schema: z.object({ lines: z.array(z.string()) }),
  });
  if (out.lines.length !== lines.length) throw new LlmError(TRANSLATE_FAILED);
  return out.lines;
}

/** Trừ phí → dịch → lưu transcript mới; hỏng ở bước nào cũng hoàn phí. */
export async function translateCaptions(
  supabase: SupabaseClient,
  clipId: string,
  hash: string,
  language: string,
): Promise<{ src: string; credits: number }> {
  const lines = await storedLines(supabase, clipId, hash);
  const charge = await rpcOrThrow<{ charge_id: string; credits: number }>(supabase, "charge_caption_translation", {
    p_clip_id: clipId,
    p_seconds: Math.max(1, captionSeconds(lines)),
  });
  try {
    const translated = applyTranslation(lines, await translateLines(lines, language), language);
    const saved = await rpcOrThrow<string>(supabase, "complete_caption_translation", {
      p_charge_id: charge.charge_id,
      p_body: JSON.stringify(translated),
    });
    return { src: `assets/transcripts/${saved}.json`, credits: charge.credits };
  } catch (error) {
    // Hoàn hỏng thì phí nằm lại ở trạng thái `charged`: phải hiện ra log để đối soát,
    // nhưng không được che lỗi gốc mà người dùng cần thấy.
    const { error: refundError } = await supabase.rpc("refund_caption_translation", { p_charge_id: charge.charge_id });
    if (refundError) console.error(`[captions] refund_caption_translation ${charge.charge_id} failed: ${refundError.message}`);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, error instanceof LlmError ? error.message : TRANSLATE_FAILED);
  }
}

/**
 * Tạo phụ đề cho một file thư viện rồi chờ worker (tối đa `waitMs`): trả `src` của
 * transcript, hoặc null nếu hết giờ chờ (task vẫn chạy; credit hoàn nếu nó hỏng).
 */
export async function createMediaCaptions(
  supabase: SupabaseClient,
  input: { clipId: string; mediaId: string; sourceIn: number; sourceOut: number; requestId?: string },
  waitMs = 0,
): Promise<{ taskId: string; credits: number; src: string | null }> {
  const { task_id, credits } = await rpcOrThrow<{ task_id: string; credits: number }>(supabase, "request_media_captions", {
    p_clip_id: input.clipId,
    p_media_id: input.mediaId,
    p_source_in: input.sourceIn,
    p_source_out: input.sourceOut,
    p_request_id: input.requestId ?? null,
  });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { data } = await supabase.from("tasks").select("status, error, output").eq("id", task_id).maybeSingle();
    const task = data as { status: string; error: string | null; output: { src?: string } | null } | null;
    if (task?.status === "done" && task.output?.src) return { taskId: task_id, credits, src: task.output.src };
    if (task?.status === "failed" || task?.status === "cancelled") throw new ApiError(502, task.error ?? CAPTIONS_FAILED);
  }
  return { taskId: task_id, credits, src: null };
}
