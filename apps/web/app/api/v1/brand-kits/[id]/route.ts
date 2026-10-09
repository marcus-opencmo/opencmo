import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { parseKit, type BrandKitRow } from "@/lib/brand";

export const dynamic = "force-dynamic";

const body = z.object({ name: z.string().trim().min(1).max(60), kit: z.unknown() });

export const PUT = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    const row = firstRow(
      await rpcOrThrow<BrandKitRow | BrandKitRow[]>(supabase, "save_brand_kit", { p_id: params.id, p_name: body.name, p_kit: parseKit(body.kit) }),
    );
    if (!row) throw new ApiError(500, "Could not save the brand kit.");
    return row;
  },
);

export const DELETE = withApi(
  { rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    const removed = await rpcOrThrow<boolean>(supabase, "delete_brand_kit", { p_id: params.id });
    // Kit của người khác và kit không tồn tại trả về cùng một câu.
    if (!removed) throw new ApiError(404, "Brand kit not found.");
    return { ok: true };
  },
);
