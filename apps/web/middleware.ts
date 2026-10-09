import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Bỏ qua file tĩnh và ảnh: chúng không cần phiên đăng nhập, và chạy middleware
  // cho từng file là tiền compute trả không lý do.
  //
  // `editor/assets/` nằm trong danh sách đó: bản build Vite của editor là ~12
  // file JS/CSS/font, và một lượt `auth.getUser()` cho MỖI file là một vòng
  // tới Supabase cho mỗi lần mở editor. `/editor` và `/editor/index.html` thì
  // KHÔNG loại trừ — chúng là trang, và trang phải qua chốt đăng nhập.
  //
  // Blog và các file SEO là trang TĨNH công khai: không cần phiên, và một vòng
  // `auth.getUser()` cho mỗi lượt crawl là tiền trả cho bot.
  matcher: [
    "/((?!_next/static|_next/image|editor/assets|favicon.ico|blog|robots.txt|sitemap.xml|llms.txt|.*\\.(?:svg|png|jpg|mp4)$).*)",
  ],
};
