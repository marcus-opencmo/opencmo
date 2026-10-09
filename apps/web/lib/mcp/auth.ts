import "server-only";

/**
 * Khoá API của MCP (G5) → client Supabase CHẠY NHƯ CHÍNH NGƯỜI DÙNG ĐÓ.
 *
 * Route MCP không có cookie: nó đổi khoá thành user id qua `api_key_owner` (RPC chỉ service
 * role gọi được — đây là lần duy nhất service role chạm vào luồng MCP), rồi ký một JWT
 * `authenticated` sống 5 phút cho user đó. Mọi tool sau đó đi qua RLS y như khi người dùng tự
 * bấm trong app; không có đường nào dùng service role để đọc/ghi dữ liệu của họ.
 */

import { createHash, createHmac } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";

const TOKEN_SECONDS = 300;

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** sha256 hex của khoá — đúng thứ `create_api_key` lưu. */
export const keyHash = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

function jwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("Thiếu SUPABASE_JWT_SECRET: MCP không ký được phiên cho người dùng.");
  return secret;
}

/** JWT HS256 `authenticated` cho `userId`, cùng dạng Supabase Auth phát. */
export function userToken(userId: string, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", iat: now, exp: now + TOKEN_SECONDS }),
  );
  const signature = createHmac("sha256", jwtSecret()).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Client Supabase dưới RLS của `userId` (không cookie, không lưu phiên). */
export function clientFor(userId: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${userToken(userId)}` } },
  }) as unknown as SupabaseClient;
}

/** `Authorization: Bearer ocm_…` → user id, hoặc null (khoá thiếu, sai, đã thu hồi). */
export async function userForKey(authorization: string | null): Promise<string | null> {
  const key = /^Bearer\s+(ocm_[0-9a-f]{48})$/i.exec(authorization?.trim() ?? "")?.[1];
  if (!key) return null;
  const { data, error } = await createAdminClient().rpc("api_key_owner", { p_hash: keyHash(key) });
  if (error) throw new Error(`api_key_owner: ${error.message}`);
  return typeof data === "string" ? data : null;
}
