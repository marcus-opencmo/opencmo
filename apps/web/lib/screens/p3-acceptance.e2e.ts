/**
 * P3 acceptance (plan F10, sessions/A.md A4) against a local Supabase, a local worker and fake providers, no real
 * money: the plan holds X, Threads and LinkedIn posts and a video → three post cards, each on its own platform →
 * approve one as written, edit one, skip one → voice notes in Writer and Library → Writer's brief feeds the video →
 * cards 1–3 → captions on the finished video's card (one edited there) → shorts batch card with its captions →
 * captions delivered under the video and the shorts.
 *
 *     set -a && . ./e2e.env && set +a     # NEXT_PUBLIC_SUPABASE_URL, *_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *     # in another shell: the worker (`npm run dev` starts one), with OPENCMO_AI_FAKE=1
 *     OPENCMO_AGENT_FAKE=1 OPENCMO_AI_FAKE=1 ANTHROPIC_API_KEY= GEMINI_API_KEY= \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/p3-acceptance.e2e.ts
 *
 * Needs Session B's B4 (the `write_video_brief` and `write_caption` jobs). Decides every card the way the app does
 * (`approval_decide` under the founder's session), runs the CMO queue and the Studio runner the way
 * `/api/internal/cmo/run` does, and labels the LinkedIn edit the way the nightly classifier does. The screenshots at
 * 1440 and 390 come from `npm run test:e2e:writer` (Session C's live specs) on the same stack. Leaves its founder in
 * the database.
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
const today = new Date().toISOString().slice(0, 10);

async function screen<N extends ScreenName>(name: N, userId: string) {
  const loader = LOADERS[name] as (ctx: never) => Promise<object>;
  const loaded = await loader({ supabase: clientFor(userId), userId, params: new URLSearchParams() } as never);
  return compose(name, loaded as never, { production: true, sample: false });
}

/** Runs the CMO queue and the Studio runner (and lets the worker work) until `done` holds. */
async function until<T>(what: string, userId: string, done: () => Promise<T | null | undefined>, timeout = minutes(8)): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 30_000 });
    await drainStudioOrders(admin as never, { budgetMs: 30_000 });
    const value = await done();
    if (value) return value;
    const { data: failed } = await admin
      .from("work_orders")
      .select("kind, title, error")
      .eq("user_id", userId)
      .eq("status", "failed")
      .in("kind", ["build_video", "cut_shorts", "write_video_brief", "write_caption"]);
    if (failed?.length) throw new Error(`${what}: order failed: ${JSON.stringify(failed)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${what}: timed out`);
}

async function waitingCards(userId: string, kind: ApprovalCard["kind"]): Promise<ApprovalCard[]> {
  const dashboard = await screen("dashboard", userId);
  return dashboard.data.queue.filter((c) => c.kind === kind);
}

export async function run(): Promise<void> {
  assert.equal(process.env.OPENCMO_AGENT_FAKE, "1", "run with fake providers");
  assert.equal(process.env.OPENCMO_AI_FAKE, "1", "run with fake media");
  const email = `p3-acceptance-${Date.now()}@test.local`;
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
    const { data, error } = await me.rpc("approval_decide", { p_id: card.id, p_action: action, p_payload: { ...payload, content_hash: card.contentHash, via: "app" } });
    assert.ifError(error);
    return data as { status: string; content_hash: string };
  };

  for (const [kind, body] of Object.entries({
    product: { name: "OpenCMO", one_liner: "An AI CMO for solo founders: an editor, post drafts and Reddit leads you approve." },
    strategy: { icp: "Solo founders who ship software", pains: ["editing product demos takes longer than building them"], voice: "Plain and direct" },
    content_strategy: {
      pillars: [{ name: "Editing by words", ideas: ["Cut a video by deleting words"] }],
      cadence: "X every day; the same idea on Threads and LinkedIn when it is worth it; one short video a week.",
    },
  })) {
    const { error } = await me.rpc("save_marketing_document", { p_kind: kind, p_body: body });
    assert.ifError(error);
  }
  await admin.from("profiles").update({ credit_balance: 2000, plan: "creator" }).eq("id", userId);
  step("onboarded: documents (the rhythm names Threads and LinkedIn), creator plan, 2000 credits");

  // The plan: X, Threads and LinkedIn posts today, and one video that waits on Writer's brief.
  const { error: planError } = await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "plan_week", p_input: { source: "e2e", brief: "Launch week: make 1 video" } });
  assert.ifError(planError);
  await drainCmoQueue(supabaseStore(admin as never), { budgetMs: 60_000 });
  const { data: dueToday } = await admin.from("content_items").select("id, platform").eq("user_id", userId).eq("department", "post").eq("day", today);
  const platforms = (dueToday ?? []).map((i) => i.platform as string).sort();
  assert.deepEqual([...new Set(platforms)], ["LinkedIn", "Threads", "X"], "today holds an X, a Threads and a LinkedIn post");
  const { data: video } = await admin.from("work_orders").select("id, depends_on").eq("user_id", userId).eq("kind", "build_video").single();
  const { data: brief } = await admin.from("work_orders").select("id").eq("user_id", userId).eq("kind", "write_video_brief").single();
  assert.deepEqual(video?.depends_on, [brief!.id], "the video waits on Writer's brief");
  step(`plan_week: ${platforms.length} posts today on ${[...new Set(platforms)].join(", ")}, and a video waiting on its brief`);

  // The brief is written and the video takes it (B4's job, through the CMO queue).
  await until("the brief", userId, async () => {
    const { data } = await admin.from("work_orders").select("brief").eq("id", video!.id).single();
    return (data?.brief as { brief_from?: string } | null)?.brief_from === "writer" ? data : null;
  });
  step("Writer wrote the video brief; the video order took its hooks, key points and call to action");

  // The posts due today, one run each (as the schedule enqueues them).
  const { data: orders } = await admin.from("work_orders").select("id, item_id").eq("user_id", userId).eq("kind", "post_draft").in("item_id", (dueToday ?? []).map((i) => i.id));
  for (const item of dueToday ?? []) {
    const order = orders?.find((o) => o.item_id === item.id);
    const { error } = await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "post_draft", p_input: { source: "schedule", item_id: item.id, ...(order ? { order_id: order.id } : {}) } });
    assert.ifError(error);
  }
  const posts = await until("three post cards", userId, async () => {
    const cards = await waitingCards(userId, "post");
    return cards.length >= 3 ? cards : null;
  });
  const byPlatform = new Map(posts.map((c) => [c.body.kind === "post" ? c.body.platforms[0]!.platform : "", c]));
  assert.deepEqual([...byPlatform.keys()].sort(), ["linkedin", "threads", "x"], "one card per platform");
  for (const [platform, card] of byPlatform) {
    assert.ok(card.body.kind === "post");
    const { limit, versions } = card.body.platforms[0]!;
    assert.ok(versions.every((v) => v.length <= limit && !/https?:\/\/|#\w/.test(v)), `${platform}: within its limit, no links, no hashtags`);
  }
  step("three post cards: X (280), Threads (500), LinkedIn (3,000, the cut marked), each within its limit, no links, no hashtags");

  // Approve X as written, edit LinkedIn, skip Threads with a reason.
  await decide(byPlatform.get("x")!, "approve");
  const linkedin = byPlatform.get("linkedin")!;
  await decide(linkedin, "approve", { text: "Week one of building OpenCMO in public. One lesson: cut the demo by words." });
  await decide(byPlatform.get("threads")!, "skip", { reason: "Too salesy for Threads" });
  const { data: outcome } = await admin.from("cmo_draft_outcomes").select("id, platform").eq("item_id", (dueToday ?? []).find((i) => i.platform === "LinkedIn")!.id).single();
  assert.equal(outcome?.platform, "linkedin", "the outcome is LinkedIn's");
  // The nightly classifier names the edit; that writes its voice note.
  const { error: classifyError } = await admin.rpc("cmo_set_edit_mode", { p_id: outcome!.id, p_mode: "TOO_LONG" });
  assert.ifError(classifyError);
  const library = await screen("library", userId);
  assert.ok(library.live.voice, "Library → Voice is live");
  assert.deepEqual(library.data.voice.notes.map((n) => n.source).sort(), ["Approved as written", "From a skip reason", "From your edit: shorter"], "three voice notes");
  assert.ok(library.data.voice.notes.some((n) => n.platform === "linkedin" && n.text.includes("Week one of building OpenCMO")), "the edit's note holds the founder's words");
  const writer = await screen("writer", userId);
  assert.ok(writer.live.voice && writer.data.voice.lines.length >= 4, "Writer's voice reads the notes");
  assert.deepEqual(new Set(writer.data.drafts.filter((d) => d.kind === "post").map((d) => d.platform)), new Set(["x", "threads", "linkedin"]), "Writer's drafts per platform");
  step("approved X as written, edited LinkedIn, skipped Threads: three voice notes in Library and Writer");

  // The video: card 1 → card 2 → card 3, which gets its captions.
  await decide(await until("card 1", userId, async () => (await waitingCards(userId, "script"))[0]), "approve");
  await decide(await until("card 2", userId, async () => (await waitingCards(userId, "price"))[0], minutes(10)), "approve");
  const card3 = await until("card 3 with captions", userId, async () => {
    const card = (await waitingCards(userId, "finished_video"))[0];
    return card && card.body.kind === "finished_video" && card.body.captions.length > 0 ? card : null;
  }, minutes(15));
  assert.ok(card3.body.kind === "finished_video");
  const caption = card3.body.captions[0]!;
  const editedText = "Cut a demo video by deleting the words you do not want.";
  const kept = await decide(card3, "edit_caption", { caption: caption.id, text: editedText, ...(caption.title !== null ? { title: caption.title } : {}) });
  assert.equal(kept.status, "waiting", "a caption edit decides nothing");
  const stale = await me.rpc("approval_decide", { p_id: card3.id, p_action: "approve", p_payload: { content_hash: card3.contentHash, via: "app" } });
  assert.match(stale.error?.message ?? "", /changed/, "the old hash is refused after the edit");
  const card3Now = (await waitingCards(userId, "finished_video"))[0]!;
  assert.equal(card3Now.id, card3.id, "the same card");
  step(`card 3: ${card3.body.captions.length} caption(s) (${card3.body.captions.map((c) => c.profile).join(", ")}); one edited on the card, same card, new hash`);
  await decide(card3Now, "approve");
  const { data: videoDeliverable } = await admin.from("deliverables").select("id").eq("user_id", userId).eq("kind", "video").single();
  const { data: videoCaptions } = await admin.from("deliverables").select("id").eq("parent_id", videoDeliverable!.id).eq("kind", "caption");
  assert.equal(videoCaptions?.length, card3.body.captions.length, "each caption is a deliverable under the video");
  step("approved card 3: the video and its captions are deliverables");

  // The shorts batch card gets its captions too.
  const batch = await until("shorts batch with captions", userId, async () => {
    const card = (await waitingCards(userId, "shorts_batch"))[0];
    return card && card.body.kind === "shorts_batch" && card.body.shorts.every((s) => s.captions.length > 0) ? card : null;
  }, minutes(15));
  assert.ok(batch.body.kind === "shorts_batch");
  step(`shorts batch: ${batch.body.shorts.length} shorts, each with ${batch.body.shorts[0]!.captions.length} caption(s)`);
  await decide(batch, "approve");
  const { data: shortCaptions } = await admin
    .from("deliverables")
    .select("id, parent_id")
    .eq("user_id", userId)
    .eq("kind", "caption")
    .not("parent_id", "in", `(${videoDeliverable!.id})`);
  assert.equal(shortCaptions?.length, batch.body.shorts.reduce((n, s) => n + s.captions.length, 0), "each short's captions are deliverables under it");
  const writerAfter = await screen("writer", userId);
  assert.ok(writerAfter.data.drafts.some((d) => d.kind === "caption") && writerAfter.data.drafts.some((d) => d.kind === "video_brief"), "Writer shows the captions and the brief");
  step("approved the batch: captions delivered under each short; Writer shows captions and the brief");

  console.log(`\np3-acceptance.e2e — P3 end to end for ${email}: ${log.length} steps passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
