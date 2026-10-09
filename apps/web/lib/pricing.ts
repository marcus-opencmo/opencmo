/**
 * Gói và giá. Một chỗ duy nhất — bảng giá, trang billing và webhook cùng đọc.
 *
 * Hai điều copy từ Opus Clip (OPUSCLIP.md §3.10) vì chúng đã được thị trường
 * kiểm chứng:
 *   1. Giá gạch ngang THƯỜNG TRỰC (gói năm: $80 → $60), không phải khuyến mãi có hạn.
 *   2. Bậc rẻ nhất đã bỏ watermark. Watermark chỉ để ép qua ngưỡng trả tiền
 *      ĐẦU TIÊN, không dùng để phân biệt các bậc trả phí.
 */

// `checkoutUrl` và `productId` đọc `process.env.POLAR_*` ở NGAY thân module.
// Hôm nay file này chỉ có ba caller phía server, nhưng một card giá là đúng kiểu
// file bị đổi sang `"use client"` sáu tháng sau — lúc đó hai trường trên lặng lẽ
// thành `undefined`, và cách sửa tự nhiên nhất là đổi tên biến thành
// `NEXT_PUBLIC_*`, tức công bố product id của Polar. `server-only` biến kịch bản
// đó thành lỗi build.
//
// Cái giá: `check:polar` và `check:pricing` chạy ngoài Next nên phải bật
// `--conditions=react-server` (xem `package.json`) để nó resolve về `empty.js`.
import "server-only";

export type PlanId = "free" | "starter" | "creator";

export type Plan = {
  id: PlanId;
  name: string;
  /** Giá gốc, để gạch ngang. Bỏ trống nếu không có. */
  listPrice?: number;
  /** Giá quy ra mỗi tháng — số in to trên landing và billing. */
  price: number;
  /** Chu kỳ thu tiền. Gói năm thu `price * 12` một lần (`billedPrice`). */
  interval: "month" | "year";
  billedPrice: number;
  credits: number;
  previewsPerDay: number;
  exportsPerDay: number;
  /** Trần chiều cao export editor; client không được tự nâng vượt gói. */
  maxExportResolution: 720 | 1080;
  watermark: boolean;
  features: string[];
  /** Link checkout của Polar. Bỏ trống thì nút chuyển thành "sắp có". */
  checkoutUrl?: string;
  productId?: string;
  highlight?: boolean;
  quota: { previews: number; exports: number; storageBytes: number; storageObjects: number };
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    interval: "month",
    billedPrice: 0,
    credits: 30,
    previewsPerDay: 20,
    exportsPerDay: 5,
    maxExportResolution: 720,
    watermark: true,
    quota: { previews: 20, exports: 5, storageBytes: 2 * 1024 ** 3, storageObjects: 200 },
    // Gói `free` KHÔNG còn là một bậc dùng được: nó là trạng thái "chưa mua".
    // Quà đăng ký đã bỏ (migration 20260921150000), nên nói đúng như vậy thay
    // vì liệt kê tính năng của một thứ không chạy được.
    features: [
      "No monthly credits — pick a plan to add more",
      "Auto captions, face-tracked 9:16",
      "Watermarked clips",
      "Account deleted 30 days after sign-up unless you buy a plan",
    ],
  },
  // Landing v3 (08/10/2026): MỘT giá — $80 trả tháng, $60/tháng trả năm ($720). Hai gói
  // giữ id `starter`/`creator` vì `plan_quota`, `process_polar_event` và constraint
  // `polar_subscriptions_plan_check` khoá cứng hai id này; đổi id là một migration riêng.
  // Giá thu thật nằm ở product của Polar: phải sửa product cho khớp trước khi deploy.
  // CHƯA XONG: webhook cộng `credits` một lần mỗi `order.paid`, nên gói năm hiện chỉ nhận
  // 400 credit cho CẢ NĂM. Cần cộng theo tháng cho gói năm (migration + Polar) trước khi bán.
  {
    id: "starter",
    name: "Monthly",
    price: 80,
    interval: "month",
    billedPrice: 80,
    credits: 150,
    previewsPerDay: 100,
    exportsPerDay: 30,
    maxExportResolution: 1080,
    watermark: false,
    quota: { previews: 100, exports: 30, storageBytes: 10 * 1024 ** 3, storageObjects: 1000 },
    features: [
      "AI CMO + Video, Post and Sales departments",
      "150 credits per month",
      "No watermark, full-resolution 1080×1920 download",
    ],
    checkoutUrl: process.env.POLAR_CHECKOUT_STARTER,
    productId: process.env.POLAR_PRODUCT_STARTER,
  },
  {
    id: "creator",
    name: "Annual",
    listPrice: 80,
    price: 60,
    interval: "year",
    billedPrice: 720,
    credits: 400,
    previewsPerDay: 300,
    exportsPerDay: 100,
    maxExportResolution: 1080,
    watermark: false,
    quota: { previews: 300, exports: 100, storageBytes: 25 * 1024 ** 3, storageObjects: 2500 },
    highlight: true,
    features: [
      "Everything in Monthly, billed $720 once a year",
      "Priority processing queue",
    ],
    checkoutUrl: process.env.POLAR_CHECKOUT_CREATOR,
    productId: process.env.POLAR_PRODUCT_CREATOR,
  },
];

// Hai hằng số này sống ở `lib/credits.ts` vì màn tạo job (client component)
// cần chúng, còn file này thì `server-only`. Re-export để caller phía server
// không phải nhớ chúng nằm ở đâu.
export { CREDITS_PER_MINUTE, JOB_HOLD_CREDITS } from "./credits";

/**
 * Link checkout kèm danh tính người mua.
 *
 * `customer_external_id` là `profiles.id`. Webhook khớp bằng nó TRƯỚC email
 * (`process_polar_event`, migration 20260921140000): email là chuỗi người mua
 * tự gõ ở trang Polar, và gõ khác email đăng nhập nghĩa là tiền vào mà credit
 * không bao giờ cộng — im lặng, vì route trả 200 nên Polar không gửi lại.
 *
 * `customer_email` chỉ để điền sẵn ô cho đỡ phải gõ; nó KHÔNG phải thứ quyết
 * định chủ tài khoản nữa.
 */
export function checkoutUrlFor(
  plan: Plan,
  userId: string,
  email?: string | null,
): string | undefined {
  if (!plan.checkoutUrl) return undefined;
  try {
    const url = new URL(plan.checkoutUrl);
    url.searchParams.set("customer_external_id", userId);
    if (email) url.searchParams.set("customer_email", email);
    return url.toString();
  } catch {
    // `POLAR_CHECKOUT_*` điền sai dạng: trả nguyên văn thay vì làm chết nút.
    // Người mua vẫn tới được Polar, chỉ là rơi về nhánh khớp bằng email.
    return plan.checkoutUrl;
  }
}

export function planById(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** Giá landing đọc từ đây: tháng = gói `starter`, năm = gói `creator`. */
export function offerPrices(): { monthly: number; annual: number; annualBilled: number } {
  const monthly = planById("starter")!, annual = planById("creator")!;
  return { monthly: monthly.price, annual: annual.price, annualBilled: annual.billedPrice };
}

/** Tìm gói theo product id của Polar. Webhook dựa vào đây để biết cộng bao nhiêu. */
export function planByProductId(productId: string): Plan | undefined {
  return PLANS.find((p) => p.productId && p.productId === productId);
}
