import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { WebShell } from "@/components/clipping/web/WebShell";
import { THEME_BOOT } from "@/lib/theme-boot";
import { createServerClient } from "@/lib/supabase/server";

import { shellAccount } from "./shell";

// Workspace sau đăng nhập: không có gì để index, và robots.txt chặn crawl là
// chưa đủ — link ngoài trỏ vào vẫn có thể bị index nếu thiếu noindex.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Khung của phần đăng nhập.
 *
 * Rail và top bar dựng Ở ĐÂY chứ không trong từng trang. Layout của App Router
 * không render lại khi đi giữa các route anh em, nên cây client của shell —
 * channel Realtime nghe job, trạng thái rail, ref của toast — sống xuyên suốt
 * một phiên duyệt. Đặt shell trong từng trang thì mỗi cú bấm là một lần dựng
 * lại tất cả những thứ đó, và đó chính là cảm giác "tải lại từ đầu".
 *
 * DỮ LIỆU của từng màn vẫn đọc phía client qua `api()`. Server component đọc
 * sẵn thì mỗi lần Realtime báo đổi là một lượt render lại cả cây từ server —
 * đúng thứ Realtime sinh ra để tránh.
 *
 * Auth gate chỉ ở đây, không lặp lại trong từng trang. Vì layout không chạy lại
 * khi điều hướng, gate này bảo vệ lần vào đầu tiên; các lần sau do
 * `middleware.ts` (chạy cả với request RSC) và RLS lo — phiên chết thì nhận
 * 401 chứ không nhận dữ liệu.
 */

/**
 * Rail nhớ trạng thái thu/mở trong `localStorage`, mà React chỉ đọc được sau
 * khi hydrate xong. Chờ tới đó là người dùng đã kịp nhìn thấy rail mở ra rồi
 * thu lại. Script này chạy trước khung hình đầu tiên và chỉ đặt một thuộc
 * tính; CSS làm phần còn lại, nên nó không thể lệch với HTML của server.
 */
const RAIL_BOOT =
  "try{if(localStorage.getItem('opencmo.rail')==='closed')" +
  "document.documentElement.dataset.rail='closed'}catch(e){}";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const account = await shellAccount(supabase, user);

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: RAIL_BOOT + THEME_BOOT }} />
      <WebShell {...account}>{children}</WebShell>
    </>
  );
}
