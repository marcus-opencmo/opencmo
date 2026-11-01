/**
 * Polar's webhook signature: the key is the secret's UTF-8 bytes, as Polar's SDK signs; the base64-decoded key keeps
 * working (review R3).
 *
 *     tsx lib/polar-signature.check.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifySignature } from "./polar";

const secret = "polar_whs_0123456789abcdefABCDEF";
const body = JSON.stringify({ type: "order.paid", data: { id: "o1" } });
const id = "msg_1";
const timestamp = String(Math.floor(Date.now() / 1000));
const sign = (key: Buffer) => createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

// As Polar signs: Buffer.from(secret, "utf8").
assert.deepEqual(verifySignature(body, { id, timestamp, signature: `v1,${sign(Buffer.from(secret, "utf8"))}` }, secret), { ok: true });
// A secret stored base64-encoded, as before.
const b64 = Buffer.from("raw-key-bytes").toString("base64");
assert.deepEqual(verifySignature(body, { id, timestamp, signature: `v1,${sign(Buffer.from(b64, "base64"))}` }, b64), { ok: true });
// During a rotation two signatures come; one match is enough.
assert.deepEqual(verifySignature(body, { id, timestamp, signature: `v1,AAAA v1,${sign(Buffer.from(secret, "utf8"))}` }, secret), { ok: true });
// Someone else's key, a changed body, an old timestamp: refused.
assert.equal(verifySignature(body, { id, timestamp, signature: `v1,${sign(Buffer.from("another secret", "utf8"))}` }, secret).ok, false);
assert.equal(verifySignature(`${body} `, { id, timestamp, signature: `v1,${sign(Buffer.from(secret, "utf8"))}` }, secret).ok, false);
const old = String(Math.floor(Date.now() / 1000) - 3600);
assert.equal(verifySignature(body, { id, timestamp: old, signature: `v1,${sign(Buffer.from(secret, "utf8"))}` }, secret).ok, false);

console.log("polar-signature.check ok");
