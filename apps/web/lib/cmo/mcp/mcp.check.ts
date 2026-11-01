/**
 * Session B's MCP groups, offline: names, annotations, schemas, the inbox step table and the
 * prompts. The tools themselves run against Supabase in the e2e run (B10).
 *
 *     NODE_OPTIONS=--conditions=react-server tsx lib/cmo/mcp/mcp.check.ts
 */
import assert from "node:assert/strict";

import { INBOX_STEP_NAMES, INBOX_STEPS, parseAnswer, stepsFor } from "../jobs/steps";
import { CMO_SKILLS } from "../skills/index.gen";

import { ACCOUNT_GROUP, CMO_GROUP, INBOX_GROUP } from "./index";
import { ok } from "./contract";
import { requestId } from "./inbox";

const tools = [...CMO_GROUP.tools!, ...INBOX_GROUP.tools!, ...ACCOUNT_GROUP.tools!];
const names = tools.map((tool) => tool.name);
assert.equal(new Set(names).size, names.length, "tool names are unique");
assert.equal(CMO_GROUP.tools!.length, 20, "the CMO chat's 20 tools (P6: search_hackernews)");
assert.ok(names.includes("read_cmo_playbook") && !names.includes("read_skill"), "read_skill is left to the editor group");
assert.ok(names.includes("get_video_transcript") && !names.includes("get_transcript"), "get_transcript is left to the editor group");
for (const tool of tools) {
  assert.match(tool.name, /^[a-z_]{3,40}$/, tool.name);
  assert.ok(tool.title && tool.description.length > 20, `${tool.name} is described`);
  assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name} says whether it writes`);
  assert.ok(!tool.costsCredits, `${tool.name}: no B tool spends credits`);
}
assert.equal(tools.find((t) => t.name === "search_reddit")!.annotations.openWorldHint, true, "social reads reach the outside world");
assert.equal(tools.find((t) => t.name === "create_task")!.annotations.readOnlyHint, false);
assert.ok(tools.find((t) => t.name === "create_task")!.description.includes("inbox"), "create_task says where the work comes back");
assert.ok(!/\d+ credits?/.test(tools.find((t) => t.name === "create_task")!.description), "no in-app prices on create_task over MCP");

// Input schemas converted from the chat's JSON Schema still accept and refuse what they should.
const input = (name: string) => tools.find((t) => t.name === name)!.inputSchema;
assert.ok(input("read_doc").safeParse({ kind: "product" }).success);
assert.ok(!input("read_doc").safeParse({ kind: "nope" }).success);
assert.ok(input("create_task").safeParse({ agent: "planner", brief: "Plan launch week", when: "now" }).success);

// Every inbox step has exactly one submit tool, and the tool accepts it.
for (const step of INBOX_STEP_NAMES) {
  const tool = tools.find((t) => t.name === INBOX_STEPS[step].submit);
  assert.ok(tool, `${step} has a submit tool`);
  assert.ok(stepsFor(INBOX_STEPS[step].submit).includes(step));
  assert.ok(tool!.inputSchema.safeParse({ id: "00000000-0000-4000-8000-000000000001", step, answer: {} }).success, `${tool!.name} takes step ${step}`);
}
assert.ok(!tools.find((t) => t.name === "submit_plan")!.inputSchema.safeParse({ id: "00000000-0000-4000-8000-000000000001", step: "draft_post", answer: {} }).success, "a submit tool refuses another kind's step");

// Answers are checked against the job's own schema.
assert.ok(parseAnswer("make_queries", { queries: ["late invoices"] }).ok);
const wrong = parseAnswer("draft_post", { versions: "three" });
assert.ok(!wrong.ok && wrong.error.includes("versions"), "the error names the field");

// Idempotency key: stable, a UUID, different for a different answer.
const a = requestId("i1", "draft_post", { x: 1 });
assert.equal(a, requestId("i1", "draft_post", { x: 1 }));
assert.notEqual(a, requestId("i1", "draft_post", { x: 2 }));
assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

// Clients that show the model only structuredContent still get the whole text.
assert.equal(ok("Read this.", { id: "x" }).structuredContent!.message, "Read this.");

// Prompts and resources.
const prompts = CMO_GROUP.prompts!;
assert.deepEqual(prompts.map((p) => p.name), ["onboard", "plan-week", "sales-scan", "inbox"]);
for (const prompt of prompts) {
  const text = prompt.render({});
  assert.ok(!text.includes("undefined") && text.includes("Never post"), `${prompt.name} renders with the rules`);
}
assert.ok(prompts[1]!.render({ brief: "Launch week" }).includes("\"Launch week\""));
const resources = CMO_GROUP.resources!;
const marketing = Object.values(CMO_SKILLS).filter((s) => s.kind === "marketing").length;
const playbooks = Object.values(CMO_SKILLS).filter((s) => s.kind === "playbook").length;
assert.equal(resources.length, marketing + playbooks);
assert.equal(new Set(resources.map((r) => r.uri)).size, resources.length, "resource URIs are unique");
assert.ok(resources.every((r) => /^opencmo:\/\/skills\/(cmo|library)\/[a-z0-9-]+$/.test(r.uri)));

console.log(`mcp.check — ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources (${playbooks} playbooks, ${marketing} marketing).`);
