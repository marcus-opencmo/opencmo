import { z } from "zod";

import { withApi } from "@/lib/api/handler";
import { translateCaptions } from "@/lib/editor/captions-run";
import { TRANSLATE_LANGUAGES } from "@/lib/editor/captions-translate";

export const dynamic = "force-dynamic";
// Một lượt dịch tối đa 30 phút phụ đề: cho model đủ thời gian.
export const maxDuration = 120;

export type CaptionTranslation = { src: string; credits: number };

const body = z.object({
  clip_id: z.string().uuid(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  language: z.enum(TRANSLATE_LANGUAGES),
});

/**
 * Dịch một lớp phụ đề (E4-e): trừ 1 credit/phút phụ đề → model dịch từng dòng → từ của
 * câu dịch chia trong khung giờ câu gốc → transcript mới. Cùng đường với tool
 * `translate_captions` của agent (`lib/editor/captions-run.ts`).
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "editor-write", limit: 240, windowSeconds: 60 } },
  async ({ supabase, body }): Promise<CaptionTranslation> => translateCaptions(supabase, body.clip_id, body.hash, body.language),
);
