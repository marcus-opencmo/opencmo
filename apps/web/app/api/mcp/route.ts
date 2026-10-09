import { NextResponse, type NextRequest } from "next/server";

import { clientFor, userForKey } from "@/lib/mcp/auth";
import { handleMessage } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
// Tool như generate_media chờ RPC + render document: cho đủ thời gian như route Assistant.
export const maxDuration = 300;

/** Lô JSON-RPC tối đa mỗi POST. */
const MAX_BATCH = 20;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * MCP Streamable HTTP, không trạng thái (G5): POST một thông điệp JSON-RPC (hay một mảng), nhận
 * JSON. Xác thực bằng khoá API cá nhân (`Authorization: Bearer ocm_…`, tạo ở Settings → API keys).
 */
export async function POST(request: NextRequest) {
  let userId: string | null;
  try {
    userId = await userForKey(request.headers.get("authorization"));
  } catch (err) {
    console.error("[mcp] tra khoá lỗi", err);
    return json({ error: "Could not check this key. Please try again." }, 503);
  }
  if (!userId) {
    return json({ error: "Add a valid OpenCMO API key: Authorization: Bearer ocm_…" }, 401, { "www-authenticate": 'Bearer realm="opencmo"' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0 || messages.length > MAX_BATCH) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Send 1 to ${MAX_BATCH} messages per request.` } }, 400);
  }

  // Mỗi THÔNG ĐIỆP trừ một lượt, không phải mỗi POST: một lô hàng nghìn tools/call không được
  // lọt qua giới hạn 600 lượt/giờ.
  const supabase = clientFor(userId);
  for (let index = 0; index < messages.length; index++) {
    const { data: allowed, error } = await supabase.rpc("rate_limit_hit", { p_bucket: "mcp", p_limit: 600, p_window_seconds: 3600 });
    if (error) {
      console.error("[mcp] rate limit lỗi", error);
      return json({ error: "Could not start this request. Please try again." }, 503);
    }
    if (allowed === false) return json({ error: "Too many requests from this key. Try again in an hour." }, 429);
  }

  const session = { supabase, userId };
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((message) => handleMessage(message, session)))).filter((reply) => reply !== null);
    return replies.length ? json(replies) : new NextResponse(null, { status: 202 });
  }
  const reply = await handleMessage((body ?? {}) as Record<string, unknown>, session);
  return reply ? json(reply) : new NextResponse(null, { status: 202 });
}

/** Không có luồng server → client (SSE): server không trạng thái. */
export function GET() {
  return json({ error: "This MCP server takes POST requests only." }, 405, { allow: "POST" });
}
