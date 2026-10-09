import { NextResponse } from "next/server";

import { ApiError, withApi } from "@/lib/api/handler";
import { signedObjectUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Logo của Brand Kit (`brand:<object>` trong document) → signed URL, 303.
 *
 * Object tới từ document chứ không từ một hàng database, nên kiểm hai lớp: đúng
 * dạng đường dẫn + nằm trong thư mục của CHÍNH người gọi; và ký bằng phiên của
 * họ, RLS của bucket `brand` chỉ cho đọc thư mục của mình.
 */
export const GET = withApi({}, async ({ request, user }) => {
  const query = new URL(request.url).searchParams;
  const object = query.get("object") ?? "";
  if (!new RegExp(`^${user.id}/logo-[0-9a-f-]{36}\\.png$`).test(object)) throw new ApiError(404, "Logo not found.");
  const url = await signedObjectUrl("brand", object).catch(() => {
    throw new ApiError(404, "Logo not found.");
  });
  return query.get("resolve") === "1" ? { url } : NextResponse.redirect(url, 303);
});
