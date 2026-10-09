// Câu cảnh báo trong docstring dưới là một comment; comment không chặn được ai.
// `server-only` thì chặn: import file này từ một client component là lỗi BUILD,
// không phải một khoá rò ra bundle mà ta phát hiện sau.
import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Client dùng SERVICE ROLE KEY — đi vòng qua RLS.
 *
 * Chỉ những chỗ chạy KHÔNG thay mặt một người dùng đang đăng nhập: webhook
 * Polar (cộng credit), các cron, bộ chạy việc CMO (`lib/cmo/jobs/start.ts`,
 * như worker Python — gọi RPC chỉ-service kèm user id tường minh), và bước tra
 * chủ khoá API của MCP (`lib/mcp/auth.ts`: chỉ `api_key_owner`; mọi tool sau đó
 * chạy dưới RLS bằng JWT ngắn hạn của chính user). Không bao giờ
 * import từ component, kể cả server component: chỉ cần một lần lỡ tay bọc nó
 * vào code chạy phía client là khóa này ra ngoài. `server-only` ở trên là chốt
 * cứng cho đúng câu đó.
 */
export function createAdminClient(signal?: AbortSignal) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Thiếu SUPABASE_SERVICE_ROLE_KEY.");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(signal ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) } } : {}),
  });
}
