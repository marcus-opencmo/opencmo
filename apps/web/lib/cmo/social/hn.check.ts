/**
 * The Hacker News source (`hn.ts`) on a recorded Algolia response, with no network.
 *
 *     cd apps/web && npx tsx lib/cmo/social/hn.check.ts
 */
import assert from "node:assert/strict";

import recorded from "../jobs/eval/fixtures/hn/invoicing.json";
import { HnBudget, HnReadError, hnPlain, parseHnSearch, searchHn } from "./hn";

async function main() {
  const threads = parseHnSearch(recorded);
  assert.equal(threads.length, 5);
  for (const t of threads) {
    assert.match(t.url, /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/, "always the discussion page, never the linked site");
    assert.equal(t.community, "Hacker News");
    assert.ok(t.postedAt && !Number.isNaN(Date.parse(t.postedAt)));
    assert.ok(!/<[a-z]|&#x?[0-9a-f]+;/i.test(t.text), "plain text, no HTML or entities");
  }
  assert.ok(threads[0]!.text.startsWith("I've been working"), "entities decoded");
  assert.equal(threads[0]!.comments, 6);

  // Outside text: tags go, smuggled invisible characters go, a hit without an id or title is dropped.
  assert.equal(hnPlain("Hi<p>there <a href=\"x\">link</a> &amp; ​more&#x27;s", 100), "Hi\nthere link & more's");
  assert.equal(parseHnSearch({ hits: [{ objectID: "../1", title: "x" }, { objectID: "2", title: "" }, { objectID: "3", title: "Ok", points: -4 }] }).map((t) => [t.objectId, t.points]).join(), "3,0");
  assert.deepEqual(parseHnSearch(null), []);

  // The request: recent stories by date for Sales, relevance for Research; the budget counts every call.
  const seen: string[] = [];
  const fake = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(recorded), { status: 200 });
  }) as unknown as typeof fetch;
  const budget = new HnBudget(2);
  assert.equal((await searchHn("late invoices", budget, { recentDays: 30, fetch: fake })).length, 5);
  assert.match(seen[0]!, /^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date\?query=late\+invoices&tags=story&hitsPerPage=20&numericFilters=created_at_i%3E\d+$/);
  await searchHn("late invoices", budget, { fetch: fake });
  assert.match(seen[1]!, /\/api\/v1\/search\?/);
  await assert.rejects(searchHn("again", budget, { fetch: fake }), HnReadError, "the third call is over the budget");
  assert.equal(seen.length, 2, "an over-budget call never reaches the network");
  assert.deepEqual(await searchHn("   ", new HnBudget(1), { fetch: fake }), [], "an empty query is not a call");

  const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
  await assert.rejects(searchHn("x", new HnBudget(1), { fetch: status(429) }), /busy/);
  await assert.rejects(searchHn("x", new HnBudget(1), { fetch: status(500) }), /failed/);
  const down = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  await assert.rejects(searchHn("x", new HnBudget(1), { fetch: down }), /did not answer/);
  console.log("hn: parsing, plain text, budget and requests correct");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
