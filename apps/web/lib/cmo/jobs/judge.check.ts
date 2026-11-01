/**
 * The cascade judge with a stub `structured`: code failures never reach the model, and a judge
 * that breaks or answers something unknown leaves the case unscored instead of failing it.
 */
import assert from "node:assert/strict";

import { cascade, fakeJudge, modelJudge, type JudgeInput } from "./judge";

const input: JudgeInput = { job: "w2 post_draft", docs: { product: { name: "Paylane" } }, output: "Late invoices are mostly forgotten." };

type Stub = { calls: { label: string; prefer?: string; agent: string }[]; answers: unknown[] };
const stub = (answers: unknown[]) => {
  const state: Stub = { calls: [], answers: [...answers] };
  const call = async (opts: { label: string; prefer?: string; agent: string; onUsage?: (u: never) => unknown }) => {
    state.calls.push({ label: opts.label, prefer: opts.prefer, agent: opts.agent });
    await opts.onUsage?.({ model: "claude-haiku-5-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } as never);
    const next = state.answers.shift();
    if (next instanceof Error) throw next;
    return next as never;
  };
  return { state, call: call as never };
};

async function main() {
  // A code failure ends the case: the judge is never called.
  {
    const { state, call } = stub([]);
    const result = await cascade("w2:invoicing:0", 0, ["uses \"game-changer\""], modelJudge({ drafter: "anthropic", call }), input);
    assert.deepEqual(result, { id: "w2:invoicing:0", epoch: 0, pass: false, decided_by: "code", notes: ["uses \"game-changer\""] });
    assert.equal(state.calls.length, 0);
  }

  // No judge: passing the code is a pass.
  assert.equal((await cascade("w5:x:0", 1, [], null, input)).pass, true);

  // The judge runs as checker on the provider that did not draft; every criterion is asked.
  {
    const { state, call } = stub([{ reasons: "fine", verdict: "post_as_is" }, { reasons: "", met: true }, { reasons: "", met: true }]);
    const result = await cascade("id", 0, [], modelJudge({ drafter: "gemini", call }), { ...input, criteria: ["a", "b"] });
    assert.equal(result.pass, true);
    assert.equal(result.decided_by, "judge");
    assert.equal(result.verdict, "post_as_is");
    assert.equal(state.calls.length, 3);
    assert.ok(state.calls.every((c) => c.agent === "checker" && c.prefer === "anthropic"));
    // Three calls of 1M Haiku 5.5 input tokens each at $0.10.
    assert.ok(Math.abs((result.cost_usd ?? 0) - 0.3) < 1e-9);
  }

  // A failing label is a fail without asking criteria; a failed criterion is a fail.
  {
    const { state, call } = stub([{ reasons: "generic", verdict: "rewrite" }]);
    const result = await cascade("id", 0, [], modelJudge({ drafter: "anthropic", call }), input);
    assert.equal(result.pass, false);
    assert.equal(result.verdict, "rewrite");
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0]!.prefer, "gemini");
  }
  {
    const { call } = stub([{ reasons: "", verdict: "small_edit" }, { reasons: "made up a number", met: false }]);
    const result = await cascade("id", 0, [], modelJudge({ drafter: "anthropic", call }), { ...input, criteria: ["claims", "voice"] });
    assert.equal(result.pass, false);
    assert.match(result.notes?.[0] ?? "", /claims — made up a number/);
  }

  // Thrown errors and unknown labels are unscored, never fails.
  for (const answers of [[new Error("timeout")], [{ reasons: "", verdict: "maybe" }], [{ reasons: "", verdict: "post_as_is" }, new Error("overloaded")]]) {
    const { call } = stub(answers);
    const result = await cascade("id", 0, [], modelJudge({ drafter: "anthropic", call }), input);
    assert.equal(result.pass, null, JSON.stringify(answers));
    assert.equal(result.decided_by, "error");
  }
  // A judge that throws outside its own try (a bug) is unscored too.
  assert.equal((await cascade("id", 0, [], async () => { throw new Error("bug"); }, input)).pass, null);

  // The fake judge walks the whole path with fixed labels.
  {
    const result = await cascade("id", 0, [], fakeJudge(), input);
    assert.deepEqual([result.pass, result.decided_by, result.verdict], [true, "judge", "small_edit"]);
  }

  console.log("judge.check: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
