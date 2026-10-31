/**
 * Web push (P6 C1) without network: the VAPID JWT verifies with the public key and names the push service's origin,
 * only the allowed push services are called, and the cron round records each answer (404/410 drop the browser).
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/notify/push.check.ts
 */
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { PUSH_BATCH, PUSH_HOSTS, pushNewCards, sendPush, vapidAuthorization, vapidFromEnv } from "./push";

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function main() {
  // A key pair in the format `web-push generate-vapid-keys` prints.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]));
  const env = { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: jwk.d! };
  assert.equal(vapidFromEnv({}), null, "no keys, no push");
  assert.equal(vapidFromEnv({ ...env, VAPID_PRIVATE_KEY: "short" }), null, "a malformed key is refused");
  const vapid = vapidFromEnv(env)!;

  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  const auth = vapidAuthorization(vapid, endpoint, Date.UTC(2026, 9, 31));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
  assert.ok(m, auth);
  assert.equal(m[4], pub);
  const claims = JSON.parse(fromB64url(m[2]!).toString()) as { aud: string; exp: number; sub: string };
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:support@opencmo.io");
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: createPublicKey(publicKey.export({ format: "pem", type: "spki" })), dsaEncoding: "ieee-p1363" }, fromB64url(m[3]!)), "the signature verifies");

  // Only the allowed push services; the same list as SQL's push_endpoint_allowed.
  for (const ok of [endpoint, "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/QXk", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(PUSH_HOSTS.test(ok), ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://169.254.169.254/latest", "https://example.com/push"]) assert.ok(!PUSH_HOSTS.test(bad), bad);
  const calls: string[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)} ${init?.method} ${(init?.headers as Record<string, string>).TTL}`);
    return new Response(null, { status: String(url).includes("gone") ? 410 : 201 });
  }) as typeof fetch;
  assert.equal(await sendPush(vapid, "https://example.com/push", fake), 410, "an endpoint off the list is never called");
  assert.equal(calls.length, 0);
  assert.equal(await sendPush(vapid, endpoint, fake), 201);
  assert.equal(calls[0], `${endpoint} POST 3600`);

  // The cron round: one push each, every answer recorded.
  const done: [string, number][] = [];
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "push_due") return { data: [{ subscription_id: "s1", endpoint }, { subscription_id: "s2", endpoint: "https://fcm.googleapis.com/fcm/send/gone" }], error: null };
      done.push([String(args.p_subscription), Number(args.p_status)]);
      return { data: true, error: null };
    },
  };
  assert.equal(await pushNewCards(admin as never, vapid, fake), 1);
  assert.deepEqual(done.sort(), [["s1", 201], ["s2", 410]]);

  // Many browsers go out in batches of ten at once; past the deadline no new batch starts (the rest stay due).
  let inFlight = 0;
  let most = 0;
  const slow = (async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const many = (n: number) => ({
    rpc: async (name: string) =>
      name === "push_due" ? { data: Array.from({ length: n }, (_, i) => ({ subscription_id: `s${i}`, endpoint })), error: null } : { data: true, error: null },
  });
  assert.equal(await pushNewCards(many(25) as never, vapid, slow), 25);
  assert.equal(most, PUSH_BATCH, "ten at a time");
  assert.equal(await pushNewCards(many(25) as never, vapid, slow, { deadline: Date.now() - 1 }), 0, "past the deadline: none started");

  console.log("push: VAPID JWT, allowed push services, one push each and every answer recorded");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
