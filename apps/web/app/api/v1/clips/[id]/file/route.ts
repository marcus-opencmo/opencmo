import { NextResponse } from "next/server";

import { ApiError, withApi } from "@/lib/api/handler";
import { clipFilename } from "@/lib/api/projects";
import { signedObjectUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Ký lại mỗi lần tải/phát; trang mở lâu không giữ URL đã hết hạn. */
export const GET = withApi({}, async ({ request, supabase, params }) => {
  const query = new URL(request.url).searchParams;
  const preview = query.get("preview") === "1";
  const { data, error } = await supabase.from("clips")
    .select("id, idx, hook, storage_path, preview_path")
    .eq("id", params.id).maybeSingle();
  if (error) throw new ApiError(503, "Could not prepare your download. Please try again.");
  if (!data) throw new ApiError(404, "Clip not found.");
  const path = preview ? data.preview_path ?? data.storage_path : data.storage_path;
  if (!path) throw new ApiError(404, "This clip file is unavailable. Refresh the project and try again.");
  const url = await signedObjectUrl("clips", path,
    preview ? undefined : { download: clipFilename(data) });
  return query.get("resolve") === "1" ? { url } : NextResponse.redirect(url, 303);
});
