/**
 * Kiểm duyệt LỜI đi vào model sinh media (luật sản phẩm 4 mới, P0 plan Palmier).
 *
 * Creem xếp text-to-image/video là "Hạn chế + Moderation": được bán nếu có kiểm
 * duyệt. Chạy ở `createGeneration` — đường duy nhất của ô Generate, Assistant và
 * MCP — TRƯỚC khi đặt credit, nên lời bị chặn không tốn gì. Thứ model vẽ ra được
 * kiểm lần hai ở worker (`opencmo/ai/moderation.py`).
 *
 * Không kiểm được (API lỗi) thì từ chối: thà người dùng bấm lại còn hơn giao
 * một thứ chưa kiểm.
 */

import { ApiError } from "@/lib/api/errors";

import { aiFakeEnabled } from "./models";

const ENDPOINT = "https://api.openai.com/v1/moderations";
const MODEL = "omni-moderation-latest";
/** Bản giả: lời chứa dấu này bị chặn — test đường từ chối không cần mạng. */
export const FAKE_FLAG = "[[flag]]";
const MAX_CHARS = 8000;

export const BLOCKED_MESSAGE = "This request goes against our content policy. Change it and try again.";

/** Có kiểm duyệt thật trên máy chủ này — production chỉ bật ảnh/video khi true. */
export const moderationReady = (): boolean => Boolean(process.env.OPENAI_API_KEY);

/** Mọi chuỗi người viết trong spec (prompt, chữ trong cảnh 3D, kịch bản giọng…), bỏ mã định danh. */
export function specText(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    if (/^(code_ref|model|voice|aspectRatio|theme|template|resolution|quality)$/.test(key)) return [];
    return value.trim().length > 1 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => specText(item, key));
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => specText(v, k));
  return [];
}

/** Ném 422 khi lời bị gắn cờ, 503 khi không kiểm được. Không có khoá (dev) thì bỏ qua. */
export async function moderateText(text: string): Promise<void> {
  const input = text.slice(0, MAX_CHARS).trim();
  if (!input) return;
  if (aiFakeEnabled() && !moderationReady()) {
    if (input.includes(FAKE_FLAG)) throw new ApiError(422, BLOCKED_MESSAGE);
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return;
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(503, "Could not check this request. Please try again.");
  }
  if (!response.ok) {
    console.error("[moderation] OpenAI trả", response.status, (await response.text().catch(() => "")).slice(0, 300));
    throw new ApiError(503, "Could not check this request. Please try again.");
  }
  const body = (await response.json()) as { results?: { flagged?: boolean }[] };
  if (body.results?.some((result) => result.flagged)) throw new ApiError(422, BLOCKED_MESSAGE);
}
