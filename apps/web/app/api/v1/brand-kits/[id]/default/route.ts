import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import type { BrandKitRow } from "@/lib/brand";

export const dynamic = "force-dynamic";

export const POST = withApi(
  { rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => firstRow(await rpcOrThrow<BrandKitRow | BrandKitRow[]>(supabase, "set_default_brand_kit", { p_id: params.id })),
);
