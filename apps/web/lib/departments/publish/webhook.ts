/**
 * Zernio's webhook, the pure part (P4 B5): the signature and what an event means for a slot or an account.
 * The route (`app/api/webhooks/zernio/route.ts`) adds the receipt and the status RPC.
 *
 * Zernio signs the raw body with HMAC-SHA256 (lowercase hex in `X-Zernio-Signature`, key `ZERNIO_WEBHOOK_SECRET`)
 * and does not sign a timestamp or the `X-Zernio-Event-Id` header. So replays are refused by the event id
 * inside the signed body (`id`), never by the header alone: a captured body resent under a new header id
 * still carries its old signed id.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { fromZernioSlug, platformReason } from "./zernio";
import type { PublishPlatform } from "./types";

/** Zernio's largest post event is a few KB; the route refuses more before hashing it. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signZernio(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyZernioSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;
  const given = signature.trim().toLowerCase();
  if (!HEX64.test(given)) return false;
  return timingSafeEqual(Buffer.from(signZernio(rawBody, secret), "hex"), Buffer.from(given, "hex"));
}

/** What one event changes. `ignored` events are acknowledged (200) so Zernio stops retrying them. */
export type ZernioUpdate =
  | {
      kind: "slot";
      eventId: string;
      /** `metadata.opencmoSlotId` we sent with the post. */
      slotId: string;
      /** The account Zernio posted through: the status RPC checks it is the slot's account. */
      zernioAccountId: string | null;
      platform: PublishPlatform | null;
      status: "published" | "failed";
      externalId: string | null;
      url: string | null;
      /** English, for the failed card. */
      error: string | null;
    }
  | { kind: "account"; eventId: string; zernioAccountId: string; status: "disconnected" }
  | { kind: "ignored"; eventId: string; event: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export class WebhookPayloadError extends Error {}

/** Parses a verified body. Throws `WebhookPayloadError` for a body that is not a Zernio event at all. */
export function parseZernioEvent(rawBody: string): ZernioUpdate {
  let body: Json;
  try {
    body = obj(JSON.parse(rawBody));
  } catch {
    throw new WebhookPayloadError("Invalid webhook payload.");
  }
  const eventId = str(body.id);
  const event = str(body.event);
  if (!eventId || eventId.length > 200 || !event) throw new WebhookPayloadError("Invalid webhook payload.");
  if (body.test === true) return { kind: "ignored", eventId, event };

  if (event === "post.platform.published" || event === "post.platform.failed" || event === "post.cancelled") {
    const post = obj(body.post);
    const slotId = str(obj(post.metadata).opencmoSlotId);
    // A post we did not make (made in Zernio's dashboard, or another app on the key): nothing of ours changes.
    if (!slotId || !UUID.test(slotId)) return { kind: "ignored", eventId, event };
    const platform = obj(body.platform);
    const account = obj(body.account);
    const firstTarget = Array.isArray(post.platforms) ? obj(post.platforms[0]) : {};
    const url = str(platform.publishedUrl);
    if (event === "post.platform.published") {
      return {
        kind: "slot",
        eventId,
        slotId,
        zernioAccountId: str(account.accountId),
        platform: fromZernioSlug(str(platform.name) ?? str(account.platform) ?? ""),
        status: "published",
        externalId: str(platform.platformPostId) ?? str(post.id),
        url: url && url.startsWith("https://") && url.length <= 1000 ? url : null,
        error: null,
      };
    }
    const reason = event === "post.cancelled" ? "The post was cancelled at the posting service." : platformReason(platform.error);
    return {
      kind: "slot",
      eventId,
      slotId,
      zernioAccountId: str(account.accountId) ?? str(firstTarget.accountId),
      platform: fromZernioSlug(str(platform.name) ?? str(account.platform) ?? str(firstTarget.platform) ?? ""),
      status: "failed",
      externalId: null,
      url: null,
      error: reason && event !== "post.cancelled" ? `The platform refused the post: ${reason}` : (reason ?? "The platform refused the post."),
    };
  }

  if (event === "account.disconnected") {
    const zernioAccountId = str(obj(body.account).accountId);
    if (!zernioAccountId) throw new WebhookPayloadError("Invalid webhook payload.");
    return { kind: "account", eventId, zernioAccountId, status: "disconnected" };
  }

  // post.published / post.failed / post.partial repeat what the per-platform events said; the rest is not ours.
  return { kind: "ignored", eventId, event };
}
