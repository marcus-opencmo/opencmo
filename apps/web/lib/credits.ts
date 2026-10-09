/**
 * Hằng số credit dùng chung — KHÔNG `server-only`.
 *
 * Tách khỏi `lib/pricing.ts` vì file đó đọc `process.env.POLAR_*` ở thân module
 * và đã được khoá bằng `server-only`. Hai con số dưới đây thì màn tạo job cần
 * để biết có nên hiện tường mua gói hay không, và màn đó là client component.
 *
 * Không có gì bí mật ở đây: chúng là luật tính tiền mà người dùng phải thấy.
 */

/** 1 credit = 1 phút video nguồn. Xem VISION.md §4. */
export const CREDITS_PER_MINUTE = 1;

/** Giữ tạm lúc tạo job — phải TRÙNG `job_hold_credits()` trong SQL. */
export const JOB_HOLD_CREDITS = 10;
