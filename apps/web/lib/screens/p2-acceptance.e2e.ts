/**
 * P2 acceptance (plan F10, sessions/A.md A6) against a local Supabase, a local worker and fake providers, no real
 * money: plan with a video → card 1 → approve → card 2 → approve → render → card 3 → approve (finished) → shorts
 * batch card → approve → three `short` deliverables.
 *
 *     set -a && . ./e2e.env && set +a     # NEXT_PUBLIC_SUPABASE_URL, *_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *     # in another shell: the worker (`npm run dev` starts one), with OPENCMO_AI_FAKE=1
 *     OPENCMO_AGENT_FAKE=1 OPENCMO_AI_FAKE=1 ANTHROPIC_API_KEY= GEMINI_API_KEY= \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p2-acceptance.e2e.ts
 *
 * Decides every card the way the app does (`approval_decide` under the founder's session) and runs the brain's
 * Studio order runner the way `/api/internal/cmo/run` does. Leaves its founder in the database.
 */
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { drainStudioOrders } from "@/lib/cmo/jobs/studio-orders";
import { clientFor } from "@/lib/mcp/auth";

import type { ApprovalCard } from "./approval-card";
import { LOADERS } from "./load";
import { compose, type ScreenName } from "./registry";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const minutes = (n: number) => n * 60_000;

async function screen<N extends ScreenName>(name: N, userId: string) {
  const loader = LOADERS[name] as (ctx: never) => Promise<object>;
  const loaded = await loader({ supabase: clientFor(userId), userId, params: new URLSearchParams() } as never);
  return compose(name, loaded as never, { production: true, sample: false });
}

/** Runs the Studio queue (and lets the worker work) until `done` holds, or fails with what the order says. */
async function until<T>(what: string, userId: string, done: () => Promise<T | null | undefined>, timeout = minutes(8)): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await drainStudioOrders(admin as never, { budgetMs: 30_000 });
    const value = await done();
    if (value) return value;
    const { data: failed } = await admin.from("work_orders").select("title, error").eq("user_id", userId).eq("status", "failed").in("kind", ["build_video", "cut_shorts"]);
    if (failed?.length) throw new Error(`${what}: order failed: ${JSON.stringify(failed)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${what}: timed out`);
}

async function waitingCard(userId: string, kind: ApprovalCard["kind"]): Promise<ApprovalCard | null> {
  const dashboard = await screen("dashboard", userId);
  return dashboard.data.queue.find((c) => c.kind === kind) ?? null;
}

export async function run(): Promise<void> {
  assert.equal(process.env.OPENCMO_AGENT_FAKE, "1", "run with fake providers");
  assert.equal(process.env.OPENCMO_AI_FAKE, "1", "run with fake media");
  const email = `p2-acceptance-${Date.now()}@test.local`;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  assert.ifError(created.error);
  const userId = created.data.user!.id;
  const me = clientFor(userId);
  const log: string[] = [];
  const step = (line: string) => {
    log.push(line);
    console.log(`  ✓ ${line}`);
  };
  const decide = async (card: ApprovalCard, action: string, payload: Record<string, unknown> = {}) => {
    const { error } = await me.rpc("approval_decide", { p_id: card.id, p_action: action, p_payload: { ...payload, content_hash: card.contentHash, via: "app" } });
    assert.ifError(error);
  };

  for (const [kind, body] of Object.entries({
    product: { name: "OpenCMO", one_liner: "An AI CMO for solo founders: an editor, post drafts and Reddit leads you approve." },
    strategy: { icp: "Solo founders who ship software", pains: ["editing product demos takes longer than building them"], voice: "Plain and direct" },
    content_strategy: { pillars: [{ name: "Editing by words", ideas: ["Cut a video by deleting words"] }] },
  })) {
    const { error } = await me.rpc("save_marketing_document", { p_kind: kind, p_body: body });
    assert.ifError(error);
  }
  await admin.from("profiles").update({ credit_balance: 2000, plan: "creator" }).eq("id", userId);
  step("onboarded: documents, creator plan, 2000 credits");

  // The plan holds one video → a build_video order.
  const { error: enqueueError } = await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "plan_week", p_input: { source: "e2e", brief: "Launch week: make 1 video" } });
  assert.ifError(enqueueError);
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000 });
  const { data: videoOrders } = await admin.from("work_orders").select("id, status, department").eq("user_id", userId).eq("kind", "build_video");
  assert.equal(videoOrders?.length, 1, "one video order");
  step("plan_week planned one video: a queued Studio order");

  // Card 1.
  const card1 = await until("card 1", userId, () => waitingCard(userId, "script"));
  assert.ok(card1.body.kind === "script" && card1.body.beats.length > 0, "card 1 shows the storyboard");
  const studio1 = await screen("studio", userId);
  assert.ok(studio1.data.items.some((i) => i.kind === "video" && i.approvalId === card1.id), "Studio shows the video waiting on card 1");
  assert.ok(studio1.data.team?.steps.some((s) => s.state === "running"), "the Video team panel is live");
  step(`card 1: ${card1.body.kind === "script" ? card1.body.beats.length : 0} beats, keyframes ${card1.priceCredits ?? 0} credits`);
  const stale = await me.rpc("approval_decide", { p_id: card1.id, p_action: "approve", p_payload: { content_hash: "0".repeat(64), via: "app" } });
  assert.match(stale.error?.message ?? "", /changed/, "a stale card is refused");

  // Edit a beat: card 1 closes as edited and comes back with the founder's words (no Director runs).
  const words = "Cut a demo video by deleting the words you do not want.";
  await decide(card1, "edit", { beat: 0, text: words });
  const edited = await until("card 1 edited", userId, async () => {
    const card = await waitingCard(userId, "script");
    return card && card.id !== card1.id ? card : null;
  });
  assert.ok(edited.body.kind === "script" && edited.body.beats[0]?.words === words, "the new card 1 has the edited beat");
  step("edited a beat: card 1 came back with the founder's words");
  await decide(edited, "approve");
  step("approved card 1 (a stale hash was refused first)");

  // Card 2 once the keyframes are made; redo one keyframe, then the new contact sheet.
  const sheet = await until("card 2", userId, () => waitingCard(userId, "price"), minutes(10));
  assert.ok(sheet.body.kind === "price" && sheet.body.keyframes.length > 0, "card 2 shows the contact sheet");
  await decide(sheet, "redo", { index: 1 });
  const card2 = await until("card 2 after a redo", userId, async () => {
    const card = await waitingCard(userId, "price");
    return card && card.id !== sheet.id ? card : null;
  }, minutes(10));
  assert.ok(card2.body.kind === "price" && card2.body.keyframes.length === (sheet.body.kind === "price" ? sheet.body.keyframes.length : 0), "the same sheet, one keyframe made again");
  step("redid keyframe 2: a new contact sheet");
  step(`card 2: ${card2.body.kind === "price" ? card2.body.keyframes.length : 0} keyframes, video ${card2.priceCredits ?? 0} credits`);
  await decide(card2, "approve");
  step("approved card 2");

  // Card 3 once shots, voice and the render are done.
  const card3 = await until("card 3", userId, () => waitingCard(userId, "finished_video"), minutes(15));
  assert.ok(card3.body.kind === "finished_video" && card3.body.previewUrl, "card 3 plays the render");
  step(`card 3: rendered, ${card3.body.kind === "finished_video" ? Math.round(card3.body.seconds) : 0} s`);
  await decide(card3, "approve");
  const { data: video } = await admin.from("work_orders").select("status").eq("id", videoOrders![0]!.id).single();
  assert.equal(video?.status, "done", "the video order is done");
  step("approved card 3: the edit is finished, the video order is done");

  // The rule orders shorts; the squad cuts and renders them; the batch card.
  const batchCard = await until("shorts batch", userId, () => waitingCard(userId, "shorts_batch"), minutes(15));
  assert.ok(batchCard.body.kind === "shorts_batch", "a batch card");
  const shorts = batchCard.body.kind === "shorts_batch" ? batchCard.body.shorts : [];
  step(`shorts batch card: ${shorts.length} shorts (${shorts.map((s) => `${Math.round(s.end - s.start)} s “${s.hook}”`).join(", ")})`);
  await decide(batchCard, "approve");
  const { data: delivered } = await admin.from("deliverables").select("kind, status").eq("user_id", userId).eq("kind", "short");
  assert.equal(delivered?.length, shorts.length, "one short deliverable per short");
  assert.ok(delivered!.every((d) => d.status === "ready"), "ready for Schedule");
  step(`approved the batch: ${delivered!.length} short deliverables ready for Schedule`);

  const studio = await screen("studio", userId);
  assert.ok(studio.data.items.some((i) => i.kind === "video" && i.status === "finished"), "Studio shows the finished video");
  assert.ok(studio.data.items.some((i) => i.kind === "short" && i.status === "finished"), "and the approved shorts");
  step("Studio shows the finished video and the approved shorts live");

  console.log(`\np2-acceptance.e2e — P2 end to end for ${email}: ${log.length} steps passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
