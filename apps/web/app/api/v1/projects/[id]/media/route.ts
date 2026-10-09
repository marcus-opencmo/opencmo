import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { jobRowOrThrow } from "@/lib/api/projects";
import { signedObjectUrl } from "@/lib/storage";
import { wakeWorker } from "@/lib/modal";

export const dynamic = "force-dynamic";

type AssetRow = {
  id: string;
  name: string;
  duration: number | string | null;
  width: number | null;
  height: number | null;
  status: string;
  error: string | null;
  storage_path: string;
  created_at: string;
};

/**
 * Thư viện B-roll của một project.
 *
 * Asset `pending` chưa có link phát: worker chưa probe nên ta còn chưa biết nó
 * có phải video đọc được hay không. Timeline hiện "Checking video…" cho tới khi
 * Realtime báo `ready`.
 */
export const GET = withApi({}, async ({ supabase, params }) => {
  await jobRowOrThrow(supabase, params.id);

  const { data } = await supabase
    .from("media_assets")
    .select("id, name, duration, width, height, status, error, storage_path, created_at")
    .eq("job_id", params.id)
    .order("created_at");

  return Promise.all(
    ((data ?? []) as AssetRow[]).map(async (asset) => ({
      id: asset.id,
      name: asset.name,
      duration: asset.duration === null ? 0 : Number(asset.duration),
      width: asset.width,
      height: asset.height,
      status: asset.status,
      error: asset.error,
      url:
        asset.status === "ready"
          ? await signedObjectUrl("media", asset.storage_path.replace(/^media\//, ""))
          : "",
    })),
  );
});

const body = z.object({
  objectName: z.string().min(1).max(300),
  name: z.string().trim().min(1).max(200),
  request_id: z.string().uuid(),
});

/**
 * Đăng ký file B-roll vừa upload xong.
 *
 * `objectName` do TUS trả về và KHÔNG gồm tên bucket; D1 lưu `storage_path` có
 * tiền tố `media/`. Ghép ở đây đúng một lần — ghép hai lần thì đường dẫn thành
 * `media/media/...` và `register_media_asset` từ chối với một câu khó hiểu.
 *
 * RPC tạo asset và xếp hàng task probe trong CÙNG một giao dịch: tách ra là mở
 * cửa sổ để asset nằm `pending` vĩnh viễn, không ai probe.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "media", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    const objectName = body.objectName.replace(/^media\//, "");
    const result = await rpcOrThrow<{ asset: AssetRow; task_id: string | null }>(
      supabase,
      "register_media_asset",
      {
        p_job_id: params.id,
        p_storage_path: `media/${objectName}`,
        p_name: body.name,
        p_request_id: body.request_id,
      },
    );
    if (!result?.asset) throw new ApiError(500, "Could not add that video.");

    if (result.task_id) await wakeWorker({ task_id: result.task_id });

    return {
      id: result.asset.id,
      name: result.asset.name,
      duration: result.asset.duration === null ? 0 : Number(result.asset.duration),
      width: result.asset.width,
      height: result.asset.height,
      status: result.asset.status,
      error: result.asset.error,
      url: "",
    };
  },
);
