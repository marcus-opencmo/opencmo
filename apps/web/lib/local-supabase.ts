import { constants, accessSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export type LocalSupabaseCredentials = { url: string; serviceRoleKey: string };

type StatusOptions = {
  cwd: string;
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
};

export type SupabaseStatusRunner = (
  executable: string,
  args: readonly string[],
  options: StatusOptions,
) => string;

const CHILD_ENV: NodeJS.ProcessEnv = Object.freeze({
  // CLI là binary tự chứa; PATH tối thiểu chỉ dành cho tiện ích hệ thống nếu cần.
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "test",
});

export function isLoopbackUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Tìm binary đã cài; tuyệt đối không rơi về `npx` hay tải package lúc chạy check. */
export function resolveSupabaseExecutable(
  cwd: string,
  pathValue = process.env.PATH ?? "",
): string {
  const candidates = [
    path.resolve(cwd, "node_modules/.bin/supabase"),
    path.resolve(cwd, "../../node_modules/.bin/supabase"),
    ...pathValue.split(path.delimiter).filter(Boolean).map((directory) =>
      path.resolve(directory, "supabase"),
    ),
  ];

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Thử candidate kế tiếp.
    }
  }
  throw new Error("Không tìm thấy Supabase CLI đã cài — cài binary `supabase` trước.");
}

const runStatus: SupabaseStatusRunner = (executable, args, options) =>
  execFileSync(executable, [...args], options);

export function localSupabaseCredentials({
  cwd,
  executable = resolveSupabaseExecutable(cwd),
  run = runStatus,
}: {
  cwd: string;
  executable?: string;
  run?: SupabaseStatusRunner;
}): LocalSupabaseCredentials {
  let status: string;
  try {
    status = run(executable, ["status", "-o", "env"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Không truyền `process.env`: nó có thể chứa service-role remote, Polar,
      // provider token hoặc secret khác do Next/.env.local đã nạp.
      env: { ...CHILD_ENV },
    });
  } catch {
    throw new Error("Không đọc được Supabase local — chạy `supabase start` trước.");
  }

  const values = Object.fromEntries(
    status.split("\n").flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) return [];
      return [[match[1], match[2].replace(/^"|"$/g, "")]];
    }),
  );
  const url = values.API_URL;
  const serviceRoleKey = values.SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey || !isLoopbackUrl(url)) {
    throw new Error("Supabase CLI không trả về thông tin stack local hợp lệ.");
  }
  return { url, serviceRoleKey };
}
