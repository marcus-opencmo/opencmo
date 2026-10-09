"use client";

import { useEffect, useState } from "react";

import { formatDate } from "@/lib/format";

/**
 * Giờ theo múi giờ của NGƯỜI XEM. Trang server (billing) gọi `formatDate` thì
 * ra giờ của máy chủ — UTC trên Vercel: "Sep 29, 01:03 PM" cho 20:03 giờ Việt
 * Nam, ngay dưới "Daily quotas reset" vốn đã là giờ địa phương (UAT production
 * 29/09). HTML đầu vẫn có chữ (giờ máy chủ) rồi đổi sau khi mount, để không
 * lệch hydrate.
 */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => formatDate(iso));
  useEffect(() => setText(formatDate(iso)), [iso]);
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
