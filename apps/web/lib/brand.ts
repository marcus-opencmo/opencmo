/**
 * Brand Kit phía server (spec brand-kit): đọc kit của người dùng dưới RLS, lớp
 * kiểm zod (lớp 1) trước RPC `save_brand_kit` (lớp 2).
 */

import { BrandKitSchema, type BrandKit } from "@opencmo/editor-core";

import { ApiError } from "@/lib/api/errors";
import type { SupabaseClient } from "@/lib/api/handler";

export type BrandKitRow = { id: string; name: string; kit: BrandKit; is_default: boolean; created_at: string; updated_at: string };

export const BRAND_COLUMNS = "id, name, kit, is_default, created_at, updated_at";

/** Kit hợp lệ, hoặc 422 với câu đọc được. */
export function parseKit(raw: unknown): BrandKit {
  const parsed = BrandKitSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ApiError(422, `${where}${issue?.message ?? "This brand kit is not valid."}`);
  }
  return parsed.data;
}

/** Kit mặc định của người đang đăng nhập (RLS), null khi chưa có. Kit hỏng coi như không có. */
export async function defaultBrandKit(supabase: SupabaseClient): Promise<BrandKitRow | null> {
  const { data } = await supabase.from("brand_kits").select(BRAND_COLUMNS).eq("is_default", true).maybeSingle();
  if (!data) return null;
  const parsed = BrandKitSchema.safeParse((data as BrandKitRow).kit);
  return parsed.success ? { ...(data as BrandKitRow), kit: parsed.data } : null;
}
