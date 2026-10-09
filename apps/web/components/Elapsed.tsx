"use client";

import { useEffect, useState } from "react";

import { formatClock } from "@/lib/format";

/** Quá mốc này thì nói thêm một câu trấn an. 3 phút là ngân sách của engine. */
const SLOW_AFTER_SECONDS = 240;

/**
 * Đồng hồ đếm từ lúc job được tạo.
 *
 * Vì sao cần: màn hình "Processing" là màn hình người dùng nhìn LÂU NHẤT trong
 * cả sản phẩm — 2–3 phút — và nó không có gì chuyển động ngoài một chấm nhấp
 * nháy. Không có cách nào biết job còn sống hay đã treo.
 *
 * Vì sao chỉ đếm giờ chứ không có thanh tiến trình: worker không ghi tiến trình
 * từng bước vào DB, nên mọi thanh phần trăm ở đây đều là bịa. Thời gian đã trôi
 * là con số DUY NHẤT ta biết chắc, và nó đủ để trả lời câu người dùng đang hỏi.
 *
 * Render rỗng ở phía server rồi mới hiện sau khi hydrate: giờ của server và của
 * trình duyệt không bao giờ khớp tuyệt đối, in thẳng ra sẽ thành cảnh báo
 * hydration mismatch ngay ở màn hình quan trọng nhất.
 */
export function Elapsed({ since }: { since: string }) {
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    const started = new Date(since).getTime();
    const tick = () => setSeconds(Math.max(0, (Date.now() - started) / 1000));

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);

  if (seconds === null) return null;

  return (
    <span className="tabular-nums">
      {formatClock(seconds)} elapsed
      {seconds > SLOW_AFTER_SECONDS && " · taking longer than usual. Check the latest status before retrying."}
    </span>
  );
}
