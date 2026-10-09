import { NextResponse } from "next/server";

import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { taskById, taskWithUrl } from "@/lib/api/tasks";

export const dynamic = "force-dynamic";

/**
 * Tải file của một task bằng 303 tới signed URL ký MỚI (ràng buộc web số 3).
 *
 * Nút Download của editor từng mang thẳng URL ký lúc export xong, mà URL tải về
 * chỉ sống 5 phút: người dùng xem lại clip một lúc rồi bấm là nhận trang lỗi của
 * Storage. Link trỏ về đây thì bấm lúc nào cũng được.
 */
export const GET = withApi({}, async ({ supabase, params, request }) => {
  // `?preview=1`: thẻ <video> trên trang project phát tại chỗ, không tải về.
  const inline = new URL(request.url).searchParams.get("preview") === "1";
  const task = await taskWithUrl(await taskById(supabase, params.id), { inline });
  if (task.status !== "done" || !task.url) {
    throw new ApiError(409, "This file isn't ready to download.");
  }
  return NextResponse.redirect(task.url, 303);
});
