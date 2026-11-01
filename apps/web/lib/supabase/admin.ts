// The warning in the docstring below is a comment, and a comment stops no one. `server-only` does: importing this file
// from a client component is a BUILD error, not a key leaked into the bundle that we find out about later.
import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Client dùng SERVICE ROLE KEY — đi vòng qua RLS.
 *
 * Chỉ những chỗ chạy KHÔNG thay mặt một người dùng đang đăng nhập: webhook
 * Polar (cộng credit) và Zernio (trạng thái bài đăng, `app/api/webhooks/zernio`), các cron, bộ chạy việc CMO (`lib/cmo/jobs/start.ts`,
 * như worker Python — gọi RPC chỉ-service kèm user id tường minh), và bước tra
 * chủ khoá API của MCP (`lib/mcp/auth.ts`: chỉ `api_key_owner`; mọi tool sau đó
 * chạy dưới RLS bằng JWT ngắn hạn của chính user), and the Assistant's ledger (`lib/agent/ledger.ts`:
 * usage, messages, tool calls and settlement for the user the route verified), and caption translation
 * refunds (`lib/editor/captions-run.ts`: after the server's own LLM call failed). Không bao giờ
 * import từ component, kể cả server component: chỉ cần một lần lỡ tay bọc nó
 * vào code chạy phía client là khóa này ra ngoài. `server-only` ở trên là chốt
 * cứng cho đúng câu đó.
 */
export function createAdminClient(signal?: AbortSignal) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(signal ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) } } : {}),
  });
}
