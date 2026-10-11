/**
 * Checks the agent registry (H1): Claude per tier, per-agent env overrides, an agent's own key wins
 * over the shared key, and a missing key leaves `apiKey` empty. Run with
 * `NODE_OPTIONS=--conditions=react-server tsx …`.
 */

import assert from "node:assert/strict";

import { AGENT_IDS, agentTable, resolveAgent } from "./registry";

const base = { ANTHROPIC_API_KEY: "a-shared" } as unknown as NodeJS.ProcessEnv;

// Default: Opus for drafting agents, Haiku for checking agents, the shared key.
const planner = resolveAgent("planner", base);
assert.equal(planner.provider, "anthropic");
assert.equal(planner.model, "claude-opus-5-5");
assert.equal(planner.apiKey, "a-shared");
assert.equal(planner.source, "default");
assert.equal(resolveAgent("checker", base).model, "claude-haiku-4-5");

// Per-agent override: model and key; other agents are unaffected.
const env = { ...base, CMO_AGENT_X_WRITER_MODEL: "claude-sonnet-5-5", CMO_AGENT_X_WRITER_API_KEY: "a-writer" } as unknown as NodeJS.ProcessEnv;
const writer = resolveAgent("x_writer", env);
assert.deepEqual([writer.model, writer.apiKey, writer.source], ["claude-sonnet-5-5", "a-writer", "env"]);
assert.equal(resolveAgent("planner", env).apiKey, "a-shared");

// No key: empty (the caller reports it in English).
assert.equal(resolveAgent("cmo", {} as unknown as NodeJS.ProcessEnv).apiKey, "");

// The diagnostics table holds no keys.
const table = agentTable(env);
assert.equal(table.length, AGENT_IDS.length);
assert.ok(!JSON.stringify(table).includes("a-writer"));

console.log(`agent registry: ${AGENT_IDS.length} agents, env overrides correct`);
