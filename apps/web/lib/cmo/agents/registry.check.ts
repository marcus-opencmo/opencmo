/**
 * Kiểm sổ agent (H1): mặc định Gemini theo tầng, override env theo từng agent, khoá riêng thắng
 * khoá chung, thiếu khoá thì `apiKey` rỗng. Chạy: `NODE_OPTIONS=--conditions=react-server tsx …`.
 */

import assert from "node:assert/strict";

import { AGENT_IDS, agentTable, resolveAgent } from "./registry";

const base = { GEMINI_API_KEY: "g-shared" } as unknown as NodeJS.ProcessEnv;

// Mặc định: Gemini, Pro cho agent soạn, Flash cho agent kiểm; khoá chung.
const planner = resolveAgent("planner", base);
assert.equal(planner.provider, "gemini");
assert.equal(planner.model, "gemini-pro-latest");
assert.equal(planner.apiKey, "g-shared");
assert.equal(planner.source, "default");
assert.equal(resolveAgent("checker", base).model, "gemini-flash-latest");

// Có khoá Anthropic chung KHÔNG tự đổi provider: chỉ env của agent mới đổi.
assert.equal(resolveAgent("sales", { ...base, ANTHROPIC_API_KEY: "a" }).provider, "gemini");

// Override theo agent: provider + model + khoá riêng; agent khác không bị ảnh hưởng.
const env = {
  ...base,
  ANTHROPIC_API_KEY: "a-shared",
  CMO_AGENT_SALES_PROVIDER: "anthropic",
  CMO_AGENT_X_WRITER_MODEL: "gemini-2.5-pro",
  CMO_AGENT_X_WRITER_API_KEY: "g-writer",
} as unknown as NodeJS.ProcessEnv;
const sales = resolveAgent("sales", env);
assert.deepEqual([sales.provider, sales.model, sales.apiKey, sales.source], ["anthropic", "claude-opus-5-5", "a-shared", "env"]);
const writer = resolveAgent("x_writer", env);
assert.deepEqual([writer.provider, writer.model, writer.apiKey], ["gemini", "gemini-2.5-pro", "g-writer"]);
assert.equal(resolveAgent("planner", env).apiKey, "g-shared");

// Provider lạ rơi về gemini; thiếu khoá thì rỗng (nơi gọi báo lỗi tiếng Anh).
const errors = console.error;
console.error = () => undefined;
assert.equal(resolveAgent("cmo", { ...base, CMO_AGENT_CMO_PROVIDER: "openai" } as unknown as NodeJS.ProcessEnv).provider, "gemini");
console.error = errors;
assert.equal(resolveAgent("cmo", {} as unknown as NodeJS.ProcessEnv).apiKey, "");

// Bảng chẩn đoán không chứa khoá.
const table = agentTable(env);
assert.equal(table.length, AGENT_IDS.length);
assert.ok(!JSON.stringify(table).includes("g-writer"));

console.log(`agent registry: ${AGENT_IDS.length} agent, override env đúng`);
