/**
 * Decisions from the CMO chat (plan 2026-11-02-cmo-chat-decisions): the card's hash is read when the card is shown,
 * a decision calls the button's RPC with it, the tools never reach MCP, and the taint gate covers them.
 *
 *     NODE_OPTIONS=--conditions=react-server tsx lib/agent/cmo-decisions.check.ts
 */
import assert from "node:assert/strict";

import type { SupabaseClient } from "@/lib/api/handler";
import { CMO_TOOLS } from "@/lib/cmo/mcp/cmo";

import { prepareDecision, runDecision, localToIso, DECISION_WRITES, type Prepared } from "./cmo-decisions";
import { CMO_TOOL_SPECS, TAINT_GATED_TOOLS, isCmoWrite } from "./cmo-tools";

const CARD = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

/** A stand-in client: tables answer fixed rows, RPCs are recorded. */
function fake(tables: Record<string, unknown>) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: { id: CARD, status: "approved", ref_kind: "content_item" }, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, rpcs };
}

const postRow = {
  id: CARD, kind: "post", department: "writer", ref_kind: "content_item", ref_id: "22222222-2222-4222-8222-222222222222", status: "waiting",
  snapshot: { kind: "post", platform: "X", day: "2026-11-03", idea: "Pricing that fits", text: "Pricing that fits a solo founder.", alternates: [], rationale: "" },
  content_hash: HASH, price_credits: null, post_at: null, account: null, expires_at: null, created_at: "2026-11-02T08:00:00Z", decided_at: null, decided_via: null,
};

async function main() {
  // Contracts: decisions are writes, gated after outside content, last in the tool list, never on MCP.
  for (const name of DECISION_WRITES) {
    assert.ok(isCmoWrite(name), `${name} is a write`);
    assert.ok(TAINT_GATED_TOOLS.has(name), `${name} waits for the founder after outside content`);
    assert.ok(!CMO_TOOLS.some((tool) => tool.name === name), `${name} is not offered over MCP`);
  }
  assert.ok(CMO_TOOL_SPECS.some((spec) => spec.name === "get_credits"));

  // A card decision: the card the founder sees, and its hash taken here, not from the model.
  const { client, rpcs } = fake({ approvals: postRow });
  const planned = await prepareDecision(client, "decide_card", { card_id: CARD, action: "approve", content_hash: "b".repeat(64) });
  assert.ok(planned.ok, "a waiting card can be decided");
  assert.equal((planned.prepared as Extract<Prepared, { tool: "decide_card" }>).contentHash, HASH, "the hash is the card's own");
  assert.match(planned.card.changes[0]!, /^Approve "Pricing that fits/);
  const outcome = await runDecision(client, planned.prepared);
  assert.ok(outcome.ok);
  assert.equal(rpcs[0]!.name, "approval_decide");
  assert.deepEqual(rpcs[0]!.args.p_payload, { source: "chat", content_hash: HASH, via: "app" });
  assert.deepEqual(outcome.view, { open: { screen: "dashboard" } });

  // A card already decided, or an unknown one, is never offered.
  assert.equal((await prepareDecision(fake({ approvals: { ...postRow, status: "approved" } }).client, "decide_card", { card_id: CARD, action: "approve" })).ok, false);
  assert.equal((await prepareDecision(fake({}).client, "decide_card", { card_id: CARD, action: "approve" })).ok, false);
  assert.equal((await prepareDecision(fake({ approvals: postRow }).client, "decide_card", { card_id: "not-a-uuid", action: "approve" })).ok, false);

  // A changed card is refused by SQL; the founder is told to look again.
  const changed = {
    from: fake({}).client.from,
    rpc: async () => ({ data: null, error: { message: "This card changed. Look at it again before deciding.", code: "P0001" } }),
  } as unknown as SupabaseClient;
  const refusal = await runDecision(changed, planned.prepared);
  assert.ok(!refusal.ok && /changed since it was shown/.test(refusal.content));

  // Sales settings merge: only the change, the rest kept, nothing to change is refused.
  const sales = fake({ sales_settings: { excluded_subreddits: ["saas"], co_occurrence: [["invoice", "late"]] } });
  const merged = await prepareDecision(sales.client, "set_sales_settings", { exclude: ["r/Memes"], add_pairs: [["late", "invoice"], ["demo", "video"]] });
  assert.ok(merged.ok);
  assert.deepEqual(merged.prepared, { tool: "set_sales_settings", excluded: ["saas", "memes"], pairs: [["invoice", "late"], ["demo", "video"]] });
  assert.equal((await prepareDecision(sales.client, "set_sales_settings", { exclude: ["saas"] })).ok, false, "already excluded");

  // CMO settings: only the given fields change; a bad time zone is refused.
  const profile = fake({ profiles: { weekly_credit_budget: 80, timezone: "Europe/Berlin", digest_hour: 7 } });
  const budget = await prepareDecision(profile.client, "update_cmo_settings", { weekly_credit_budget: 120 });
  assert.ok(budget.ok);
  assert.deepEqual(budget.prepared, { tool: "update_cmo_settings", budget: 120, timezone: "Europe/Berlin", digestHour: 7 });
  assert.equal((await prepareDecision(profile.client, "update_cmo_settings", { timezone: "Mars/Olympus" })).ok, false);
  assert.equal((await prepareDecision(profile.client, "update_cmo_settings", { weekly_credit_budget: 80 })).ok, false, "nothing changes");

  // Local time in the founder's zone → an instant, across a DST change.
  assert.equal(localToIso("2026-07-01T09:00", "Europe/Berlin"), "2026-07-01T07:00:00.000Z");
  assert.equal(localToIso("2026-12-01T09:00", "Europe/Berlin"), "2026-12-01T08:00:00.000Z");
  assert.equal(localToIso("2026-11-03T09:00", "Asia/Ho_Chi_Minh"), "2026-11-03T02:00:00.000Z");

  console.log("cmo-decisions.check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
