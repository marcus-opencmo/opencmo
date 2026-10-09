import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { build } from "esbuild";
import { expect, test } from "@playwright/test";

/**
 * Editor ngoài Chromium (plan S1–S2): cổng dò tính năng và chỗ giữ bytes thư viện chạy
 * trên engine THẬT của Firefox và WebKit, không cần cả stack. Gói `entry.ts` bằng
 * esbuild (có sẵn qua tsx) rồi phục vụ ở localhost — OPFS/IndexedDB cần secure context.
 */

let server: Server;
let origin = "";

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(__dirname, "entry.ts")],
    bundle: true,
    format: "iife",
    write: false,
    target: "es2020",
    alias: { "@": join(__dirname, "..") },
  });
  const script = bundle.outputFiles[0]!.text;
  server = createServer((request, response) => {
    if (request.url === "/compat.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script src="/compat.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("cổng editor: máy tính đủ tính năng thì vào", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin);
  const facts = await page.evaluate(() => window.compat.facts!());
  const verdict = (await page.evaluate(() => window.compat.verdict!())) as { ok: boolean; reason?: string };
  console.log(`[compat] ${browserName}`, JSON.stringify(facts), JSON.stringify(verdict));
  expect(facts).toMatchObject({ storage: true, offscreen2d: true, audio: true, touchOnly: false });
  // Bản Linux của Firefox/WebKit trong CI có thể thiếu H.264 — chỉ khi đó mới được chặn, và chặn đúng lý do.
  if ((facts as { h264: boolean }).h264) expect(verdict).toEqual({ ok: true });
  else expect(verdict).toEqual({ ok: false, reason: "codec" });
});

test("thư viện giữ được bytes trên máy", async ({ page }) => {
  await page.goto(origin);
  const result = await page.evaluate(() => window.compat.roundtrip!("compat-clip" as never, "assets/Frames/a.png" as never));
  expect(result).toEqual({ size: 4096, type: "image/png", same: true, gone: true });
});

test("thiếu createWritable (Safari 17) thì đi IndexedDB", async ({ page }) => {
  await page.addInitScript(() => {
    const proto = (globalThis as unknown as { FileSystemFileHandle?: { prototype: Record<string, unknown> } }).FileSystemFileHandle?.prototype;
    if (proto && "createWritable" in proto) delete proto.createWritable;
  });
  await page.goto(origin);
  expect(await page.evaluate(() => window.compat.canWriteOpfs!())).toBe(false);
  const result = await page.evaluate(() => window.compat.roundtrip!("compat-clip" as never, "assets/b.png" as never));
  expect(result).toEqual({ size: 4096, type: "image/png", same: true, gone: true });
});
