import "server-only";

/**
 * Web push (P6 C1, F2; `approval.md` §7). One push per browser per new batch of cards, with no payload: payloads need
 * the aes128gcm encryption of RFC 8291, and a push that only says "look" needs nothing secret. The service worker
 * (`public/sw.js`) reads the waiting count itself, signed in, and opens the queue on a tap. A push never decides.
 *
 * Signed with VAPID (RFC 8292): an ES256 JWT for the push service's origin, from `VAPID_PUBLIC_KEY` and
 * `VAPID_PRIVATE_KEY` (base64url, the raw P-256 point and scalar, as `web-push generate-vapid-keys` prints them).
 * Only the push services `push_endpoint_allowed` names are called (the same list as SQL): an endpoint is a URL the
 * browser gave us, so anything else would be a request to an address someone chose.
 */

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPPORT_EMAIL } from "./email";

export const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/[^\s]+$/;

export type Vapid = { publicKey: string; key: KeyObject; subject: string };

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The VAPID pair from env; null when push is not set up here (an owner gate), so nothing is sent. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): Vapid | null {
  const pub = env.VAPID_PUBLIC_KEY?.trim() || env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  const point = fromB64url(pub);
  const d = fromB64url(priv);
  if (point.length !== 65 || point[0] !== 4 || d.length !== 32) return null;
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)), d: b64url(d) },
      format: "jwk",
    });
  } catch {
    // A mistyped key of the right length is not on the curve: "push is not set up", never a cron that throws every hour.
    console.error("[notify] VAPID keys are not a valid P-256 key pair");
    return null;
  }
  return { publicKey: b64url(point), key, subject: env.VAPID_SUBJECT?.trim() || `mailto:${SUPPORT_EMAIL}` };
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin, valid 12 hours. */
export function vapidAuthorization(vapid: Vapid, endpoint: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/** Sends one empty push; the push service's HTTP status (0 when it did not answer). Never throws for a refusal. */
export async function sendPush(vapid: Vapid, endpoint: string, doFetch: typeof fetch = fetch): Promise<number> {
  if (!PUSH_HOSTS.test(endpoint)) return 410;
  try {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { Authorization: vapidAuthorization(vapid, endpoint), TTL: "3600", Urgency: "normal", "Content-Length": "0" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** Pushes sent at once: one slow push service then costs one timeout per batch, not one per browser. */
export const PUSH_BATCH = 10;

/**
 * The cron's push round: every browser with cards newer than its last push gets one. Returns pushes accepted. No new
 * batch starts after `deadline` (ms since epoch), so the cron records what it sent before its own time runs out; the
 * browsers left over are still due on the next run.
 */
export async function pushNewCards(admin: SupabaseClient, vapid: Vapid, doFetch: typeof fetch = fetch, opts: { deadline?: number } = {}): Promise<number> {
  const { data, error } = await admin.rpc("push_due", { p_limit: 500 });
  if (error) throw new Error(`push_due: ${error.message}`);
  const rows = (data ?? []) as { subscription_id: string; endpoint: string }[];
  let sent = 0;
  for (let i = 0; i < rows.length; i += PUSH_BATCH) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    const statuses = await Promise.all(
      rows.slice(i, i + PUSH_BATCH).map(async (row) => {
        const status = await sendPush(vapid, row.endpoint, doFetch);
        const done = await admin.rpc("push_done", { p_subscription: row.subscription_id, p_status: status });
        if (done.error) console.warn("[notify] push_done", done.error.message);
        return status;
      }),
    );
    sent += statuses.filter((s) => s >= 200 && s < 300).length;
  }
  return sent;
}
