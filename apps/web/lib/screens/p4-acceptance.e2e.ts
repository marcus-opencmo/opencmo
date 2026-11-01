/**
 * P4 acceptance (plan F11, sessions/A.md A4) against a local Supabase with the fake Zernio, no real posting: connect X
 * (fake OAuth) → approve a post → its schedule card → approve the time → the sweep fires it → `publish_post` posts it
 * through the adapter → Zernio's signed webhook confirms it → Published, with its link on the calendar. Then a slot
 * missed past its window (a new card says why), a post the platform refuses (Retry on its card) and a LinkedIn post
 * with no account (copy-and-open card → "I posted it").
 *
 *     set -a && . ./e2e.env && set +a     # NEXT_PUBLIC_SUPABASE_URL, *_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *     OPENCMO_PUBLISH_FAKE=1 OPENCMO_PUBLISH_FAKE_CONFIRM=webhook ZERNIO_WEBHOOK_SECRET=acceptance \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p4-acceptance.e2e.ts
 *
 * Runs the sweep (`schedule_claim_due`) and the CMO queue the way Modal and `/api/internal/cmo/run` do, decides cards
 * the way the app does (`approval_decide` under the founder's session) and sends the webhook through the route's own
 * handler. A short with media needs the worker (`publish_media`, B4's tests cover the stream and its peak RSS). The
 * screenshots at 1440 and 390 come from `npm run test:e2e:schedule` on the same stack. Leaves its founder in the
 * database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { connectUrl, finishConnect } from "@/lib/departments/publish/accounts";
import { accountsStore } from "@/lib/departments/publish/accounts-store";
import { publishAdapter } from "@/lib/departments/publish/adapter";
import { signZernio } from "@/lib/departments/publish/webhook";
import { handleZernioWebhook } from "@/lib/departments/publish/webhook-handle";
import { clientFor } from "@/lib/mcp/auth";

import { LOADERS } from "./load";
import { compose } from "./registry";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SECRET = process.env.ZERNIO_WEBHOOK_SECRET ?? "";
assert.equal(process.env.OPENCMO_PUBLISH_FAKE, "1", "the acceptance run posts through the fake Zernio only");
assert.ok(SECRET, "set ZERNIO_WEBHOOK_SECRET");

type Slot = { id: string; status: string; mode: string; platform: string; publish_at: string; approval_id: string | null; external_id: string | null; external_url: string | null; error: { code?: string; message?: string } | null };
const slotOf = async (deliverable: string) =>
  ((await admin.from("schedule_slots").select("id, status, mode, platform, publish_at, approval_id, external_id, external_url, error").eq("deliverable_id", deliverable).order("created_at", { ascending: false }).limit(1).maybeSingle()).data as Slot | null);

async function decide(userId: string, cardId: string, action: string, extra: Record<string, unknown> = {}) {
  const { data: card } = await admin.from("approvals").select("content_hash").eq("id", cardId).single();
  const { error } = await clientFor(userId).rpc("approval_decide", { p_id: cardId, p_action: action, p_payload: { content_hash: card!.content_hash, via: "app", ...extra } });
  assert.equal(error, null, `${action} ${cardId}: ${error?.message}`);
}

/** A post Writer left for the founder under its order, approved: Schedule proposes its slot (A3). */
async function approvedPost(userId: string, orderId: string, platform: string, text: string): Promise<{ item: string; deliverable: string; slot: Slot }> {
  const item = randomUUID();
  assert.equal((await admin.from("content_items").insert({ id: item, user_id: userId, department: "post", platform, day: new Date().toISOString().slice(0, 10), idea: text, status: "in_review", body: { text, alternates: [] } })).error, null);
  const { data: d } = await admin.from("deliverables").insert({ user_id: userId, order_id: orderId, kind: "post", ref_kind: "content_item", ref_id: item, status: "waiting_founder" }).select("id").single();
  const { data: card } = await admin.from("approvals").select("id").eq("ref_kind", "content_item").eq("ref_id", item).eq("status", "waiting").single();
  await decide(userId, card!.id, "approve");
  const slot = await slotOf(d!.id);
  assert.ok(slot?.approval_id, `${platform}: the approved post got a slot and a schedule card`);
  return { item, deliverable: d!.id, slot };
}

/**
 * Brings an approved slot's time to now without touching what was approved: the time moves through the card (a new
 * card, approved again) to the earliest allowed, then the jitter (not part of the hash) pulls it in.
 */
async function makeDue(userId: string, slot: Slot): Promise<Slot> {
  const soon = new Date(Date.now() + 5.5 * 60_000).toISOString();
  // The calendar's move (`/schedule/slots/[id]`): an approved slot has no waiting card to decide.
  const { error } = await clientFor(userId).rpc("schedule_change", { p_slot: slot.id, p_action: "change_time", p_payload: { publish_at: soon } });
  assert.equal(error, null, `change_time: ${error?.message}`);
  const moved = (await admin.from("schedule_slots").select("approval_id").eq("id", slot.id).single()).data!;
  await decide(userId, moved.approval_id!, "approve");
  // Earlier than publish_at by up to the jitter's range; the window still starts at publish_at's own minute.
  await admin.from("schedule_slots").update({ jitter_seconds: -240 }).eq("id", slot.id);
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    await admin.rpc("schedule_claim_due");
    const s = (await admin.from("schedule_slots").select("id, status, mode, platform, publish_at, approval_id, external_id, external_url, error").eq("id", slot.id).single()).data as Slot;
    if (s.status !== "waiting") return s;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("the slot never came due");
}

async function main() {
  // A founder and a Writer order, as onboarding and the week's plan leave them.
  const email = `p4-${randomUUID()}@test.local`;
  const created = await admin.auth.admin.createUser({ email, password: `pw-${randomUUID()}`, email_confirm: true });
  assert.equal(created.error, null);
  const userId = created.data.user!.id;
  await admin.from("profiles").update({ timezone: "UTC" }).eq("id", userId);
  await admin.from("marketing_documents").insert({ user_id: userId, kind: "product", version: 1, created_by: "user", body: { name: "OpenCMO", one_liner: "An AI CMO for solo founders." } });
  const week = new Date();
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const { data: order } = await admin.from("work_orders").insert({ user_id: userId, week: week.toISOString().slice(0, 10), kind: "post_draft", title: "Posts", brief: {}, department: "writer", status: "waiting_founder" }).select("id").single();

  // F1: connect X through the fake OAuth, the way Settings → Accounts and the callback do.
  const deps = { adapter: publishAdapter(), store: accountsStore(clientFor(userId)), userId };
  const link = new URL(await connectUrl(deps, "x", "http://127.0.0.1:3000/api/v1/accounts/callback"));
  const done = await finishConnect(deps, link.searchParams);
  assert.equal(done.kind, "connected", "X is connected");
  const settings = compose("settings", (await (LOADERS.settings as (c: never) => Promise<object>)({ supabase: clientFor(userId), userId, params: new URLSearchParams() } as never)) as never, { production: true, sample: false });
  assert.ok(settings.data.accounts.some((a) => a.platform === "x" && a.status === "connected"), "Settings shows X connected");

  // F3–F7: approve a post → schedule card → approve the time → the sweep fires → publish_post → webhook → Published.
  const first = await approvedPost(userId, order!.id, "X", "Cut a demo by deleting words. No timeline.");
  assert.equal(first.slot.mode, "publish");
  await decide(userId, first.slot.approval_id!, "approve");
  const due = await makeDue(userId, first.slot);
  assert.equal(due.status, "due", "the sweep claimed it");
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000 });
  const accepted = (await slotOf(first.deliverable))!;
  assert.equal(accepted.status, "publishing", "Zernio took it; the webhook confirms");
  assert.ok(accepted.external_id);
  const event = JSON.stringify({
    id: `evt_${randomUUID()}`,
    event: "post.platform.published",
    post: { id: accepted.external_id, metadata: { opencmoSlotId: accepted.id } },
    platform: { name: "twitter", platformPostId: accepted.external_id, publishedUrl: `https://x.com/founder/status/${Date.now()}` },
    account: { accountId: (await admin.from("social_accounts").select("zernio_account_id").eq("user_id", userId).single()).data!.zernio_account_id },
  });
  const db = { rpc: (name: string, args: Record<string, unknown>) => admin.rpc(name, args), releaseReceipt: async () => undefined };
  assert.equal((await handleZernioWebhook(event, signZernio(event, SECRET), SECRET, db)).status, 200);
  assert.deepEqual((await handleZernioWebhook(event, signZernio(event, SECRET), SECRET, db)).body, { ok: true, replay: true }, "a replay changes nothing");
  const published = (await slotOf(first.deliverable))!;
  assert.equal(published.status, "published");
  assert.ok(published.external_url?.startsWith("https://x.com/"));
  assert.equal((await admin.from("content_items").select("status").eq("id", first.item).single()).data?.status, "published");
  const schedule = compose("schedule", (await (LOADERS.schedule as (c: never) => Promise<object>)({ supabase: clientFor(userId), userId, params: new URLSearchParams({ from: published.publish_at.slice(0, 10) }) } as never)) as never, { production: true, sample: false });
  assert.ok(schedule.data.slots.some((s) => s.id === published.id && s.status === "posted" && s.url === published.external_url), "the calendar links the post");
  console.log("F3–F7: posted at its time, confirmed by the webhook, linked on the calendar");

  // Never late: a waiting slot past its window is missed; a new card proposes a new time and says why.
  const second = await approvedPost(userId, order!.id, "X", "Most AI video tools stop at the first draft.");
  await decide(userId, second.slot.approval_id!, "approve");
  await admin.from("schedule_slots").update({ window_ends_at: new Date(Date.now() - 1000).toISOString() }).eq("id", second.slot.id);
  await admin.rpc("schedule_claim_due");
  assert.equal((await admin.from("schedule_slots").select("status").eq("id", second.slot.id).single()).data?.status, "missed");
  const again = (await slotOf(second.deliverable))!;
  assert.ok(again.id !== second.slot.id && again.status === "proposed" && again.error?.code === "missed", "a new time is proposed, with the reason");
  console.log("missed: never posted late, a new card asks again");

  // A refusal: the fake refuses `[fake:invalid]`; the failure card's Retry reuses the approval while the window lasts.
  const third = await approvedPost(userId, order!.id, "X", "A post the platform refuses. [fake:invalid]");
  await decide(userId, third.slot.approval_id!, "approve");
  await makeDue(userId, third.slot);
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000 });
  const refused = (await slotOf(third.deliverable))!;
  assert.equal(refused.status, "failed");
  assert.match(refused.error?.message ?? "", /refused/);
  const failureCard = (await admin.from("approvals").select("id, status").eq("id", refused.approval_id!).single()).data!;
  assert.equal(failureCard.status, "waiting", "the failure has its card");
  await decide(userId, failureCard.id, "retry");
  assert.equal((await admin.from("schedule_slots").select("status").eq("id", refused.id).single()).data?.status, "waiting", "Retry puts it back in line");
  console.log("failed: the card says why; Retry");

  // F9: no LinkedIn account. At its time the copy-and-open card comes; "I posted it" publishes the post.
  const fourth = await approvedPost(userId, order!.id, "LinkedIn", "Why we built the editor before anything else.");
  assert.equal(fourth.slot.mode, "intent");
  await decide(userId, fourth.slot.approval_id!, "approve");
  const reminded = await makeDue(userId, fourth.slot);
  assert.equal(`${reminded.status}:${reminded.error?.code}`, "failed:no_account");
  const copyCard = (await admin.from("approvals").select("id, expires_at").eq("id", reminded.approval_id!).single()).data!;
  assert.equal(copyCard.expires_at, null, "the copy-and-open card waits for the founder");
  const { error } = await clientFor(userId).rpc("schedule_mark_posted", { p_slot: reminded.id });
  assert.equal(error, null);
  assert.equal((await admin.from("content_items").select("status").eq("id", fourth.item).single()).data?.status, "published");
  console.log("F9: copy and open, I posted it");

  console.log(`P4 acceptance passed for ${email}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
