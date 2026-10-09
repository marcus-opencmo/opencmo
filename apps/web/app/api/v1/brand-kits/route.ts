import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { BRAND_COLUMNS, parseKit, type BrandKitRow } from "@/lib/brand";

export const dynamic = "force-dynamic";

export const GET = withApi({}, async ({ supabase }) => {
  // RLS lọc theo người dùng; không lọc `user_id` bằng tay.
  const { data } = await supabase.from("brand_kits").select(BRAND_COLUMNS).order("created_at", { ascending: true }).limit(20);
  return { kits: (data ?? []) as BrandKitRow[] };
});

const body = z.object({ name: z.string().trim().min(1).max(60), kit: z.unknown() });

export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body }) => {
    const row = firstRow(
      await rpcOrThrow<BrandKitRow | BrandKitRow[]>(supabase, "save_brand_kit", { p_id: null, p_name: body.name, p_kit: parseKit(body.kit) }),
    );
    if (!row) throw new ApiError(500, "Could not save the brand kit.");
    return row;
  },
);
