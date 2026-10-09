import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { state } from "./helpers";

/** Dùng cùng stack cô lập, kiểm cả quyền đọc và redirect tải file thật. */
test("hợp đồng API qua cookie và Supabase thật", async () => {
  const { url, anon, service } = state();
  const result = spawnSync("npx", ["tsx", "lib/api/contract.check.ts"], {
    cwd: join(__dirname, ".."), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service,
      CHECK_API_BASE: "http://127.0.0.1:3100" },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
