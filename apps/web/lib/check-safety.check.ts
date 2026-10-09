/**
 * Security contract cho các executable check có quyền service-role.
 *
 *     cd apps/web && npx tsx lib/check-safety.check.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { localSupabaseCredentials } from "./local-supabase";

const cwd = process.cwd();
const tsxCli = path.resolve(cwd, "../../node_modules/tsx/dist/cli.mjs");
const failures: string[] = [];

function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("helper dùng binary trực tiếp và child env theo allowlist", () => {
  process.env.OPENCMO_SENTINEL_SECRET = "must-not-reach-child";
  try {
    const credentials = localSupabaseCredentials({
      cwd,
      executable: "/opt/opencmo/bin/supabase",
      run: (executable, args, options) => {
        assert.equal(executable, "/opt/opencmo/bin/supabase");
        assert.deepEqual(args, ["status", "-o", "env"]);
        assert.equal("OPENCMO_SENTINEL_SECRET" in options.env, false);
        assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "LC_ALL", "NODE_ENV", "PATH"]);
        return 'API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="local-only"\n';
      },
    });
    assert.deepEqual(credentials, {
      url: "http://127.0.0.1:54321",
      serviceRoleKey: "local-only",
    });
  } finally {
    delete process.env.OPENCMO_SENTINEL_SECRET;
  }
});

check("pricing không gọi npx và không chuyển secret vào child", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opencmo-pricing-safety-"));
  const capture = path.join(directory, "capture.json");
  const fakeNpx = path.join(directory, "npx");
  writeFileSync(
    fakeNpx,
    `#!${process.execPath}\n` +
      `require("node:fs").writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n` +
      `process.stdout.write('API_URL="http://127.0.0.1:54321"\\nSERVICE_ROLE_KEY="invalid"\\n');\n`,
    { mode: 0o700 },
  );

  try {
    const result = spawnSync(process.execPath, [tsxCli, "lib/pricing.check.ts"], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        LANG: "C.UTF-8",
        NODE_ENV: "test",
        CAPTURE_PATH: capture,
        OPENCMO_SENTINEL_SECRET: "must-not-reach-child",
        // `pricing.ts` import `server-only`, và gói đó CHỈ phân giải được khi
        // điều kiện `react-server` bật. Thiếu dòng này thì child chết ngay ở
        // import và test báo "pricing không chạy" thay vì điều nó muốn đo. Phải
        // trùng `check:pricing` trong `package.json`.
        NODE_OPTIONS: "--conditions=react-server",
      },
    });

    if (existsSync(capture)) {
      const child = JSON.parse(readFileSync(capture, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
      };
      assert.equal(
        "OPENCMO_SENTINEL_SECRET" in child.env,
        false,
        "sentinel secret reached the pricing child process",
      );
      assert.notEqual(child.argv[0], "supabase", "pricing check used the npx download path");
    }
    assert.equal(existsSync(capture), false, "pricing check launched npx");
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

check("API contract từ chối URL không loopback trước privileged writes", () => {
  const result = spawnSync(process.execPath, [tsxCli, "lib/api/contract.check.ts"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_ENV: "test",
      NEXT_PUBLIC_SUPABASE_URL: "http://0.0.0.0:9",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      CHECK_API_BASE: "http://127.0.0.1:9",
    },
  });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /chỉ chạy với Supabase local/i);
});

if (failures.length > 0) {
  console.error(`${failures.length} kiểm tra an toàn hỏng:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Executable checks: child env sạch và chỉ dùng Supabase local.");
