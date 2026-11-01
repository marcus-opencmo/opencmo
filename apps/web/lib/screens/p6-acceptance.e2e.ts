/**
 * P6 acceptance (plan F13, sessions/A.md A5) against a local Supabase with fake providers: no real model, Zernio,
 * Resend or push service. A founder with a connected X account and ten published posts → `pull_metrics` reads the
 * fake Zernio → Analytics and Dashboard results are live → the best hour replaces the default slot and the schedule
 * card says why → past ten cards a day the rest are held → the digest lands in the local mail catcher, once → one
 * push to a test subscription, through a fake push service → a Hacker News reply is checked three days on.
 *
 *     eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|INBUCKET_URL)=' | sed 's/^/export /')"
 *     NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
 *       SUPABASE_JWT_SECRET=$JWT_SECRET OPENCMO_AGENT_FAKE=1 OPENCMO_PUBLISH_FAKE=1 SCRAPECREATORS_API_KEY= \
 *       OPENCMO_DIGEST_LOCAL_MAIL=1 OPENCMO_LOCAL_MAIL_URL=$INBUCKET_URL \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p6-acceptance.e2e.ts
 *
 * Writes the digest email it sent to `docs/plans/cmo/2026-10-28-p6-acceptance/digest-email.html` for a look. Leaves
 * its founder in the database.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { createFakeAnalytics, type PublishAnalytics } from "@/lib/departments/publish/analytics";
import { clientFor } from "@/lib/mcp/auth";
import { emailSender } from "@/lib/notify/email";
import { pushNewCards, vapidFromEnv } from "@/lib/notify/push";
import { sendDigestEmail } from "@/lib/notify/send";

import { LOADERS } from "./load";
import { compose } from "./registry";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
assert.equal(process.env.OPENCMO_AGENT_FAKE, "1", "the acceptance run uses fake models and readers only");
const OUT = join(__dirname, "..", "..", "..", "..", "docs", "plans", "cmo", "2026-10-28-p6-acceptance");

const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  assert.equal(r.error, null, `${what}: ${r.error?.message}`);
  return r.data;
};

async function screen<N extends "analytics" | "dashboard" | "brain">(name: N, userId: string) {
  const loader = LOADERS[name] as (c: never) => Promise<object>;
  return compose(name, (await loader({ supabase: clientFor(userId), userId, params: new URLSearchParams({ range: "30" }) } as never)) as never, { production: true, sample: false });
}

const HOUR = (h: number, daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};

async function main() {
  const email = `p6-${randomUUID()}@test.local`;
  const created = await admin.auth.admin.createUser({ email, password: `pw-${randomUUID()}`, email_confirm: true });
  assert.equal(created.error, null);
  const userId = created.data.user!.id;
  await admin.from("profiles").update({ timezone: "UTC", credit_balance: 200 }).eq("id", userId);
  await admin.from("marketing_documents").insert([
    { user_id: userId, kind: "product", version: 1, created_by: "user", body: { name: "OpenCMO", one_liner: "An AI CMO for solo founders." } },
    { user_id: userId, kind: "strategy", version: 1, created_by: "user", body: { pains: ["editing demos takes hours"], avoid: [] } },
  ]);
  ok(await admin.rpc("zernio_profile_save", { p_user: userId, p_profile: `prof-${userId.slice(0, 8)}` }), "zernio profile");
  ok(await admin.rpc("social_account_save", { p_user: userId, p_platform: "x", p_handle: "@p6founder", p_avatar_url: null, p_zernio_account_id: `acc-${userId.slice(0, 8)}` }), "x account");
  const account = ok(await admin.from("social_accounts").select("id").eq("user_id", userId).single(), "account") as { id: string };

  // Ten X posts published through Zernio over the last two weeks: six at 14:00, four at 09:00 (the default slot).
  const order = ok(await admin.from("work_orders").insert({ user_id: userId, week: new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10), kind: "post_draft", title: "Posts", brief: {}, department: "writer", status: "done" }).select("id").single(), "order") as { id: string };
  const posts = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), at: HOUR(i < 6 ? 14 : 9, 2 + i), external: `zp-${i}` }));
  ok(await admin.from("content_items").insert(posts.map((p, i) => ({ id: p.id, user_id: userId, department: "post", platform: "X", day: p.at.slice(0, 10), idea: `Post ${i}`, status: "published", body: { text: `Published post number ${i}.` }, published_at: p.at }))), "posts");
  const deliverables = posts.map((p) => ({ id: randomUUID(), user_id: userId, order_id: order.id, kind: "post", ref_kind: "content_item", ref_id: p.id, status: "decided" }));
  ok(await admin.from("deliverables").insert(deliverables), "deliverables");
  ok(
    await admin.from("schedule_slots").insert(
      posts.map((p, i) => ({ user_id: userId, deliverable_id: deliverables[i]!.id, platform: "x", account_id: account.id, mode: "publish", publish_at: p.at, window_ends_at: new Date(Date.parse(p.at) + 15 * 60_000).toISOString(), status: "published", external_id: p.external })),
    ),
    "published slots",
  );

  // F5: pull_metrics through the fake Zernio (posts at 14:00 read far better), account days from the stock fake.
  const fake = createFakeAnalytics();
  const analytics: PublishAnalytics = {
    ...fake,
    posts: async ({ ids }) => (await fake.posts({ zernioProfileId: "", from: "", to: "", ids })).map((m) => ({ ...m, views: posts.find((p) => p.external === m.ids[0])!.at.includes("T14:") ? 5000 : 300 })),
  };
  ok(await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "pull_metrics", p_input: { source: "chat" } }), "pull_metrics queued");
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000, analytics });
  const run = ok(await admin.from("cmo_runs").select("status, output, error").eq("user_id", userId).eq("kind", "pull_metrics").single(), "run") as { status: string; output: Record<string, number>; error: unknown };
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(run.output.measured, 10, "ten posts measured by Zernio");
  assert.equal(run.output.account_days, 31);
  const analyticsScreen = await screen("analytics", userId);
  assert.ok(analyticsScreen.live.kpis && analyticsScreen.live.byAccount && analyticsScreen.live.posts, "Analytics is live");
  assert.ok((analyticsScreen.data.kpis.find((k) => k.key === "impressions")!.value ?? 0) > 0);
  assert.equal(analyticsScreen.data.byAccount[0]!.where.handle, "@p6founder");
  assert.equal(analyticsScreen.data.posts[0]!.impressions! >= analyticsScreen.data.posts.at(-1)!.impressions!, true, "best first");
  const dashboard = await screen("dashboard", userId);
  assert.ok(dashboard.live.results && dashboard.data.results.rows[0]!.series.some((v) => v !== null), "Dashboard results are live");
  console.log(`F5: 10 posts and 31 account days from the fake Zernio; impressions ${analyticsScreen.data.kpis[0]!.value}`);

  // F6: ten posts with numbers → the founder's own best hour; a new approved post is proposed at 14:00 and says why.
  assert.equal(run.output.best_hours, 2, "14:00 and 09:00 each have two posts or more");
  const next = ok(await admin.from("content_items").insert({ user_id: userId, department: "post", platform: "X", day: new Date().toISOString().slice(0, 10), idea: "Next", status: "in_review", body: { text: "The next post, to be scheduled." } }).select("id").single(), "next post") as { id: string };
  // Writer's post_draft order owns the post, as in production: approving it decides its deliverable.
  ok(await admin.from("deliverables").insert({ user_id: userId, order_id: order.id, kind: "post", ref_kind: "content_item", ref_id: next.id, status: "waiting_founder" }), "next deliverable");
  const card = ok(await admin.from("approvals").select("id, content_hash").eq("ref_id", next.id).eq("status", "waiting").single(), "post card") as { id: string; content_hash: string };
  ok(await clientFor(userId).rpc("approval_decide", { p_id: card.id, p_action: "approve", p_payload: { content_hash: card.content_hash, via: "app" } }), "approve the post");
  const slot = ok(await admin.from("schedule_slots").select("publish_at").eq("user_id", userId).eq("status", "proposed").single(), "proposed slot") as { publish_at: string };
  assert.equal(new Date(slot.publish_at).getUTCHours(), 14, "the best hour, not the default 09:00");
  const queued = (await screen("dashboard", userId)).data.queue.find((c) => c.body.kind === "schedule");
  assert.equal(queued?.body.kind === "schedule" ? queued.body.why : null, "Your posts on X do best around 2 pm.");
  console.log(`F6: proposed at ${slot.publish_at}; the card says "Your posts on X do best around 2 pm."`);

  // F4: past ten new cards today the rest are held, out of the queue.
  ok(await admin.from("content_items").insert(Array.from({ length: 11 }, (_, i) => ({ user_id: userId, department: "post", platform: "X", day: new Date().toISOString().slice(0, 10), idea: `Budget ${i}`, status: "in_review", body: { text: `Budget card number ${i}.` } }))), "eleven drafts");
  const budget = ok(await admin.from("card_budget").select("raised, held").eq("user_id", userId).single(), "budget") as { raised: number; held: number };
  const held = ok(await admin.from("approvals").select("id").eq("user_id", userId).eq("status", "held"), "held") as unknown[];
  assert.ok(held.length >= 2 && budget.held === held.length, `held ${held.length}, counter ${JSON.stringify(budget)}`);
  const queue = (await screen("dashboard", userId)).data.queue;
  assert.ok(queue.every((c) => c.status === "waiting"), "held cards are not in the queue");
  console.log(`F4: ${budget.raised} cards raised today, ${held.length} held until tomorrow; the queue shows ${queue.length}`);

  // F1: the digest in the local mail catcher, once a day, with the unsubscribe footer.
  const sender = emailSender();
  assert.equal(sender?.name, "local", "OPENCMO_DIGEST_LOCAL_MAIL=1 sends to the local mail catcher");
  const founder = { id: userId, email, timezone: "UTC", digest_hour: new Date().getUTCHours() };
  assert.ok(await sendDigestEmail(admin as never, sender!, founder, { appUrl: "http://127.0.0.1:3000", now: new Date() }), "the digest is sent");
  assert.equal(await sendDigestEmail(admin as never, sender!, founder, { appUrl: "http://127.0.0.1:3000", now: new Date() }), false, "once a day");
  const mail = (process.env.OPENCMO_LOCAL_MAIL_URL ?? "http://127.0.0.1:54324").replace(/\/$/, "");
  const list = (await (await fetch(`${mail}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
  assert.equal(list.messages.length, 1);
  const message = (await (await fetch(`${mail}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { HTML: string; Subject: string };
  assert.ok(message.HTML.includes("/app/inbox/") && message.HTML.includes("/unsubscribe?token=") && message.HTML.includes("support@opencmo.io"));
  writeFileSync(join(OUT, "digest-email.html"), message.HTML);
  console.log(`F1: "${message.Subject}" in the local mail catcher, sent once`);

  // F2: one push to a test subscription, through a fake push service; nothing more until a new card.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const b64 = (s: string) => Buffer.from(s, "base64url");
  const vapid = vapidFromEnv({ VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), b64(jwk.x!), b64(jwk.y!)]).toString("base64url"), VAPID_PRIVATE_KEY: jwk.d! })!;
  ok(await clientFor(userId).rpc("push_subscribe", { p_endpoint: `https://fcm.googleapis.com/fcm/send/p6-${userId.slice(0, 8)}`, p_p256dh: "B".repeat(87), p_auth: "a".repeat(22), p_user_agent: "acceptance" }), "subscribe");
  ok(await admin.from("push_subscriptions").update({ created_at: new Date(Date.now() - 86_400_000).toISOString() }).eq("user_id", userId), "an older subscription");
  const pushed: string[] = [];
  const pushService = (async (url: string | URL | Request, init?: RequestInit) => {
    pushed.push(`${String(url)} ${String((init?.headers as Record<string, string>).Authorization).slice(0, 8)}`);
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const sentPush = await pushNewCards(admin as never, vapid, pushService);
  assert.ok(sentPush >= 1 && pushed.some((p) => p.includes(userId.slice(0, 8)) && p.endsWith("vapid t=")), JSON.stringify(pushed));
  pushed.length = 0;
  await pushNewCards(admin as never, vapid, pushService);
  assert.ok(!pushed.some((p) => p.includes(userId.slice(0, 8))), "one push per batch");
  console.log("F2: one VAPID-signed push to the test subscription; none again until a new card");

  // F7: a Hacker News reply three days on (the fake discussion holds the founder's words).
  const opp = ok(await admin.from("opportunities").insert({ user_id: userId, platform: "hn", url: "https://news.ycombinator.com/item?id=1", community: "Hacker News", title: "Ask HN", score: 70, reply: "Thanks, I will try the reminder rule.", status: "replied", decided_at: new Date(Date.now() - 4 * 86_400_000).toISOString() }).select("id").single(), "opportunity") as { id: string };
  ok(await admin.from("cmo_draft_outcomes").insert({ user_id: userId, item_id: opp.id, department: "sales", action: "replied", decided_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), mentioned_product: false }), "outcome");
  await admin.from("cmo_runs").update({ status: "done" }).eq("user_id", userId).eq("kind", "pull_metrics");
  ok(await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "pull_metrics", p_input: { source: "chat" } }), "second pull_metrics");
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000, analytics });
  const outcome = ok(await admin.from("cmo_draft_outcomes").select("outcome_status, outcome_replies").eq("item_id", opp.id).single(), "checked outcome") as { outcome_status: string; outcome_replies: number };
  assert.deepEqual(outcome, { outcome_status: "found", outcome_replies: 0 });
  const memory = ok(await admin.from("cmo_memories").select("body").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).single(), "memory") as { body: string };
  assert.match(memory.body, /^A reply on Hacker News that only helped got no vote count and 0 replies/);
  console.log(`F7: the HN reply was found three days on; memory: "${memory.body}"`);

  console.log(`P6 acceptance passed for ${userId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
