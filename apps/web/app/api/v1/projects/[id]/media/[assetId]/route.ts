import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { jobRowOrThrow } from "@/lib/api/projects";

export const dynamic = "force-dynamic";

/**
 * Xoá một B-roll khỏi project.
 *
 * Trước đây xoá trong editor chỉ xoá bản OPFS: hàng `media_assets` và object
 * trong bucket `media` sống tới khi cả job bị xoá. RPC xoá hàng; trigger
 * retention có sẵn đưa object vào hàng xoá Storage mà cron dọn.
 */
export const DELETE = withApi(
  { rateLimit: { bucket: "media", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, params }) => {
    await jobRowOrThrow(supabase, params.id);
    if (!/^[0-9a-f-]{36}$/.test(params.assetId ?? "")) throw new ApiError(422, "assetId: Invalid");
    await rpcOrThrow(supabase, "delete_media_asset", { p_asset_id: params.assetId });
    return { deleted: true };
  },
);
