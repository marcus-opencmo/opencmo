/**
 * Assistant providers, offline: tool schemas build correctly, Claude history maps tool results and
 * images, and chats saved while Gemini was a provider still read back.
 *
 *     NODE_OPTIONS=--conditions=react-server tsx lib/agent/providers.check.ts
 */
import assert from "node:assert/strict";

import { anthropicFormat } from "./providers/anthropic";
import { geminiFormat } from "./providers/gemini-history";
import { BROWSER_INPUTS, TOOL_SPECS } from "./tools";

// ---------------------------------------------------------------- tool
const names = TOOL_SPECS.map((spec) => spec.name);
assert.ok(names.includes("capture"), "có tool trình duyệt capture");
assert.ok(names.includes("set_frame") && names.includes("remove_words"), "op của editor-core là tool");
assert.equal(new Set(names).size, names.length, "tên tool không trùng");
assert.ok("capture" in BROWSER_INPUTS && !("set_frame" in BROWSER_INPUTS));
const text = JSON.stringify(TOOL_SPECS.map((spec) => spec.schema));
for (const banned of ['"pattern"', '"minimum"', '"maxLength"', '"$schema"', '"propertyNames"']) {
  assert.ok(!text.includes(banned), `schema gửi API không còn ${banned}`);
}
assert.equal(TOOL_SPECS.find((spec) => spec.name === "update_element")!.strict, false, "record không strict");
assert.equal(TOOL_SPECS.find((spec) => spec.name === "set_frame")!.strict, true);

async function main(): Promise<void> {
// ---------------------------------------------------------------- saved Gemini chats
const saved = [
  { text: "Planning the frame.", thought: true },
  { text: "Switching to square." },
  { functionCall: { name: "set_frame", args: { width: 1080, height: 1080 } }, thoughtSignature: "sig-A" },
  { functionCall: { id: "call-xyz", name: "capture", args: { times: [1] } } },
];
assert.deepEqual(geminiFormat.callsIn(saved).map((call) => [call.id, call.name]), [
  ["gc_2", "set_frame"],
  ["call-xyz", "capture"],
], "saved calls read back with the ids sent to the browser");
assert.equal(geminiFormat.replyText(saved), "Switching to square.", "reply without thinking");

// ---------------------------------------------------------------- Claude
const claude = anthropicFormat.toolResults(
  [{ id: "toolu_1", name: "capture", ok: true, content: "{}", images: [{ data: "AAAA", mimeType: "image/jpeg" }] }],
  "state",
) as { type: string; content?: { type: string }[] }[];
assert.deepEqual(claude.map((block) => block.type), ["tool_result", "text"], "tool_result trước, chữ sau");
assert.deepEqual(claude[0]!.content!.map((block) => block.type), ["text", "image"]);

// ---------------------------------------------------------------- bớt ảnh cũ
// Ba tin nhắn có ảnh: chỉ hai cái mới nhất giữ ảnh; đầu vào không bị sửa.
const withImage = (id: string) => ({
  role: "user" as const,
  content: anthropicFormat.toolResults([{ id, name: "capture", ok: true, content: "{}", images: [{ data: "AAAA", mimeType: "image/jpeg" }] }]),
});
const history = [withImage("a"), { role: "assistant" as const, content: [] }, withImage("b"), withImage("c")];
const trimmed = anthropicFormat.trimImages(history, 2);
const imagesIn = (message: { content: unknown[] }) => JSON.stringify(message.content).split('"type":"image"').length - 1;
assert.deepEqual(trimmed.map(imagesIn), [0, 0, 1, 1], "Claude: chỉ giữ ảnh của 2 tin nhắn cuối");
assert.equal(imagesIn(history[0]!), 1, "lịch sử gốc giữ nguyên");
assert.match(JSON.stringify(trimmed[0]!.content), /image omitted/);
const geminiHistory = ["a", "b", "c"].map((id) => ({
  role: "user" as const,
  content: geminiFormat.toolResults([{ id, name: "capture", ok: true, content: "{}", images: [{ data: "AAAA", mimeType: "image/jpeg" }] }]),
}));
const geminiTrimmed = geminiFormat.trimImages(geminiHistory, 2);
assert.deepEqual(geminiTrimmed.map((message) => JSON.stringify(message.content).includes("inlineData")), [false, true, true], "Gemini: như Claude");

// Ảnh đính kèm ở đầu lượt cũng bị bớt khi đã cũ (review PR 19): không thì nó đi theo mọi request.
const attached = { role: "user" as const, content: anthropicFormat.userTurn("hi", "state", [{ data: "AAAA", mimeType: "image/jpeg" }]) };
assert.deepEqual(anthropicFormat.trimImages([attached, withImage("x"), withImage("y")], 2).map(imagesIn), [0, 1, 1]);
const geminiAttached = { role: "user" as const, content: geminiFormat.userTurn("hi", "state", [{ data: "AAAA", mimeType: "image/jpeg" }]) };
assert.equal(JSON.stringify(geminiFormat.trimImages([geminiAttached, ...geminiHistory.slice(1)], 2)[0]!.content).includes("inlineData"), false);

// Ảnh đính kèm câu lệnh (khung đang xem) nằm giữa câu lệnh và trạng thái.
assert.deepEqual(
  (anthropicFormat.userTurn("hi", "<project_state>{}</project_state>", [{ data: "AAAA", mimeType: "image/jpeg" }]) as { type: string }[]).map((block) => block.type),
  ["text", "image", "text"],
);

console.log("agent providers: mọi kiểm tra xanh");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
