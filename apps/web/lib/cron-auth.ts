import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * So bearer token theo thời gian hằng.
 *
 * `!==` trên chuỗi dừng ở byte đầu tiên khác nhau, nên thời gian trả lời rò ra
 * đúng bao nhiêu ký tự đầu đã đúng — đoán được từng byte một. Độ dài so trước
 * vì `timingSafeEqual` ném khi lệch độ dài — và độ dài của secret không phải bí
 * mật đáng giữ.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Cron route chạy bằng service role: đóng khi THIẾU secret trên production,
 * không chỉ khi sai secret. Bỏ trống chỉ chấp nhận lúc chạy local.
 */
export function cronAuthorized(authorization: string | null, label: string): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error(`[cron] ${label}: thiếu CRON_SECRET — từ chối`);
      return false;
    }
    console.warn(`[cron] ${label}: không có CRON_SECRET — chỉ chấp nhận vì đang chạy local`);
    return true;
  }
  return bearerMatches(authorization, secret);
}
