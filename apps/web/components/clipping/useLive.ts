"use client";

/**
 * Nghe thay đổi của một hàng qua Supabase Realtime.
 *
 * Vì sao Realtime chứ không hỏi lại mỗi vài giây: một job chạy 2–3 phút, polling
 * 3 giây là ~60 request cho một job. Realtime là một kết nối, và trạng thái tới
 * ngay khi worker ghi.
 *
 * Payload của Realtime KHÔNG phải nguồn sự thật — nó chỉ kích `onChange`, và
 * `onChange` đọc lại qua `api()` dưới RLS. Tin payload là tin một kênh không đi
 * qua RLS của bảng, và nó cũng không có các trường ta ghép thêm ở route.
 */

import { useEffect, useRef } from "react";

import { createClient } from "@/lib/supabase/client";

/** Gộp nhiều sự kiện dồn dập thành một lần đọc lại. */
const DEBOUNCE_MS = 300;
/** Realtime có thể bỏ lỡ event dù channel vẫn báo SUBSCRIBED. */
const FALLBACK_MS = 5000;

export function useLive(
  table: "jobs" | "clips" | "tasks" | "media_assets",
  filter: string | null,
  onChange: () => void,
  enabled = true,
  poll = true,
  /**
   * Phân biệt hai chỗ nghe CÙNG bảng + filter (chip job ở top bar và thư viện):
   * Supabase dùng lại channel trùng tên, và thêm callback vào một channel đã
   * subscribe là ném lỗi làm sập cả màn.
   */
  scope = "",
): void {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!enabled || !filter) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const fallback = poll ? setInterval(() => latest.current(), FALLBACK_MS) : null;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => latest.current(), DEBOUNCE_MS);
    };

    // Trình duyệt bóp `setInterval` ở tab nền xuống một lần mỗi phút, và
    // WebSocket của Realtime có thể đã rụng trong lúc đó. Quay lại tab mà phải
    // chờ hết một chu kỳ mới thấy trạng thái đúng là cách chắc nhất để người
    // dùng nghĩ job đang treo — trong khi worker đã xong từ lâu.
    const onVisible = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    const supabase = createClient();
    const channel = supabase
      .channel(`live-${table}-${filter}${scope ? `-${scope}` : ""}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter }, fire)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      if (fallback) clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [table, filter, enabled, poll, scope]);
}
