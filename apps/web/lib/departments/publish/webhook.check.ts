/**
 * Zernio webhook: signature (bad, missing, wrong secret), the signed event id used against replays, and the
 * mapping of each event to a slot or account update.
 *
 *     cd apps/web && npx tsx lib/departments/publish/webhook.check.ts
 */
import assert from "node:assert/strict";

import { parseZernioEvent, signZernio, verifyZernioSignature, WebhookPayloadError } from "./webhook";
import { handleZernioWebhook, type WebhookDb } from "./webhook-handle";

const SECRET = "whsec_test";
const SLOT = "00000000-0000-4000-8000-0000000000b1";

const published = JSON.stringify({
  id: "evt_1",
  event: "post.platform.published",
  timestamp: "2026-11-02T09:00:05Z",
  post: { id: "post_1", status: "published", metadata: { opencmoSlotId: SLOT }, platforms: [{ platform: "tiktok", accountId: "acc_tt" }] },
  platform: { name: "tiktok", status: "published", platformPostId: "7300", publishedUrl: "https://www.tiktok.com/@f/video/7300" },
  account: { accountId: "acc_tt", platform: "tiktok", username: "f" },
});

// Signature: exact HMAC of the raw body; anything else is refused.
const sig = signZernio(published, SECRET);
assert.ok(verifyZernioSignature(published, sig, SECRET));
assert.ok(verifyZernioSignature(published, sig.toUpperCase(), SECRET));
assert.ok(!verifyZernioSignature(published, null, SECRET));
assert.ok(!verifyZernioSignature(published, sig, ""), "no secret configured: nothing is accepted");
assert.ok(!verifyZernioSignature(published, signZernio(published, "other"), SECRET));
assert.ok(!verifyZernioSignature(published + " ", sig, SECRET), "a changed body fails");
assert.ok(!verifyZernioSignature(published, `sha256=${sig}`, SECRET));
assert.ok(!verifyZernioSignature(published, "abc", SECRET));

// Published → the slot, with its link and the account it went through.
assert.deepEqual(parseZernioEvent(published), {
  kind: "slot",
  eventId: "evt_1",
  slotId: SLOT,
  zernioAccountId: "acc_tt",
  platform: "tiktok",
  status: "published",
  externalId: "7300",
  url: "https://www.tiktok.com/@f/video/7300",
  error: null,
});

// Failed → a reason in plain words; X arrives as `twitter`.
const failed = parseZernioEvent(
  JSON.stringify({
    id: "evt_2",
    event: "post.platform.failed",
    post: { id: "post_2", metadata: { opencmoSlotId: SLOT } },
    platform: { name: "twitter", status: "failed", error: "Duplicate\ncontent" },
    account: { accountId: "acc_x", platform: "twitter" },
  }),
);
assert.ok(failed.kind === "slot" && failed.status === "failed" && failed.platform === "x" && failed.error === "The platform refused the post: Duplicate content");

const cancelled = parseZernioEvent(JSON.stringify({ id: "evt_3", event: "post.cancelled", post: { id: "p", metadata: { opencmoSlotId: SLOT }, platforms: [{ platform: "linkedin", accountId: "acc_li" }] } }));
assert.ok(cancelled.kind === "slot" && cancelled.status === "failed" && cancelled.zernioAccountId === "acc_li" && cancelled.platform === "linkedin");

// A javascript: or http link never becomes the slot's link.
const sneaky = parseZernioEvent(published.replace("https://www.tiktok.com/@f/video/7300", "javascript:alert(1)"));
assert.ok(sneaky.kind === "slot" && sneaky.url === null);

// Account disconnected at Zernio (revoked on the platform).
assert.deepEqual(parseZernioEvent(JSON.stringify({ id: "evt_4", event: "account.disconnected", account: { accountId: "acc_x" } })), {
  kind: "account",
  eventId: "evt_4",
  zernioAccountId: "acc_x",
  status: "disconnected",
});

// Not ours or not needed: acknowledged, nothing changes.
assert.equal(parseZernioEvent(JSON.stringify({ id: "e5", event: "post.published", post: { metadata: { opencmoSlotId: SLOT } } })).kind, "ignored");
assert.equal(parseZernioEvent(JSON.stringify({ id: "e6", event: "post.platform.published", post: { metadata: {} } })).kind, "ignored");
// Review R3: "published" carries the account the SQL check compares, from `account` or the post's first target; none at all is refused.
{
  const noTop = JSON.parse(published) as Record<string, unknown>;
  delete noTop.account;
  const fromTarget = parseZernioEvent(JSON.stringify(noTop));
  assert.ok(fromTarget.kind === "slot" && fromTarget.zernioAccountId === "acc_tt");
  const none = { ...noTop, post: { id: "post_1", metadata: { opencmoSlotId: SLOT } } };
  assert.throws(() => parseZernioEvent(JSON.stringify(none)), WebhookPayloadError);
}
assert.equal(parseZernioEvent(JSON.stringify({ id: "e7", event: "post.platform.published", post: { metadata: { opencmoSlotId: "1; drop" } } })).kind, "ignored");
assert.equal(parseZernioEvent(JSON.stringify({ id: "e8", event: "webhook.test", test: true })).kind, "ignored");

// Not an event at all.
for (const bad of ["not json", "[]", JSON.stringify({ event: "post.published" }), JSON.stringify({ id: "x".repeat(201), event: "e" })]) {
  assert.throws(() => parseZernioEvent(bad), WebhookPayloadError);
}

// The route's handler: receipts against replays, each event to its RPC, a failed apply gives its receipt back.
function fakeDb(fail?: { code?: string; message: string }) {
  const receipts = new Set<string>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: WebhookDb = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "zernio_receipt_claim") {
        const id = args.p_event_id as string;
        const fresh = !receipts.has(id);
        receipts.add(id);
        return { data: fresh, error: null };
      }
      return { data: null, error: fail ?? null };
    },
    releaseReceipt: async (id) => void receipts.delete(id),
  };
  return { db, calls, receipts };
}

async function handlerChecks() {
  const send = (body: string, db: WebhookDb, signature = signZernio(body, SECRET)) => handleZernioWebhook(body, signature, SECRET, db);

  const unsigned = fakeDb();
  assert.equal((await send(published, unsigned.db, "0".repeat(64))).status, 401);
  assert.equal((await handleZernioWebhook(published, null, SECRET, unsigned.db)).status, 401);
  assert.equal(unsigned.calls.length, 0, "nothing is read before the signature checks out");
  assert.equal((await send("not json", unsigned.db)).status, 400);

  const ok = fakeDb();
  assert.deepEqual(await send(published, ok.db), { status: 200, body: { ok: true } });
  const status = ok.calls.find((c) => c.name === "publish_status")!;
  assert.deepEqual(status.args, {
    p_slot: SLOT,
    p_status: "published",
    p_external_id: "7300",
    p_url: "https://www.tiktok.com/@f/video/7300",
    p_error: null,
    p_zernio_account_id: "acc_tt",
  });
  // The same signed body again: refused by its id, nothing applied twice.
  assert.deepEqual(await send(published, ok.db), { status: 200, body: { ok: true, replay: true } });
  assert.equal(ok.calls.filter((c) => c.name === "publish_status").length, 1);

  const failedBody = JSON.stringify({ id: "evt_f", event: "post.platform.failed", post: { id: "p", metadata: { opencmoSlotId: SLOT } }, platform: { name: "x", error: "Duplicate" }, account: { accountId: "acc_x" } });
  const f = fakeDb();
  await send(failedBody, f.db);
  const fs = f.calls.find((c) => c.name === "publish_status")!.args;
  assert.equal(fs.p_status, "failed");
  assert.deepEqual(fs.p_error, { code: "refused", message: "The platform refused the post: Duplicate", retryable: true });

  const acct = fakeDb();
  await send(JSON.stringify({ id: "evt_a", event: "account.disconnected", account: { accountId: "acc_x" } }), acct.db);
  assert.deepEqual(acct.calls.at(-1), { name: "social_account_mark", args: { p_zernio_account_id: "acc_x", p_status: "disconnected" } });

  const ignored = fakeDb();
  assert.deepEqual(await send(JSON.stringify({ id: "evt_i", event: "post.published" }), ignored.db), { status: 200, body: { ok: true, ignored: "post.published" } });

  // A slot we do not have (or another account's): acknowledged, not retried.
  const gone = fakeDb({ code: "P0002", message: "Slot not found." });
  assert.equal((await send(published, gone.db)).status, 200);
  // A database hiccup: 500, and the receipt is given back so Zernio's retry is applied.
  const down = fakeDb({ message: "connection reset" });
  assert.equal((await send(published, down.db)).status, 500);
  assert.equal(down.receipts.has("evt_1"), false);
}

handlerChecks().then(
  () => console.log("zernio webhook checks passed"),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
