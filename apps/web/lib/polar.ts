/**
 * Xác thực webhook của Polar.
 *
 * Polar dùng chuẩn Standard Webhooks: chữ ký là HMAC-SHA256 của chuỗi
 * `<webhook-id>.<webhook-timestamp>.<body thô>`, khóa là secret đã base64.
 *
 * Tự viết thay vì thêm thư viện: đúng 30 dòng, và nó nằm trên đường tiền vào —
 * chỗ đáng đọc hiểu từng dòng nhất trong cả app. Xem ARCHITECTURE.md §2 về việc
 * thêm dependency.
 *
 * BẮT BUỘC dùng body THÔ, chưa qua JSON.parse: parse rồi stringify lại sẽ đổi
 * thứ tự khóa và khoảng trắng, chữ ký lập tức sai mà không rõ vì sao.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Lệch giờ tối đa cho phép, để chữ ký cũ không dùng lại được. */
const TOLERANCE_SECONDS = 5 * 60;

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function verifySignature(
  body: string,
  headers: WebhookHeaders,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing webhook-id/timestamp/signature header" };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(Date.now() / 1000 - sentAt) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp too old or in the future" };
  }

  // Polar phát secret dạng `whsec_<base64>`; dashboard đôi khi hiện cả tiền tố.
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(raw, "base64");

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();

  // Header chứa nhiều chữ ký cách nhau bởi dấu cách (Polar xoay khóa thì có 2).
  // Khớp một cái là đủ.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "signature mismatch" };
}

/** Lấy product id từ payload — Polar đặt nó ở vài chỗ khác nhau tùy loại event. */
export function productIdOf(data: Record<string, unknown>): string | null {
  const direct = data.product_id;
  if (typeof direct === "string") return direct;

  const product = data.product as { id?: unknown } | undefined;
  if (product && typeof product.id === "string") return product.id;

  const items = data.items as Array<{ product_id?: unknown }> | undefined;
  if (Array.isArray(items) && typeof items[0]?.product_id === "string") {
    return items[0].product_id as string;
  }

  return null;
}
