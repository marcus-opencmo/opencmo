/**
 * Reply outcomes (P6 A3) without network: finding the founder's reply by its text, Algolia's item tree, one check per
 * reply (found, not found, gone, a failed read tried again tomorrow), the `pull_metrics` step on the memory store and
 * the loop that runs it.
 *
 *     cd apps/web && NODE_OPTIONS=--conditions=react-server npx tsx lib/cmo/jobs/reply-outcomes.check.ts
 */
import assert from "node:assert/strict";

process.env.OPENCMO_AGENT_FAKE = "1";

import { dueLoops } from "../loops";
import { HnReadError, parseHnItem } from "../social/hn";
import type { RedditComment } from "../social/scrapecreators";
import { memoryStore } from "./memory-store";
import { checkReplies, checkReply, findReply, replyOverlap, type ReplyReaders } from "./reply-outcomes";
import { drainCmoQueue } from "./runner";
import type { ReplyOutcomeDue } from "./types";

const REPLY = "Send reminders on day 3, 7 and 14. Polite, short, with the invoice attached.";

async function main() {
  assert.equal(replyOverlap(REPLY, REPLY), 1);
  assert.ok(replyOverlap(REPLY, "send reminders on day 3, 7 and 14 - polite, short, invoice attached!") >= 0.7, "edits and punctuation allowed");
  assert.ok(replyOverlap(REPLY, "Just use a calendar reminder?") < 0.3);
  const comments: RedditComment[] = [
    { author: "u/devnull", text: "Just use a calendar reminder?", score: 2 },
    { author: "u/me", text: "send reminders on day 3, 7 and 14. Polite and short, with the invoice attached.", score: 12, replies: 4 },
  ];
  assert.equal(findReply(REPLY, comments)?.score, 12);
  assert.equal(findReply("", comments), null, "an empty reply matches nothing");

  // Algolia's tree: comments flattened with their direct replies; the story itself is not a comment.
  const tree = { id: 42, type: "story", children: [{ id: 43, type: "comment", author: "a", text: "<p>We chase invoices &amp; it works</p>", children: [{ id: 44, type: "comment", text: "How?", children: [] }] }] };
  assert.deepEqual(parseHnItem(tree), [
    { id: "43", author: "a", text: "We chase invoices & it works", replies: 1 },
    { id: "44", author: "", text: "How?", replies: 0 },
  ]);

  const due = (platform: "reddit" | "hn", extra: Partial<ReplyOutcomeDue> = {}): ReplyOutcomeDue => ({
    outcome_id: `o-${platform}`, opportunity_id: `p-${platform}`, platform, community: "r/SaaS", reply: REPLY, outcome_url: null,
    url: platform === "hn" ? "https://news.ycombinator.com/item?id=42" : "https://www.reddit.com/r/SaaS/comments/abc/x/", ...extra,
  });
  const seen: string[] = [];
  const readers: ReplyReaders = {
    reddit: async (url) => (seen.push(url), { gone: false, comments }),
    hn: async (url) => (seen.push(url), [{ id: "9", author: "me", text: REPLY, replies: 3 }]),
  };
  assert.deepEqual(await checkReply(due("reddit"), readers), { status: "found", votes: 12, replies: 4 });
  assert.deepEqual(await checkReply(due("hn", { outcome_url: "https://news.ycombinator.com/item?id=9" }), readers), { status: "found", votes: null, replies: 3 });
  assert.equal(seen.at(-1), "https://news.ycombinator.com/item?id=9", "a pasted HN link is read alone");
  assert.deepEqual(await checkReply(due("reddit", { reply: "Something else entirely about pricing pages." }), readers), { status: "not_found", votes: null, replies: null });
  assert.deepEqual(await checkReply(due("reddit"), { ...readers, reddit: async () => ({ gone: true, comments: [] }) }), { status: "gone", votes: null, replies: null });
  assert.equal(await checkReply(due("hn"), { ...readers, hn: async () => { throw new HnReadError("busy"); } }), null, "a failed read is tried again tomorrow");
  await assert.rejects(checkReply(due("hn"), { ...readers, hn: async () => { throw new Error("bug"); } }), /bug/, "a bug is not swallowed");

  // The pull_metrics step: each due reply checked once; nothing due, nothing read.
  const mem = memoryStore({ product: { name: "Paylane" } } as never);
  mem.replies.push(due("reddit"), due("hn"));
  const run = mem.enqueue("pull_metrics");
  await drainCmoQueue(mem.store);
  assert.equal(run.status, "done", `pull_metrics done (${run.error})`);
  assert.ok(mem.replies.every((r) => r.check), "both checked");
  assert.equal(mem.replies.find((r) => r.platform === "hn")!.check!.status, "not_found", "the fake discussion has no reply of ours");
  const again = await checkReplies({ store: mem.store, run: { user_id: "u" }, step: async (_t: string, _l: string, fn: () => unknown) => fn() } as never, readers);
  assert.deepEqual(again, { checked: 0, found: 0 }, "checked once");

  // The loop: connected accounts or due replies run pull_metrics without the social reader.
  const base = { weekday: 3, duePost: null, dueSales: null, competitorHandles: 0, publishedRecently: 0, socialReader: false };
  assert.deepEqual(dueLoops(base), []);
  assert.deepEqual(dueLoops({ ...base, repliesDue: 1 }).map((r) => r.kind), ["pull_metrics"]);
  assert.deepEqual(dueLoops({ ...base, connectedAccounts: 2 }).map((r) => r.kind), ["pull_metrics"]);

  console.log("reply-outcomes: matching, HN items, one check per reply, the pull_metrics step and its loop");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
