import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

type KeyRow = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

/** Khoá API cho MCP (G5) của người đang đăng nhập — không bao giờ kèm hash. */
export const GET = withApi({}, async ({ supabase }) => {
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, name, prefix, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new ApiError(503, "Could not load your API keys.");
  return { keys: (data ?? []) as KeyRow[] };
});

const body = z.object({ name: z.string().trim().min(1).max(60) });

/** Tạo khoá: khoá gốc chỉ có trong response này, server chỉ giữ hash. */
export const POST = withApi(
  { body, rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body }) => rpcOrThrow<KeyRow & { key: string }>(supabase, "create_api_key", { p_name: body.name }),
);
