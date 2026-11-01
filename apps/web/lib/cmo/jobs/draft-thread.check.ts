/**
 * X threads (P6 W4) without a model or network: the code checks on every post and on the thread, `post_draft` with
 * `thread: true` on the fake provider (one card, `text` = the first post, X only), the publish contract, Zernio's
 * `threadItems` body and the fired slot carrying the approved thread.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/jobs/draft-thread.check.ts
 */
import assert from "node:assert/strict";

process.env.OPENCMO_AGENT_FAKE = "1";

import { PublishDeliverableSchema, type PublishDeliverable, type PublishSlot } from "@/lib/departments/publish/types";
import { postBody } from "@/lib/departments/publish/zernio";

import { profileOf } from "../platforms";
import { checkRules } from "./context";
import { fakeThread, threadIssues } from "./draft-thread";
import { memoryStore } from "./memory-store";
import { adapterInput, type FiredSlot } from "./publish-post";
import { drainCmoQueue } from "./runner";
import type { Documents } from "./types";

const docs: Documents = {
  product: { name: "Paylane", one_liner: "Invoicing that chases late payments.", pricing: "$12/month" },
  strategy: { icp: "Freelancers who invoice 3–15 clients a month", avoid: ["revolutionary"] },
  content_strategy: { pillars: [{ name: "Getting paid", ideas: ["The 3-7-14 reminder rule"] }] },
};

async function main() {
  const x = profileOf("x")!;
  const rules = checkRules(docs);
  const good = fakeThread("Why invoices go unpaid", "Paylane").posts;
  assert.deepEqual(threadIssues(good, x, rules), [], "the fake thread passes");
  assert.match(threadIssues(good.slice(0, 4), x, rules).join(" "), /5 to 8 posts/);
  assert.match(threadIssues([...good.slice(0, 5), "To sum up, chase invoices early."], x, rules).join(" "), /recap/);
  assert.match(threadIssues(["1/ Here is how we did it.", ...good.slice(1)], x, rules).join(" "), /Post 1 starts with a number/);
  assert.match(threadIssues([...good.slice(0, 5), "x".repeat(281)], x, rules).join(" "), /Post 6: .*281/);
  assert.match(threadIssues([good[0]!, good[0]!, ...good.slice(2)], x, rules).join(" "), /Two posts are the same/);
  assert.match(threadIssues([...good.slice(0, 5), "A revolutionary way to get paid."], x, rules).join(" "), /revolutionary/);

  // post_draft with thread: true writes one thread card; not on another platform.
  const mem = memoryStore(docs);
  const run = mem.enqueue("post_draft", { idea: "Why invoices go unpaid", brief: "Why invoices go unpaid", thread: true });
  await drainCmoQueue(mem.store);
  assert.equal(run.status, "done", `thread drafted (${run.error})`);
  const item = mem.items.find((i) => i.status === "in_review")!;
  const body = item.body as { text: string; thread: string[] };
  assert.ok(body.thread.length >= 5 && body.thread.length <= 8);
  assert.equal(body.text, body.thread[0], "the card's text is the first post");
  assert.equal(mem.items.filter((i) => i.status === "in_review").length, 1, "one card, not three versions");

  const memL = memoryStore(docs);
  memL.items.push({ id: "li-1", run_id: null, department: "post", platform: "LinkedIn", day: new Date().toISOString().slice(0, 10), idea: "A LinkedIn post", reason: "", status: "planned", priority: "medium", body: {}, final_text: null, external_url: null, decided_at: null, published_at: null, created_at: new Date().toISOString() });
  const runL = memL.enqueue("post_draft", { item_id: "li-1", thread: true });
  await drainCmoQueue(memL.store);
  assert.equal(runL.status, "failed");
  assert.match(String(runL.error), /Threads are for X only/);

  // The publish contract: 5–8 posts of at most 280, a post whose text is the first one.
  const deliverable: PublishDeliverable = { id: "00000000-0000-4000-8000-0000000000a1", kind: "post", text: good[0]!, title: null, media: [], thread: good };
  assert.ok(PublishDeliverableSchema.safeParse(deliverable).success);
  assert.ok(!PublishDeliverableSchema.safeParse({ ...deliverable, thread: good.slice(0, 4) }).success, "too short");
  assert.ok(!PublishDeliverableSchema.safeParse({ ...deliverable, text: "Something else" }).success, "text must be the first post");
  assert.ok(!PublishDeliverableSchema.safeParse({ ...deliverable, thread: [...good.slice(0, 5), "x".repeat(281)] }).success, "280 per post");

  // Zernio: one post with threadItems, item 0 the root; media only on the root.
  const slot: PublishSlot = { id: "00000000-0000-4000-8000-0000000000b1", platform: "x", zernioAccountId: "acc-x", idempotencyKey: "slot:1", publishAt: "2026-11-02T09:00:00Z", fields: { platform: "x" } } as PublishSlot;
  const bodyOut = postBody({ ...deliverable, media: [{ url: "https://media.zernio.com/a.png", contentType: "image/png" }] }, slot) as {
    platforms: { platformSpecificData: { threadItems: { content: string; mediaItems?: unknown[] }[] } }[];
    mediaItems?: unknown;
  };
  const items = bodyOut.platforms[0]!.platformSpecificData.threadItems;
  assert.deepEqual(items.map((i) => i.content), good);
  assert.ok(items[0]!.mediaItems && !items[1]!.mediaItems, "media on the root post only");
  assert.equal(bodyOut.mediaItems, undefined, "not twice at the top level");

  // A fired X slot carries the approved thread; another platform never does.
  const fired = {
    id: slot.id, status: "due", platform: "x", mode: "publish", accountId: "sa", zernioAccountId: "acc-x", accountStatus: "connected",
    publishAt: slot.publishAt, windowEndsAt: slot.publishAt, options: {}, idempotencyKey: "k", approvalStatus: "approved",
    snapshot: { deliverable_id: deliverable.id, kind: "post" },
    current: { content_hash: "h", text: good[0]!, title: null, clip_id: null, thread: good },
  } as unknown as FiredSlot;
  assert.deepEqual(adapterInput(fired, null).deliverable.thread, good);
  assert.equal(adapterInput({ ...fired, platform: "threads" } as FiredSlot, null).deliverable.thread, undefined);

  console.log("draft-thread: checks per post, one thread card on X only, the publish contract, Zernio threadItems");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
