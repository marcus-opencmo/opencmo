/**
 * Dựng stack test: database sạch, hai user, một video fixture, một worker.
 *
 * Video KHÔNG commit vào repo: nó được ffmpeg tạo ra ở đây. Một file mp4 trong
 * git là thứ không bao giờ nhỏ lại, và fixture này chỉ là `testsrc2` + `sine`.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// `__dirname` chứ không phải `import.meta.url`: Playwright biên dịch file test
// sang CommonJS, và `import.meta` ở đó là lỗi cú pháp.
const HERE = __dirname;
const ROOT = join(HERE, "..", "..", "..");
export const FIXTURE_DIR = join(HERE, "fixtures");
export const SOURCE_VIDEO = join(FIXTURE_DIR, "talk-30s.mp4");
export const BROLL_VIDEO = join(FIXTURE_DIR, "broll-5s.mp4");
export const RESUME_VIDEO = join(FIXTURE_DIR, "resume-300mb.mp4");
const STATE = join(FIXTURE_DIR, "state.json");

export type E2EUser = { email: string; password: string; id: string };

function supabaseEnv(): { url: string; anon: string; service: string; inbucket: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const inbucket = process.env.E2E_INBUCKET_URL ?? "";
  if (!url || !anon || !service || !inbucket) {
    throw new Error("Thiếu môi trường Supabase E2E — chạy `npm run test:e2e`, không gọi Playwright trực tiếp.");
  }
  return { url, anon, service, inbucket };
}

function video(path: string, seconds: number, size: string): void {
  if (existsSync(path)) return;
  spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", path,
    ],
    { stdio: "inherit" },
  );
}

async function waitForAuth(url: string, anon: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/auth/v1/health`, {
        headers: { apikey: anon },
      });
      lastStatus = String(response.status);
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Supabase Auth did not become ready after database reset (${lastStatus}).`);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Xoá user test còn sót của lần chạy trước để `globalSetup` chạy lại được. */
async function removeExistingUsers(
  admin: SupabaseClient,
  url: string,
): Promise<void> {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(`Supabase E2E trỏ tới ${host} — chỉ chạy với stack loopback.`);
  }
  const emails = new Set(["a", "b"].map((label) => `e2e-${label}@test.local`));
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`Không đọc được danh sách user: ${error.message}`);
  for (const user of data.users) {
    if (user.email && emails.has(user.email)) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const env = supabaseEnv();
  mkdirSync(FIXTURE_DIR, { recursive: true });
  video(SOURCE_VIDEO, 30, "1280x720");
  video(BROLL_VIDEO, 5, "1280x720");
  if (!existsSync(RESUME_VIDEO)) {
    const fd = openSync(RESUME_VIDEO, "w");
    closeSync(fd);
    truncateSync(RESUME_VIDEO, 300 * 1024 * 1024);
  }

  // `e2e/run.ts` đã dựng một project Supabase tạm, sạch và tách khỏi database dev.
  await waitForAuth(env.url, env.anon);

  const admin = createClient(env.url, env.service, { auth: { persistSession: false } });

  // Chạy lại Playwright trên một stack đã dựng sẵn là chuyện thường khi đang sửa
  // test. Tạo user sẽ ném "already registered", nên dọn hai user test trước.
  // Chỉ loopback: xoá user là thao tác huỷ, không bao giờ chạm dữ liệu thật.
  await removeExistingUsers(admin, env.url);

  const users: Record<"a" | "b", E2EUser> = {} as never;
  for (const label of ["a", "b"] as const) {
    const email = `e2e-${label}@test.local`;
    const password = `e2e-${label}-password`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`Không tạo được user ${label}: ${error?.message}`);
    // Quà đăng ký đã bỏ (20260921150000): tài khoản mới có 0 credit, nên
    // lượt E2E phải tự nạp toàn bộ.
    await admin.from("credit_ledger").insert({
      user_id: data.user.id,
      delta: 100,
      reason: "E2E top-up",
    });
    users[label] = { email, password, id: data.user.id };
  }

  const worker = spawn(
    join(ROOT, "packages", "engine", ".venv312", "bin", "python"),
    ["-m", "tests.e2e_worker"],
    {
      cwd: join(ROOT, "packages", "engine"),
      env: {
        ...process.env,
        OPENCMO_E2E: "1",
        SUPABASE_URL: env.url,
        SUPABASE_SERVICE_ROLE_KEY: env.service,
        PYTHONPATH: join(ROOT, "packages", "engine"),
      },
      stdio: "inherit",
      detached: true,
    },
  );
  worker.unref();

  writeFileSync(
    STATE,
    JSON.stringify({ ...env, users, workerPid: worker.pid }, null, 2),
    "utf8",
  );
}

export function readState(): {
  url: string;
  anon: string;
  service: string;
  inbucket: string;
  users: Record<"a" | "b", E2EUser>;
  workerPid: number;
} {
  return JSON.parse(readFileSync(STATE, "utf8"));
}
