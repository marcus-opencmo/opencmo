/**
 * Dựng Supabase E2E trên project/port riêng rồi mới chạy Playwright.
 * Không dùng `db reset` trên stack dev: lệnh đó xoá dữ liệu local của người đang làm việc.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..");
const ROOT = join(WEB, "..", "..");
const STACK = join(__dirname, "fixtures", "supabase-stack");
const SOURCE = join(ROOT, "supabase");
const CLI_ARGS = ["--workdir", STACK];

function run(command: string, args: string[], capture = false) {
  return spawnSync(command, args, {
    cwd: WEB,
    encoding: "utf8",
    env: process.env,
    stdio: capture ? "pipe" : "inherit",
  });
}

function prepareStack(): void {
  rmSync(STACK, { recursive: true, force: true });
  mkdirSync(STACK, { recursive: true });
  cpSync(SOURCE, join(STACK, "supabase"), { recursive: true });

  const path = join(STACK, "supabase", "config.toml");
  let config = readFileSync(path, "utf8")
    .replace('project_id = "opencmo"', 'project_id = "opencmo-e2e"')
    .replaceAll("54320", "55320")
    .replaceAll("54321", "55321")
    .replaceAll("54322", "55322")
    .replaceAll("54323", "55323")
    .replaceAll("54324", "55324")
    .replaceAll("54327", "55327")
    .replaceAll("54329", "55329")
    .replaceAll("127.0.0.1:3000", "127.0.0.1:3100")
    .replaceAll("localhost:3000", "localhost:3100");
  writeFileSync(path, config, "utf8");
}

function readEnv(): NodeJS.ProcessEnv {
  const status = run("supabase", ["status", "-o", "env", ...CLI_ARGS], true);
  if (status.status !== 0) throw new Error("Không đọc được môi trường Supabase E2E.");

  const values: Record<string, string> = {};
  for (const line of status.stdout.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (match) values[match[1]] = match[2];
  }
  for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "JWT_SECRET", "INBUCKET_URL"]) {
    if (!values[key]) throw new Error(`Supabase E2E thiếu ${key}.`);
  }
  return {
    ...process.env,
    OPENCMO_E2E_BUILD: "1",
    // Assistant chạy bằng Claude giả (kịch bản cố định): E2E không tốn tiền, không cần mạng.
    OPENCMO_AGENT_FAKE: "1",
    // Generate cũng bằng model giả (FakeProvider của worker): `check:api` trong
    // api-contract.spec cần danh sách model giả, và E2E không được tốn tiền thật.
    OPENCMO_AI_FAKE: "1",
    // `next start` tự nạp `apps/web/.env.local`, và khoá nhà cung cấp trong đó bật model
    // THẬT (Generate chọn `gemini-voice` thay `fake-voice`): test lệch, và có thể tốn
    // tiền. `@next/env` không ghi đè biến đã có, nên đặt rỗng ở đây là chặn được.
    GEMINI_API_KEY: "",
    ELEVENLABS_API_KEY: "",
    FAL_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3100",
    MODAL_SUBMIT_URL: "",
    OPENCMO_WORKER_TOKEN: "",
    NEXT_PUBLIC_SUPABASE_URL: values.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: values.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY,
    // MCP (G5) ký JWT ngắn hạn cho chủ khoá API.
    SUPABASE_JWT_SECRET: values.JWT_SECRET,
    // check:api gọi cron dọn (xoá tài khoản free hết hạn) với cùng secret server đọc.
    CRON_SECRET: "e2e-cron-secret",
    E2E_INBUCKET_URL: values.INBUCKET_URL,
  };
}

function main(): void {
  prepareStack();
  run("supabase", ["stop", "--no-backup", ...CLI_ARGS]);
  // CLI in khoá local khi start thành công: giữ output trong process, không
  // đưa khoá vào log test. Lỗi khởi động chỉ cần stderr chẩn đoán.
  const started = run("supabase", ["start", ...CLI_ARGS], true);
  if (started.status !== 0) {
    process.stderr.write(started.stderr);
    run("supabase", ["stop", "--no-backup", ...CLI_ARGS]);
    throw new Error("Không dựng được Supabase E2E.");
  }

  try {
    const childEnv = readEnv();
    if (childEnv.MODAL_SUBMIT_URL || childEnv.OPENCMO_WORKER_TOKEN) {
      throw new Error("E2E must never call a remote worker.");
    }
    const result = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
      cwd: WEB,
      env: childEnv,
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  } finally {
    run("supabase", ["stop", "--no-backup", ...CLI_ARGS]);
  }
}

main();
