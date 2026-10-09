/**
 * Chạy THẬT, không chỉ kiểm lúc typecheck.
 *
 *     cd apps/web && npx tsx lib/api/handler.check.ts
 *
 * `withApi` là nơi năm luật chung của API sống — đăng nhập, cross-site, trần
 * body, rate limit, hình dạng lỗi. Kiểu không nói được "chưa đăng nhập thì 401"
 * hay "body 300KB thì 413", nên chúng được gọi thật ở đây qua `handleApi` với
 * một Supabase giả. Thoát mã khác 0 khi lệch.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { apiErrorFromPostgrest } from "./errors";
import { MAX_BODY_BYTES, handleApi, type SupabaseClient } from "./handler";

type FakeUser = { id: string; email: string } | null;

const SIGNED_IN: FakeUser = { id: "user-1", email: "a@test.local" };

function fakeClient(
  { user = SIGNED_IN, rateLimit = true }: { user?: FakeUser; rateLimit?: boolean } = {},
): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({
        data: { user },
        error: user ? null : { message: "no session" },
      }),
    },
    rpc: async (name: string) =>
      name === "rate_limit_hit"
        ? { data: rateLimit, error: null }
        : { data: null, error: null },
    // Client thật có vài chục phương thức; `handleApi` chỉ chạm hai cái trên.
  } as unknown as SupabaseClient;
}

function request(
  method: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    headers: new Headers({ host: "app.opencmo.io", ...headers }),
    text: async () => text,
  } as unknown as Parameters<typeof handleApi>[2];
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const ok = async () => ({ ok: true });

  await check("chưa đăng nhập thì 401 với câu tiếng Anh", async () => {
    const res = await handleApi({}, ok, request("GET"), fakeClient({ user: null }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { detail: "Please sign in again." });
  });

  await check("POST từ site khác bị chặn trước cả khi đọc phiên", async () => {
    const res = await handleApi(
      {},
      ok,
      request("POST", { headers: { origin: "https://evil.example" } }),
      fakeClient({ user: null }),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).detail, "Cross-site access denied.");
  });

  await check("Sec-Fetch-Site: cross-site cũng bị chặn", async () => {
    const res = await handleApi(
      {},
      ok,
      request("POST", { headers: { "sec-fetch-site": "cross-site" } }),
      fakeClient(),
    );
    assert.equal(res.status, 403);
  });

  await check("GET không bị chặn bởi Origin lạ (cookie SameSite lo phần đó)", async () => {
    const res = await handleApi(
      {},
      ok,
      request("GET", { headers: { origin: "https://evil.example" } }),
      fakeClient(),
    );
    assert.equal(res.status, 200);
  });

  await check("body sai zod thành 422 kèm message của trường đầu tiên", async () => {
    const res = await handleApi(
      { body: z.object({ clips: z.number().int().min(1).max(10) }) },
      ok,
      request("POST", { body: { clips: 99 } }),
      fakeClient(),
    );
    assert.equal(res.status, 422);
    assert.match((await res.json()).detail, /clips:/);
  });

  await check("body quá 256KB bị từ chối trước khi parse", async () => {
    const res = await handleApi(
      { body: z.object({ big: z.string() }) },
      ok,
      request("POST", { body: { big: "x".repeat(MAX_BODY_BYTES) } }),
      fakeClient(),
    );
    assert.equal(res.status, 413);
  });

  await check("body không phải JSON thành 422, không phải 500", async () => {
    const bad = request("POST");
    bad.text = async () => "{oops";
    const res = await handleApi({ body: z.object({}) }, ok, bad, fakeClient());
    assert.equal(res.status, 422);
  });

  await check("vượt rate limit thành 429", async () => {
    const res = await handleApi(
      { rateLimit: { bucket: "jobs", limit: 10, windowSeconds: 3600 } },
      ok,
      request("GET"),
      fakeClient({ rateLimit: false }),
    );
    assert.equal(res.status, 429);
    assert.equal((await res.json()).detail, "Too many requests. Try again in a minute.");
  });

  await check("mọi response đều no-store", async () => {
    const res = await handleApi({}, ok, request("GET"), fakeClient());
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  await check("params của route được await rồi chuyển vào handler", async () => {
    const res = await handleApi(
      {},
      async ({ params }) => ({ id: params.id }),
      request("GET"),
      fakeClient(),
      { params: Promise.resolve({ id: "abc" }) },
    );
    assert.deepEqual(await res.json(), { id: "abc" });
  });

  await check("lỗi không lường thành 500 với câu chung", async () => {
    const res = await handleApi(
      {},
      async () => {
        throw new Error("cột `x` không tồn tại");
      },
      request("GET"),
      fakeClient(),
    );
    assert.equal(res.status, 500);
    assert.equal((await res.json()).detail, "Something went wrong. Please try again.");
  });

  // ---------------------------------------------------------- map lỗi Postgres

  await check("P0409 giữ nguyên message và mang theo draft hiện hành", async () => {
    const error = apiErrorFromPostgrest({
      code: "P0409",
      message: "This clip was changed in another tab.",
      details: JSON.stringify({ clip_id: "clip-1", revision: 4 }),
    });
    assert.equal(error.status, 409);
    assert.deepEqual(error.detail, {
      message: "This clip was changed in another tab.",
      current: { clip_id: "clip-1", revision: 4 },
    });
  });

  await check("P0002 thành 404, 22023 thành 422, 28000 thành 401", async () => {
    assert.equal(apiErrorFromPostgrest({ code: "P0002", message: "Clip not found." }).status, 404);
    assert.equal(apiErrorFromPostgrest({ code: "22023", message: "Bad value." }).status, 422);
    const signedOut = apiErrorFromPostgrest({ code: "28000", message: "Not signed in." });
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.message, "Please sign in again.");
  });

  await check("chỉ đúng câu quota SQL thành 429", async () => {
    assert.equal(
      apiErrorFromPostgrest({
        code: "P0001",
        message: "You have reached today's limit for this plan.",
      }).status,
      429,
    );
    assert.equal(
      apiErrorFromPostgrest({
        code: "P0001",
        message: "You have reached today's limit for another plan.",
      }).status,
      409,
    );
  });

  await check("unique_violation thô KHÔNG lộ tên index", async () => {
    const error = apiErrorFromPostgrest({
      code: "23505",
      message: 'duplicate key value violates unique constraint "tasks_request_id_key"',
    });
    assert.equal(error.status, 409);
    assert.equal(error.message, "That already exists. Refresh the page and try again.");
    // Câu do chính ta ném vẫn đi thẳng ra như cũ.
    assert.equal(
      apiErrorFromPostgrest({
        code: "23505",
        message: "A preset with this name already exists.",
      }).message,
      "A preset with this name already exists.",
    );
  });

  await check("mã ngoài allowlist KHÔNG lộ message của Postgres", async () => {
    const error = apiErrorFromPostgrest({
      code: "23503",
      message: 'insert or update on table "tasks" violates foreign key constraint',
    });
    assert.equal(error.status, 500);
    assert.equal(error.message, "Something went wrong. Please try again.");
  });

  // `rate_limit_hit` chỉ nhận các bộ (bucket, limit, window) có trong danh sách của nó;
  // bộ lạ trả 422 "Invalid rate limit." cho MỌI request — route chết mà typecheck vẫn xanh.
  await check("mọi rateLimit của route có trong danh sách của rate_limit_hit", async () => {
    const migrations = join(__dirname, "../../../../supabase/migrations");
    const latest = readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => readFileSync(join(migrations, f), "utf8").includes("function public.rate_limit_hit("))
      .pop()!;
    const sql = readFileSync(join(migrations, latest), "utf8");
    const allowed = new Set([...sql.matchAll(/p_bucket = '([\w-]+)' and p_limit = (\d+) and p_window_seconds = (\d+)/g)].map((m) => `${m[1]}/${m[2]}/${m[3]}`));
    assert.ok(allowed.size > 5, `không đọc được danh sách trong ${latest}`);
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === "route.ts") {
          for (const m of readFileSync(path, "utf8").matchAll(/bucket: "([\w-]+)", limit: (\d+), windowSeconds: (\d+)/g)) {
            if (["preview", "export", "daily_preview", "daily_export"].includes(m[1]!)) continue;
            if (!allowed.has(`${m[1]}/${m[2]}/${m[3]}`)) bad.push(`${path.split("/app/api/")[1]}: ${m[1]} ${m[2]}/${m[3]}s`);
          }
        }
      }
    };
    walk(join(__dirname, "../../app/api"));
    assert.deepEqual(bad, [], `ngoài danh sách (${latest}):\n${bad.join("\n")}`);
  });

  if (failures.length > 0) {
    console.error(`${failures.length} kiểm tra hỏng:`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log("withApi: mọi kiểm tra xanh");
}

void main();
