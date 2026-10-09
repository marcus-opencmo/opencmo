/** Kiểm handler thật với Supabase local; không nhận credentials/provider từ .env. */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { isLoopbackUrl, localSupabaseCredentials } from "./local-supabase";

async function main() {
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "POLAR_CHECK_BASE_URL"]) {
    if (process.env[name] && !isLoopbackUrl(process.env[name]!)) {
      throw new Error(`Refusing non-loopback ${name}.`);
    }
  }
  const local = localSupabaseCredentials({ cwd: process.cwd() });
  process.env.NEXT_PUBLIC_SUPABASE_URL = local.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = local.serviceRoleKey;
  process.env.POLAR_PRODUCT_STARTER = "polar-check-starter";
  process.env.POLAR_PRODUCT_CREATOR = "polar-check-creator";
  const secret = Buffer.from(randomUUID()).toString("base64");
  process.env.POLAR_WEBHOOK_SECRET = secret;
  const { POST } = await import("../app/api/webhooks/polar/route");
  const db = createClient(local.url, local.serviceRoleKey, { auth: { persistSession: false } });
  const suffix = randomUUID();
  const email = `polar-${suffix}@test.local`;
  const customer = `customer-${suffix}`;
  const order = `order-${suffix}`;
  const subscription = `subscription-${suffix}`;
  const { data: user, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  assert.equal(error, null);
  const uid = user.user!.id;
  let checks = 0;
  const failures: string[] = [];
  async function check(name: string, run: () => Promise<void>) {
    try { await run(); checks++; } catch (err) { failures.push(`${name}: ${String(err)}`); }
  }
  const payload = (type = "order.paid", extra: Record<string, unknown> = {}, at = "2026-09-20T10:00:00Z") => ({
    type, timestamp: at, data: {
      id: type.startsWith("subscription.") ? subscription : order,
      customer_id: customer, customer: { id: customer, email },
      product_id: "polar-check-starter", total_amount: 1500, currency: "usd",
      subscription_id: subscription, current_period_end: "2026-10-20T10:00:00Z",
      modified_at: at, ...extra,
    },
  });
  async function send(event: unknown, id = randomUUID(), seconds = 0, badSignature = false) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000) + seconds);
    const signature = createHmac("sha256", Buffer.from(secret, "base64"))
      .update(`${id}.${timestamp}.${body}`).digest("base64");
    const response = await POST(new NextRequest("http://127.0.0.1/api/webhooks/polar", {
      method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${badSignature ? "invalid" : signature}` },
    }));
    return { status: response.status, body: await response.json() };
  }
  async function profile() {
    const res = await db.from("profiles").select("plan,credit_balance,polar_customer_id").eq("id", uid).single();
    assert.equal(res.error, null); return res.data!;
  }
  try {
    await check("invalid signature", async () => assert.equal((await send(payload(), randomUUID(), 0, true)).status, 401));
    await check("old signature", async () => assert.equal((await send(payload(), randomUUID(), -301)).status, 401));
    await check("future signature", async () => assert.equal((await send(payload(), randomUUID(), 301)).status, 401));
    await check("unknown event", async () => assert.equal((await send({ type: "unknown.event" })).body.ignored, "unknown.event"));
    await check("unmapped customer without email", async () => assert.ok((await send(payload("order.paid", { customer: null, customer_id: `unknown-${suffix}` }))).body.skipped));
    await check("unmapped paid product requests a retry", async () => {
      const res = await send(payload("order.paid", {
        id: `${order}-unmapped-paid`, product_id: "polar-check-retired",
      }));
      assert.ok(res.status >= 500 && res.status < 600, `expected retryable non-2xx, got ${res.status}`);
    });
    await check("missing customer and email", async () => {
      const res = await send(payload("order.paid", { customer: null, customer_id: null }));
      assert.equal(res.status, 200); assert.ok(res.body.skipped);
    });
    // Số dư dưới đây là BỘI SỐ THUẦN của 150 (gói starter). Trước hard paywall
    // chúng lệch 30 vì `handle_new_user()` tặng credit lúc đăng ký; migration
    // `20260921150000_hard_paywall.sql` bỏ hẳn món quà đó, nên tài khoản mới
    // bắt đầu từ 0 và mọi con số ở đây chỉ còn là tiền đã mua.
    await check("three sequential deliveries", async () => {
      const id = randomUUID();
      for (let i = 0; i < 3; i++) assert.equal((await send(payload(), id)).status, 200);
      assert.equal((await profile()).credit_balance, 150);
    });
    await check("three concurrent deliveries", async () => {
      const id = randomUUID();
      const event = payload("order.paid", { id: `${order}-concurrent` });
      const responses = await Promise.all([send(event, id), send(event, id), send(event, id)]);
      assert.ok(responses.every(r => r.status === 200));
      assert.equal((await profile()).credit_balance, 300);
    });
    await check("business order dedup across event ids", async () => {
      await Promise.all([send(payload()), send(payload()), send(payload())]);
      assert.equal((await profile()).credit_balance, 300);
    });
    await check("activation never grants credits", async () => {
      assert.equal((await send(payload("subscription.active"))).status, 200);
      assert.equal((await profile()).credit_balance, 300);
      assert.equal((await profile()).plan, "starter");
    });
    await check("mapped customer without email", async () => {
      const res = await send(payload("order.paid", { id: `${order}-noemail`, customer: null }));
      assert.equal(res.status, 200); assert.equal(res.body.skipped, undefined);
      assert.equal((await profile()).credit_balance, 450);
    });
    await check("cancel retains entitlement", async () => {
      await send(payload("subscription.canceled", {}, "2026-09-20T11:00:00Z"));
      assert.equal((await profile()).plan, "starter");
    });
    await check("revocation and old activation", async () => {
      await send(payload("subscription.revoked", {}, "2026-09-20T12:00:00Z"));
      await send(payload("subscription.active", {}, "2026-09-20T10:30:00Z"));
      await send(payload("subscription.canceled", {}, "2026-09-20T11:30:00Z"));
      assert.equal((await profile()).plan, "free");
      assert.equal((await profile()).credit_balance, 450);
    });
    await check("refund replay and partial before full", async () => {
      const partial = payload("order.refunded", { refunded_amount: 500, refunded_tax_amount: 0 });
      await send(partial); await send(partial);
      await send(payload("order.refunded", { refunded_amount: 1500, refunded_tax_amount: 0 }));
      await send(partial);
      const res = await db.from("polar_purchases").select("refunded_amount").eq("order_id", order).single();
      assert.equal(res.error, null); assert.equal(res.data!.refunded_amount, 1500);
      assert.equal((await profile()).credit_balance, 450);
    });
    await check("grant ledger exactly one per purchase", async () => {
      const res = await db.from("credit_ledger").select("id").eq("user_id", uid).like("external_id", "polar:%");
      assert.equal(res.error, null); assert.equal(res.data!.length, 3);
    });
    await check("new purchase with concurrent distinct events and activation", async () => {
      const freshOrder = `${order}-business-race`;
      const paid = payload("order.paid", { id: freshOrder });
      const active = payload("subscription.active", { id: `${subscription}-fresh` });
      const responses = await Promise.all([send(paid), send(paid), send(paid), send(active)]);
      assert.ok(responses.every(r => r.status === 200));
      assert.equal((await profile()).credit_balance, 600);
      const ledger = await db.from("credit_ledger").select("id").eq("external_id", `polar:${freshOrder}`);
      assert.equal(ledger.error, null); assert.equal(ledger.data!.length, 1);
    });
    await check("malformed signed payload", async () => assert.equal((await send({ type: "order.paid", data: null })).status, 400));
    for (const activeFirst of [false, true]) {
      await check(`purchase and entitlement plans differ, activeFirst=${activeFirst}`, async () => {
        const subId = `${subscription}-upgrade-${activeFirst}`;
        const orderId = `${order}-upgrade-${activeFirst}`;
        const before = (await profile()).credit_balance;
        const version = "2026-09-21T10:00:00Z";
        const paid = payload("order.paid", {
          id: orderId, subscription: { id: subId, product_id: "polar-check-creator",
            status: "active", modified_at: version },
        }, "2026-09-22T10:00:00Z");
        const active = payload("subscription.active", {
          id: subId, product_id: "polar-check-creator",
        }, version);
        for (const event of activeFirst ? [active, paid] : [paid, active]) {
          assert.equal((await send(event)).status, 200);
          const sub = await db.from("polar_subscriptions").select("plan").eq("subscription_id", subId).single();
          assert.equal(sub.error, null); assert.equal(sub.data!.plan, "creator");
          assert.equal((await profile()).plan, "creator");
        }
        assert.equal((await profile()).credit_balance, before + 150);
        const purchase = await db.from("polar_purchases").select("plan,credits").eq("order_id", orderId).single();
        assert.equal(purchase.error, null); assert.deepEqual(purchase.data, { plan: "starter", credits: 150 });
      });
    }
    await check("unknown snapshot product does not overwrite known entitlement or consume its version", async () => {
      const subId = `${subscription}-upgrade-true`;
      const before = (await profile()).credit_balance;
      const res = await send(payload("order.paid", { id: `${order}-unknown-snapshot`,
        subscription: { id: subId, product_id: "unmapped-subscription-product", status: "active",
          modified_at: "2026-09-23T10:00:00Z" },
      }));
      assert.equal(res.status, 200);
      const sub = await db.from("polar_subscriptions").select("plan,provider_updated_at").eq("subscription_id", subId).single();
      assert.equal(sub.error, null); assert.equal(sub.data!.plan, "creator");
      assert.equal(Date.parse(sub.data!.provider_updated_at), Date.parse("2026-09-21T10:00:00Z"));
      assert.equal((await profile()).credit_balance, before + 150);
    });
    await check("envelope without timestamp still grants once", async () => {
      // Standard Webhooks đặt mốc thời gian ở header đã ký, body không bắt buộc
      // có `timestamp`. Từ chối ở đây là tiền vào mà credit không bao giờ cộng.
      const event: { type: string; timestamp?: string; data: Record<string, unknown> } =
        payload("order.paid", { id: `${order}-no-envelope-timestamp` });
      delete event.timestamp;
      const before = (await profile()).credit_balance;
      assert.equal((await send(event)).status, 200);
      assert.equal((await profile()).credit_balance, before + 150);
    });
    await check("lifecycle of unmapped product is skipped, not retried forever", async () => {
      const before = await profile();
      const res = await send(payload("subscription.revoked", {
        id: `${subscription}-unmapped`, product_id: "polar-check-retired",
      }, "2026-09-24T10:00:00Z"));
      assert.equal(res.status, 200);
      assert.equal(res.body.skipped, "unmapped subscription product");
      assert.equal((await profile()).plan, before.plan);
    });
  } finally {
    // Xoá đúng fixture đã tạo; ledger tài chính giữ lại dạng mất định danh theo D4.
    const removed = await db.auth.admin.deleteUser(uid);
    assert.equal(removed.error, null);
  }
  if (failures.length) throw new Error(`${failures.length} failed; ${checks} passed\n${failures.join("\n")}`);
  console.log(`Polar: ${checks} checks passed (real handler + local Supabase).`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
