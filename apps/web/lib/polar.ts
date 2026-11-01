/**
 * Verifies Polar's webhooks.
 *
 * Polar uses Standard Webhooks: the signature is HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>`. The key
 * is the secret's UTF-8 bytes (see `verifySignature`).
 *
 * Written by hand instead of adding a library: about 30 lines, on the path money comes in, where every line is worth
 * understanding. See ARCHITECTURE.md §2 on adding dependencies.
 *
 * The body MUST be the raw one, before JSON.parse: parsing and stringifying again changes key order and whitespace,
 * and the signature fails with no obvious reason.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The clock skew allowed, so an old signature cannot be replayed. */
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

  // Polar signs with the secret's raw UTF-8 bytes (its SDK base64-encodes the secret before handing it to Standard
  // Webhooks, which decodes it again). The base64-decoded key is still accepted, so a secret stored that way keeps
  // working; both keys come from our own secret, so accepting either lets nobody else sign.
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keys = [Buffer.from(secret, "utf8"), Buffer.from(raw, "base64")];
  const signed = `${id}.${timestamp}.${body}`;
  const expected = keys.map((key) => createHmac("sha256", key).update(signed).digest());

  // The header holds several signatures separated by spaces (two while Polar rotates a key); one match is enough.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (expected.some((e) => given.length === e.length && timingSafeEqual(given, e))) {
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
