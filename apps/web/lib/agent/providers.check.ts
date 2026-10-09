/**
 * Provider của Assistant, không mạng: schema tool dựng đúng cho cả hai họ, và
 * Gemini map lịch sử/tool/ảnh/usage đúng trên một response ghi sẵn.
 *
 *     NODE_OPTIONS=--conditions=react-server tsx lib/agent/providers.check.ts
 */
import assert from "node:assert/strict";

import type { GoogleGenAI } from "@google/genai";

import { anthropicFormat } from "./providers/anthropic";
import { geminiFormat, geminiProvider } from "./providers/gemini";
import type { Delta } from "./providers/types";
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
// ---------------------------------------------------------------- Gemini
const chunks = [
  { candidates: [{ content: { role: "model", parts: [{ text: "Planning the frame.", thought: true }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "Switching to square." }] } }] },
  {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "set_frame", args: { width: 1080, height: 1080 } }, thoughtSignature: "sig-A" },
            { functionCall: { id: "call-xyz", name: "capture", args: { times: [1] } } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4000, candidatesTokenCount: 60, thoughtsTokenCount: 40 },
    modelVersion: "gemini-9-pro-preview",
  },
];
let sent: { model?: string; contents?: unknown; config?: Record<string, unknown> } = {};
const client = {
  models: {
    generateContentStream: async (params: typeof sent) => {
      sent = params;
      return (async function* () {
        yield* chunks;
      })();
    },
  },
} as unknown as Pick<GoogleGenAI, "models">;

const deltas: Delta[] = [];
const provider = geminiProvider("test", client);
const step = await provider.step(
  {
    history: [{ role: "user", content: geminiFormat.userTurn("make it square", "<project_state>{}</project_state>") }],
    tools: TOOL_SPECS,
    system: "system prompt",
  },
  (delta) => deltas.push(delta),
);
assert.equal(sent.config!.systemInstruction, "system prompt", "system prompt theo phạm vi phiên");

assert.deepEqual((sent.contents as { role: string }[]).map((content) => content.role), ["user"]);
assert.equal((sent.config!.automaticFunctionCalling as { disable: boolean }).disable, true, "SDK không tự chạy tool");
assert.equal(((sent.config!.tools as { functionDeclarations: unknown[] }[])[0]!.functionDeclarations).length, TOOL_SPECS.length);

assert.equal(step.stop, "tool");
assert.equal(step.model, "gemini-9-pro-preview", "usage tính theo model thật");
assert.deepEqual(step.usage, { input: 1000, output: 100, cacheRead: 4000, cacheWrite: 0 });
assert.deepEqual(step.toolCalls.map((call) => [call.id, call.name]), [
  ["gc_2", "set_frame"],
  ["call-xyz", "capture"],
]);
assert.equal((step.content as { thoughtSignature?: string }[])[2]!.thoughtSignature, "sig-A", "thoughtSignature giữ nguyên");
assert.deepEqual(geminiFormat.callsIn(step.content), step.toolCalls, "đọc lại tin nhắn đã lưu ra đúng id");
assert.equal(geminiFormat.replyText(step.content), "Switching to square.", "trả lời không lẫn suy nghĩ");
assert.deepEqual(deltas.map((delta) => delta.type), ["thinking", "text", "tool_start", "tool_start"]);

const reply = geminiFormat.toolResults(
  [
    { id: "gc_2", name: "set_frame", ok: true, content: '{"ok":true,"version":3}' },
    { id: "call-xyz", name: "capture", ok: true, content: '{"ok":true}', images: [{ data: "AAAA", mimeType: "image/jpeg" }] },
    { id: "gc_9", name: "remove_words", ok: false, content: '{"error":"The word \\"x\\" is not in this transcript."}' },
  ],
  "<project_state>{}</project_state>",
) as { functionResponse?: { id?: string; name: string; response: Record<string, unknown>; parts?: unknown[] }; text?: string }[];
assert.equal(reply[0]!.functionResponse!.id, undefined, "id tự sinh không gửi cho Gemini");
assert.deepEqual(reply[0]!.functionResponse!.response, { ok: true, version: 3 });
assert.equal(reply[1]!.functionResponse!.id, "call-xyz");
assert.deepEqual(reply[1]!.functionResponse!.parts, [{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }], "ảnh đi trong functionResponse");
assert.deepEqual(reply[2]!.functionResponse!.response, { error: { error: 'The word "x" is not in this transcript.' } });
assert.equal(reply[3]!.text, "<project_state>{}</project_state>", "trạng thái đứng sau kết quả tool");

// Từ chối an toàn → refusal; hết token → max_tokens.
for (const [finish, stop] of [["SAFETY", "refusal"], ["MAX_TOKENS", "max_tokens"]] as const) {
  const blocked = geminiProvider("test", {
    models: {
      generateContentStream: async () =>
        (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "…" }] }, finishReason: finish }] };
        })(),
    },
  } as unknown as Pick<GoogleGenAI, "models">);
  assert.equal((await blocked.step({ history: [], tools: [], system: "" }, () => undefined)).stop, stop);
}

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
