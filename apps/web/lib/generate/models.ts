/**
 * Catalog model sinh media phía server (spec AI Studio §7.2): model nào bật
 * được trên máy này, và hash khử trùng của một spec.
 */

import { createHash } from "node:crypto";

import { AI_MODELS, type AiModel, type GenerationSpec } from "@opencmo/editor-core/generate";

import type { SupabaseClient } from "@/lib/api/handler";
import { canonicalJson } from "@/lib/settings-schema";

import { moderationReady } from "./moderation";

/**
 * Model giả (`provider: fake`) chỉ bật khi được yêu cầu rõ ràng và KHÔNG BAO
 * GIỜ trên production — một model giả lọt ra là người dùng trả credit cho một
 * khung màu. Worker chặn thêm một lần nữa (`opencmo/ai/providers`).
 */
export const aiFakeEnabled = (): boolean =>
  process.env.OPENCMO_AI_FAKE === "1" && process.env.VERCEL_ENV !== "production";

/**
 * Provider nào bật được trên máy chủ này. Khoá nằm ở worker (Modal secret) chứ
 * không ở đây — nhưng web và worker dùng CHUNG một bộ biến, nên có khoá ở web
 * là dấu hiệu worker cũng có. Thiếu ở worker thì task hỏng và credit được hoàn.
 */
function providerEnabled(provider: string): boolean {
  switch (provider) {
    case "fake":
      return aiFakeEnabled();
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "elevenlabs":
      return Boolean(process.env.ELEVENLABS_API_KEY);
    case "fal":
      // Aggregator nhiều lab (plan Palmier P1): một khoá cho mọi model `provider: fal`.
      return Boolean(process.env.FAL_KEY);
    case "opencmo-3d":
      // 3D Studio: renderer của chính mình (GPU Modal, hoặc CLI local khi dev);
      // bản fake vẽ khung màu thay cảnh. Cùng luật với `adapter_for` ở worker.
      return ["modal", "local"].includes(process.env.OPENCMO_3D ?? "") || aiFakeEnabled();
    default:
      return false;
  }
}

/**
 * Ảnh/video từ prompt (luật sản phẩm 4 sửa 03/10, plan Palmier P0): Creem xếp
 * vào nhóm "Hạn chế + Moderation", không phải cấm. Production chỉ bật khi có
 * kiểm duyệt thật (lời ở `createGeneration`, đầu ra ở worker); thiếu khoá thì
 * vẫn chặn như trước. Dev và model giả không cần.
 */
const PROMPT_MEDIA_KINDS = new Set(["image", "video"]);

const allowedHere = (model: AiModel): boolean =>
  !(
    process.env.VERCEL_ENV === "production" &&
    PROMPT_MEDIA_KINDS.has(model.kind) &&
    !model.limits.scene &&
    !moderationReady()
  );

type CatalogRow = { id: string; name: string; price: AiModel["price"]; limits: AiModel["limits"]; enabled: boolean };

/** Hàng `ai_models` gần nhất (G5) — chung cho mọi người dùng, nạp lại sau `CATALOG_TTL_MS`. */
let catalogRows: { at: number; rows: Map<string, CatalogRow> } | null = null;
const CATALOG_TTL_MS = 60_000;

/**
 * Nạp catalog từ bảng `ai_models` (G5): giá, giới hạn, bật/tắt đổi được trong DB mà không deploy
 * — cùng hàng `ai_check_spec`/`ai_price` (SQL) dùng, nên giá trên thẻ duyệt khớp giá bị trừ. Gọi ở
 * đầu mọi đường cần giá đúng; đọc hỏng thì giữ bản cũ (hay JSON lúc khởi động).
 */
export async function loadCatalog(supabase: SupabaseClient): Promise<void> {
  if (catalogRows && Date.now() - catalogRows.at < CATALOG_TTL_MS) return;
  const { data, error } = await supabase.from("ai_models").select("id, name, price, limits, enabled");
  if (error || !data) return;
  catalogRows = { at: Date.now(), rows: new Map((data as CatalogRow[]).map((row) => [row.id, row])) };
}

/** JSON giữ phần chỉ code cần (provider, endpoint, mô tả); DB đè tên, giá, giới hạn và bỏ model tắt. */
function catalog(): AiModel[] {
  if (!catalogRows) return AI_MODELS;
  return AI_MODELS.flatMap((model) => {
    const row = catalogRows!.rows.get(model.id);
    if (!row || !row.enabled) return [];
    return [{ ...model, name: row.name, price: row.price, limits: row.limits }];
  });
}

/** Chỉ cho test: quên catalog đã nạp. */
export const resetCatalog = () => void (catalogRows = null);

/** Model dùng được ngay bây giờ. */
export function availableModels(): AiModel[] {
  return catalog().filter((model) => providerEnabled(model.provider) && allowedHere(model));
}

export const availableModel = (id: string): AiModel | undefined => availableModels().find((model) => model.id === id);

/** sha256 của JCS `{model, spec}` — cùng chuỗi với `spec_hash` ở worker (luật web số 4). */
export const specHash = (model: string, spec: GenerationSpec): string =>
  createHash("sha256").update(canonicalJson({ model, spec })).digest("hex");

export type GenerationRow = {
  id: string;
  job_id: string;
  clip_id: string | null;
  kind: string;
  model: string;
  spec: GenerationSpec;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  credits_reserved: number;
  credits_final: number | null;
  media_asset_id: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const GENERATION_COLUMNS =
  "id, job_id, clip_id, kind, model, spec, status, credits_reserved, credits_final, media_asset_id, error, created_at, finished_at";

/** Hình dạng trả về trình duyệt. Credit hiện là số THẬT: chốt nếu đã chốt, không thì phần đang giữ. */
export function generationView(row: GenerationRow) {
  return {
    id: row.id,
    job_id: row.job_id,
    clip_id: row.clip_id,
    kind: row.kind,
    model: row.model,
    spec: row.spec,
    status: row.status,
    credits: row.credits_final ?? row.credits_reserved,
    media_asset_id: row.media_asset_id,
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}
