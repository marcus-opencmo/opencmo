/**
 * B10 against a local Supabase (REST is enough): a founder out of credits, no LLM keys. The cron
 * puts the day's X draft and Reddit scan in the inbox; the founder's Claude (played here by
 * this script, through the same tools and the same RLS session the MCP server gives it) answers;
 * the replays create cards in Approvals; nothing is posted.
 *
 *     set -a && . ./e2e.env && set +a     # NEXT_PUBLIC_SUPABASE_URL, *_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *     OPENCMO_AGENT_FAKE=1 ANTHROPIC_API_KEY= GEMINI_API_KEY= \
 *       NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/mcp/inbox.e2e.ts
 *
 * `OPENCMO_AGENT_FAKE=1` only fakes the Reddit reader here: an inbox run never uses a fake model.
 */
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { enqueueDueLoops } from "@/lib/cmo/schedule";
import { drainCmoQueue } from "@/lib/cmo/jobs/runner";
import { supabaseStore } from "@/lib/cmo/jobs/store";
import { isoDay } from "@/lib/cmo/jobs/types";
import { clientFor } from "@/lib/mcp/auth";

import { ACCOUNT_GROUP, CMO_GROUP, INBOX_GROUP, type McpResult } from "./index";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const tools = new Map([...CMO_GROUP.tools!, ...INBOX_GROUP.tools!, ...ACCOUNT_GROUP.tools!].map((tool) => [tool.name, tool]));


/** What Claude does with a tool: call it and read the text. */
async function call(name: string, input: unknown, ctx: { supabase: ReturnType<typeof clientFor>; userId: string }): Promise<McpResult> {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name}`);
  const parsed = tool.inputSchema.safeParse(input);
  assert.ok(parsed.success, `${name} input: ${parsed.success ? "" : parsed.error.issues[0]?.message}`);
  return tool.run(parsed.data, ctx);
}

const text = (result: McpResult) => result.content.map((c) => c.text).join("\n");

export async function run(userId: string) {
  assert.ok(!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY, "run with the LLM keys removed");
  const ctx = { supabase: clientFor(userId), userId };

  // The founder's documents and today's X item, written under their own session.
  for (const [kind, body] of Object.entries({
    product: { name: "Paylane", one_liner: "Invoicing that chases late payments.", pricing: "$12/month" },
    strategy: { icp: "Freelancers who invoice 3-15 clients a month", pains: ["late invoice payments", "chasing clients for money"], avoid: ["revolutionary", "game-changer"] },
    content_strategy: { pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule"] }] },
  })) {
    const { error } = await ctx.supabase.rpc("save_marketing_document", { p_kind: kind, p_body: body });
    assert.ifError(error);
  }
  for (const [department, idea] of [["post", "The 3-7-14 reminder rule"], ["sales", "Help freelancers who chase late invoices"]]) {
    const { error } = await ctx.supabase.rpc("cmo_add_item", { p_department: department, p_idea: idea, p_day: isoDay(), p_reason: "e2e", p_body: {} });
    assert.ifError(error);
  }
  // A paid founder out of credits: MCP and the free `brain = 'claude'` run are paid-plan features.
  await admin.from("profiles").update({ credit_balance: 0, plan: "starter" }).eq("id", userId);

  // Mode B, because of credits (and no keys).
  const mode = await call("get_mode", {}, ctx);
  assert.equal((mode.structuredContent as { brain: string }).brain, "claude", text(mode));

  // The 00:05 cron, then Modal's sweep.
  const cron = await enqueueDueLoops(admin);
  assert.ok(cron.inbox >= 2, `the cron sent the X draft and the Reddit scan to the inbox (${JSON.stringify(cron)})`);
  const store = supabaseStore(admin);
  const drain = () => drainCmoQueue(store, { budgetMs: 60_000 });
  await drain();

  const list = await call("list_inbox", {}, ctx);
  const items = (list.structuredContent as { items: { id: string; kind: string; status: string }[] }).items;
  const post = items.find((i) => i.kind === "post_draft" && i.status === "open");
  const scan = items.find((i) => i.kind === "sales_scan" && i.status === "open");
  assert.ok(post && scan, `post and scan are waiting:\n${text(list)}`);

  // ---- X post: a draft that breaks the rules is refused at once, a good one becomes a card.
  const opened = await call("get_inbox_item", { id: post.id }, ctx);
  assert.ok(text(opened).includes("3-7-14") && text(opened).includes("submit_post_draft"), text(opened).slice(0, 600));
  const rubric = await call("get_check_rubric", { kind: "post_draft" }, ctx);
  assert.ok(text(rubric).includes("revolutionary"), "the rubric lists the founder's words to avoid");
  const bad = await call("submit_post_draft", { id: post.id, step: "draft_post", answer: { versions: [{ text: "A revolutionary way to invoice", angle: "x" }], rationale: "r" } }, ctx);
  assert.equal(bad.isError, true, "a draft that fails every check is refused before it is stored");
  const answer = {
    versions: [
      { text: "Remind on day 3, 7 and 14. Same short note each time. It reads like a process, not a chase.", angle: "rule" },
      { text: "Late invoices are a process problem, not a people problem.", angle: "contrarian" },
      { text: "We put the due date and the late fee on the invoice itself. Fewer awkward emails.", angle: "build in public" },
    ],
    rationale: "Today's calendar item.",
  };
  const sent = await call("submit_post_draft", { id: post.id, step: "draft_post", answer }, ctx);
  assert.ok(!sent.isError, text(sent));
  const again = await call("submit_post_draft", { id: post.id, step: "draft_post", answer }, ctx);
  assert.equal((again.structuredContent as { run_id: string }).run_id, (sent.structuredContent as { run_id: string }).run_id, "a retried submission is one replay");
  await drain();
  const done = await call("get_inbox_item", { id: post.id }, ctx);
  assert.equal((done.structuredContent as { status: string }).status, "done", text(done));
  const { data: card } = await ctx.supabase.from("content_items").select("status, body").eq("department", "post").eq("status", "in_review").maybeSingle();
  assert.ok(card, "the draft is a card in Approvals");
  assert.equal((card as { body: { text: string } }).body.text, answer.versions[0]!.text);

  // ---- Reddit scan: three rounds; the threads stay the same between them.
  let item = await call("get_inbox_item", { id: scan.id }, ctx);
  assert.equal((item.structuredContent as { step: string }).step, "make_queries");
  const wrongShape = await call("submit_sales_scan", { id: scan.id, step: "make_queries", answer: { queries: "late invoices" } }, ctx);
  assert.equal(wrongShape.isError, true, "an answer that does not match the schema is refused");
  await call("submit_sales_scan", { id: scan.id, step: "make_queries", answer: { queries: ["clients pay late", "chasing invoices"] } }, ctx);
  await drain();
  item = await call("get_inbox_item", { id: scan.id }, ctx);
  assert.equal((item.structuredContent as { step: string }).step, "score_thread", text(item).slice(0, 400));
  const prompt = text(item);
  const titles = [...prompt.matchAll(/<thread index="(\d+)"[^>]*>\nTitle: (.*)\n/g)].map((m) => ({ index: Number(m[1]), title: m[2]! }));
  assert.ok(titles.length > 0, "the threads are in the item");
  await call("submit_sales_scan", {
    id: scan.id,
    step: "score_thread",
    answer: { scores: titles.map(({ index, title }) => ({ index, exclude: false, pain: { score: 24, quote: title }, fit: { score: 23, why: "Freelancer chasing invoices." }, evidence: { score: 14, quote: title } })) },
  }, ctx);
  await drain();
  item = await call("get_inbox_item", { id: scan.id }, ctx);
  // P5 R1: the communities' rules, read as data, before any reply is drafted.
  assert.equal((item.structuredContent as { step: string }).step, "check_rules", text(item).slice(0, 400));
  const communities = (text(item).match(/<rules index=/g) ?? []).length;
  await call("submit_sales_scan", {
    id: scan.id,
    step: "check_rules",
    answer: { rules: Array.from({ length: communities }, (_, index) => ({ index, verdict: "help_only", summary: "No self-promotion" })) },
  }, ctx);
  await drain();
  item = await call("get_inbox_item", { id: scan.id }, ctx);
  assert.equal((item.structuredContent as { step: string }).step, "draft_reply", text(item).slice(0, 400));
  const toReply = (text(item).match(/<thread index=/g) ?? []).length;
  await call("submit_sales_scan", {
    id: scan.id,
    step: "draft_reply",
    answer: { replies: Array.from({ length: toReply }, (_, index) => ({ index, reply: "Put the due date and the late fee on the invoice itself, then send the same short reminder on day 3, 7 and 14." })) },
  }, ctx);
  await drain();
  item = await call("get_inbox_item", { id: scan.id }, ctx);
  assert.equal((item.structuredContent as { status: string }).status, "done", text(item));
  const { data: opps } = await ctx.supabase.from("opportunities").select("status, reply");
  assert.equal(opps?.length, toReply, "one Reddit card per reply");
  assert.ok(opps!.every((o) => (o as { status: string }).status === "in_review"), "waiting for the founder; nothing posted");

  // No credits moved for any of it.
  const { data: profile } = await admin.from("profiles").select("credit_balance").eq("id", userId).single();
  assert.equal((profile as { credit_balance: number }).credit_balance, 0);
  const { data: runs } = await admin.from("cmo_runs").select("credits").eq("user_id", userId);
  assert.ok(runs!.every((r) => (r as { credits: number }).credits === 0), "every inbox run held 0 credits");

  console.log(`inbox.e2e — cron → inbox → Claude → cards: 1 X card, ${toReply} Reddit cards, 0 credits, ${runs!.length} runs.`);
}

const userId = process.argv[2];
if (!userId) throw new Error("usage: inbox.e2e.ts <user id of a test user in auth.users>");
run(userId).catch((error) => {
  console.error(error);
  process.exit(1);
});
