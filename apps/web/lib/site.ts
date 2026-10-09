/**
 * Địa chỉ gốc của site — một chỗ cho canonical, sitemap, RSS, JSON-LD.
 *
 * Mặc định `https://opencmo.io`: build preview của Vercel không đặt biến này
 * thì canonical vẫn trỏ về domain thật, không để Google index bản preview.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://opencmo.io").replace(/\/$/, "");

export const SITE_NAME = "OpenCMO";

export const SITE_DESCRIPTION =
  "OpenCMO is an AI CMO for founders: it learns your business from your website and runs three departments — Video, Post and Sales — that draft your marketing for you to approve.";

/** Email hỗ trợ — phải TRÙNG email khai với bên thanh toán (Polar/Creem đối chiếu khi duyệt). */
export const SUPPORT_EMAIL = "support@opencmo.io";

export function absoluteUrl(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * `openGraph` của một trang THAY HẲN bản của layout (Next không gộp sâu), nên
 * trang nào khai `openGraph` phải trải lại các trường chung này.
 */
export const OG_DEFAULTS = { siteName: SITE_NAME, locale: "en_US" } as const;
