/**
 * Brain wave 1 acceptance (brain plan W1-6) against a local Supabase with fake providers: onboard → plan_week writes
 * the tree → a post draft and the Reddit scan run → their cards are in the Dashboard queue → approving one moves the
 * graph and the log → Pause stops the next run → the digest lists what waits.
 *
 *     set -a && . ./e2e.env && set +a     # NEXT_PUBLIC_SUPABASE_URL, *_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *     OPENCMO_AGENT_FAKE=1 OPENCMO_AI_FAKE=1 ANTHROPIC_API_KEY= GEMINI_API_KEY= OPENCMO_DIGEST_LOCAL_MAIL=1 \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/screens/acceptance.e2e.ts
 *
 * Reads every screen the way the route does: the loader under the founder's RLS session, then `compose`.
 * It leaves its founder in the database, and some pgTAP files expect an empty one: `npm run db:reset` before `db:test`.
 */
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { buildDigest, loadDigestInput } from "@/lib/cmo/digest";
import { emailSender } from "@/lib/notify/email";
import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { enqueueDueLoops } from "@/lib/cmo/schedule";
import { clientFor } from "@/lib/mcp/auth";

import { LOADERS } from "./load";
import { compose, released, type ScreenName } from "./registry";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const store = supabaseStore(admin);
const drain = () => drainCmoQueue(store, { budgetMs: 60_000 });

async function screen<N extends ScreenName>(name: N, userId: string) {
  const loader = LOADERS[name] as (ctx: never) => Promise<object>;
  const loaded = await loader({ supabase: clientFor(userId), userId, params: new URLSearchParams() } as never);
  return compose(name, loaded as never, { production: true, sample: false });
}

async function enqueue(userId: string, kind: string, input: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: kind, p_input: { source: "e2e", ...input } });
  assert.ifError(error);
  return data as { id: string };
}

export async function run(): Promise<void> {
  assert.equal(process.env.OPENCMO_AGENT_FAKE, "1", "run with fake providers");
  const email = `w1-acceptance-${Date.now()}@test.local`;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  assert.ifError(created.error);
  const userId = created.data.user!.id;
  const me = clientFor(userId);
  const log: string[] = [];
  const step = (line: string) => {
    log.push(line);
    console.log(`  ✓ ${line}`);
  };

  // Onboard: the founder's documents, a paid plan with credits.
  for (const [kind, body] of Object.entries({
    product: { name: "OpenCMO", one_liner: "An AI CMO for solo founders: an editor, post drafts and Reddit leads you approve." },
    strategy: { icp: "Solo founders who ship software", pains: ["editing product demos takes longer than building them"], avoid: ["game-changer"] },
    content_strategy: { pillars: [{ name: "Editing by words", ideas: ["Cut a video by deleting words", "Ask for B-roll on the line"] }] },
  })) {
    const { error } = await me.rpc("save_marketing_document", { p_kind: kind, p_body: body });
    assert.ifError(error);
  }
  await admin.from("profiles").update({ credit_balance: 50, plan: "starter" }).eq("id", userId);
  step("onboarded: documents saved, starter plan, 50 credits");

  // plan_week writes the tree.
  await enqueue(userId, "plan_week");
  await drain();
  let brain = await screen("brain", userId);
  assert.ok(brain.live.orders, "the Brain's orders are live");
  const orders = brain.data.orders;
  assert.ok(orders.length >= 3, `the week has orders (${orders.length})`);
  assert.ok(orders.some((o) => o.department === "writer") && orders.some((o) => o.department === "sales"), "Writer and Sales got orders");
  assert.equal(brain.data.week.credits.budget, 80, "the week holds the weekly budget");
  step(`plan_week wrote the tree: ${orders.length} orders (${orders.filter((o) => o.department === "writer").length} Writer, ${orders.filter((o) => o.department === "sales").length} Sales)`);

  // The 00:05 schedule enqueues today's post, linked to its order; the Reddit scan is started by hand.
  await enqueueDueLoops(admin);
  const { data: draftRun } = await admin.from("cmo_runs").select("input").eq("user_id", userId).eq("kind", "post_draft").single();
  const link = (draftRun as { input: { order_id?: string; item_id?: string } }).input;
  assert.ok(link.order_id && link.item_id, "the schedule links the draft run to its order and calendar item");
  await enqueue(userId, "sales_scan", { brief: "Founders editing product demos" });
  await drain();
  let dashboard = await screen("dashboard", userId);
  assert.ok(dashboard.live.queue && dashboard.live.team && dashboard.live.log, "queue, graph and log are live");
  const queue = dashboard.data.queue;
  const post = queue.find((c) => c.kind === "post");
  const replies = queue.filter((c) => c.kind === "reply");
  assert.ok(post, `a post card waits (${queue.map((c) => c.kind).join(", ")})`);
  assert.ok(replies.length > 0, "Reddit reply cards wait");
  const writerBefore = dashboard.data.team.nodes.find((n) => n.department === "writer")!;
  assert.ok(writerBefore.waiting >= 1, "the Writer node shows a card waiting");
  const { count: pending } = await me.from("approvals").select("id", { count: "exact", head: true }).eq("status", "waiting");
  assert.equal(pending, queue.length, "the rail badge counts the same cards as the queue");
  brain = await screen("brain", userId);
  assert.ok(brain.data.orders.some((o) => o.state === "waiting_founder" && o.approvalId === post!.id), "the post's order waits on its card");
  step(`runs finished: ${queue.length} cards in the queue (1 post, ${replies.length} replies), the post's order waits on you`);

  // Approve the post: graph and log move.
  const logBefore = dashboard.data.log.length;
  const decided = await me.rpc("approval_decide", { p_id: post!.id, p_action: "approve", p_payload: { content_hash: post!.contentHash, via: "app" } });
  assert.ifError(decided.error);
  dashboard = await screen("dashboard", userId);
  assert.equal(dashboard.data.queue.length, queue.length - 1, "the card left the queue");
  assert.equal(dashboard.data.team.nodes.find((n) => n.department === "writer")!.waiting, writerBefore.waiting - 1, "the Writer chip dropped");
  assert.ok(dashboard.data.log.length > logBefore && dashboard.data.log[0]!.text.startsWith("You approved"), `the log says so: ${dashboard.data.log[0]?.text}`);
  brain = await screen("brain", userId);
  assert.ok(brain.data.orders.some((o) => o.state === "done" && o.department === "writer"), "the post's order is done");
  const stale = await me.rpc("approval_decide", { p_id: replies[0]!.id, p_action: "replied", p_payload: { content_hash: "0".repeat(64) } });
  assert.match(stale.error?.message ?? "", /This card changed/, "a card decided on an old screen is refused");
  step(`approved the post: queue ${queue.length} → ${dashboard.data.queue.length}, log “${dashboard.data.log[0]!.text}”`);

  // Pause stops the next run.
  const paused = await me.rpc("cmo_pause");
  assert.ifError(paused.error);
  const refused = await admin.rpc("enqueue_cmo_run_for", { p_user: userId, p_kind: "post_draft", p_input: { source: "e2e" } });
  assert.match(refused.error?.message ?? "", /paused/, "nothing new is queued while paused");
  dashboard = await screen("dashboard", userId);
  assert.equal(dashboard.data.team.brain.state, "paused");
  assert.ok(dashboard.data.cmo.pausedAt, "the header knows");
  const settings = await screen("settings", userId);
  assert.ok(settings.live.weeklyCreditBudget && settings.data.cmo.pausedAt, "Settings reads the budget and the pause");
  await me.rpc("cmo_resume");
  step("Pause CMO refused the next run; Resume cleared it");

  // The digest lists what waits.
  const input = await loadDigestInput(me, userId, { appUrl: "http://127.0.0.1:3000", dateLabel: "today" });
  const digest = buildDigest(input);
  assert.equal(input.waiting.length, dashboard.data.queue.length, "the digest lists every waiting card");
  assert.ok(digest.text.includes(`/app/inbox/${input.waiting[0]!.id}`), "with links that open the card");
  assert.ok(dashboard.data.digest && dashboard.data.digest.waiting.length === input.waiting.length, "and the Dashboard shows it");
  const send = emailSender();
  if (send?.name === "local") {
    await send.send({ to: email, subject: digest.subject, text: digest.text, html: digest.html, unsubscribeUrl: "http://127.0.0.1:3000/unsubscribe" });
    step(`digest sent to the local mail catcher: “${digest.subject}”`);
  } else step(`digest built: “${digest.subject}” (no local mail sender set)`);

  const writer = await screen("writer", userId);
  assert.ok(writer.live.drafts && writer.data.drafts.some((d) => d.column === "scheduled"), "Writer shows the approved post live");
  const salesScreen = await screen("sales", userId);
  assert.equal(salesScreen.data.threads.filter((t) => t.status === "open").length, replies.length, "Sales lists the open threads live");
  const researchScreen = await screen("research", userId);
  assert.ok(researchScreen.live.insights && researchScreen.live.results, "Research reads live rows");
  for (const name of ["dashboard", "brain", "library", "settings", "research", "writer", "studio", "sales"] as const) {
    assert.ok(released(name), `${name} would show at release`);
  }
  step("Writer, Sales and Research read live rows; eight screens pass the release gate");

  const library = await screen("library", userId);
  assert.ok(library.live.documents && library.data.documents.length === 3, "Library reads the founder's documents");
  step("Library reads the three documents live");

  console.log(`\nacceptance.e2e — wave 1 end to end for ${email}: ${log.length} steps passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
