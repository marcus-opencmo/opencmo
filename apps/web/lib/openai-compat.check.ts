/**
 * The OpenAI-compatible client against a local fake endpoint: the request it sends, JSON mode when
 * `json_schema` is refused, and which failures are outages (move to the next provider) and which
 * are the request's; then a CMO agent's `structured` call on it.
 * Run with `NODE_OPTIONS=--conditions=react-server tsx lib/openai-compat.check.ts`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import { structured } from "@/lib/cmo/jobs/llm";

import { clearHealth, outage } from "./llm-health";
import { compatJson, OpenAiCompatError, OpenAiCompatTimeout } from "./openai-compat";

type Seen = { auth?: string; body: { model: string; response_format: { type: string }; messages: { role: string; content: unknown }[] } };
type Reply = { status: number; body: unknown; delayMs?: number };

async function main() {
  const seen: Seen[] = [];
  let replies: Reply[] = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const reply = replies.shift() ?? { status: 500, body: { error: { message: "no reply queued" } } };
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const answer = (content: string, finish = "stop") => ({
    status: 200,
    body: { model: "served-model", choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } },
  });
  const request = { baseUrl, apiKey: "k-test", model: "m-test", system: "sys", content: "hello", schema: { type: "object", properties: { ok: { type: "boolean" } } } };
  const failure = async (fn: () => Promise<unknown>) => fn().then(() => assert.fail("expected an error"), (error: unknown) => error);

  try {
    // A JSON answer: bearer key, the schema as response_format, usage without the cached part.
    replies = [answer('{"ok":true}')];
    const ok = await compatJson(request);
    assert.deepEqual(ok, { json: { ok: true }, model: "served-model", usage: { input: 100, output: 30, cacheRead: 20 } });
    assert.equal(seen[0]!.auth, "Bearer k-test");
    assert.equal(seen[0]!.body.model, "m-test");
    assert.equal(seen[0]!.body.response_format.type, "json_schema");
    assert.deepEqual(seen[0]!.body.messages.map((m) => m.role), ["system", "user"]);

    // An endpoint without json_schema: one more try in JSON mode, the schema in the system prompt.
    seen.length = 0;
    replies = [{ status: 400, body: { error: { message: "response_format json_schema is not supported by this model" } } }, answer('{"ok":false}')];
    assert.deepEqual((await compatJson(request)).json, { ok: false });
    assert.equal(seen[1]!.body.response_format.type, "json_object");
    assert.match(String(seen[1]!.body.messages[0]!.content), /JSON schema/);

    // Outages move on; the request's own problems do not.
    const cases: [Reply, string | null][] = [
      [{ status: 401, body: { error: { message: "Invalid API Key" } } }, "account"],
      // Review R6: one missing model id is that model's problem (quota-like), not the provider's key.
      [{ status: 404, body: { error: { message: "The model `x` does not exist" } } }, "quota"],
      [{ status: 429, body: { error: { message: "Rate limit reached on tokens per minute (TPM)" } } }, "busy"],
      [{ status: 429, body: { error: { message: "Rate limit reached on tokens per day (TPD)" } } }, "quota"],
      [{ status: 503, body: { error: { message: "over capacity" } } }, "busy"],
      [{ status: 400, body: { error: { message: "messages: too long" } } }, null],
    ];
    for (const [reply, kind] of cases) {
      replies = [reply];
      const error = await failure(() => compatJson(request));
      assert.ok(error instanceof OpenAiCompatError, String(error));
      assert.equal(outage(error), kind, `${reply.status} ${JSON.stringify(reply.body)}`);
    }
    const unreachable = await failure(() => compatJson({ ...request, baseUrl: "http://127.0.0.1:9/v1" }));
    assert.equal(outage(unreachable), "busy", "an endpoint that cannot be reached is busy");

    // A malformed or cut-off answer is the model's: not an outage.
    replies = [answer("not json")];
    assert.equal(outage(await failure(() => compatJson(request))), null);
    replies = [answer('{"ok":', "length")];
    assert.equal(outage(await failure(() => compatJson(request))), null);

    // Our own time limit: the request's, never a reason to move every user off the provider.
    replies = [{ ...answer('{"ok":true}'), delayMs: 300 }];
    const slow = await failure(() => compatJson({ ...request, timeoutMs: 50 }));
    assert.ok(slow instanceof OpenAiCompatTimeout);
    assert.equal(outage(slow), null);

    // A CMO agent on Groq: the check tier's model, the shared key, zod as the gate.
    for (const name of Object.keys(process.env)) if (/^(CMO_|ANTHROPIC_|GEMINI_|GOOGLE_API|GROQ_|OPENAI_COMPAT_)/.test(name)) delete process.env[name];
    process.env.OPENAI_COMPAT_API_KEY = "q-env";
    process.env.OPENAI_COMPAT_BASE_URL = baseUrl;
    clearHealth();
    seen.length = 0;
    const schema = z.object({ score: z.number() });
    const call = { agent: "checker" as const, system: "s", prompt: "p", schema, label: "check", failure: "Could not check." };
    replies = [answer('{"score":3}')];
    assert.deepEqual(await structured(call), { score: 3 });
    assert.equal(seen[0]!.body.model, "openai/gpt-oss-20b");
    assert.equal(seen[0]!.auth, "Bearer q-env");
    replies = [answer('{"score":"high"}')];
    await assert.rejects(structured(call), /Could not check/, "an answer outside the schema is refused");
  } finally {
    server.closeAllConnections();
    server.close();
  }

  console.log("openai-compat: request shape, JSON-mode retry and outage kinds correct");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
