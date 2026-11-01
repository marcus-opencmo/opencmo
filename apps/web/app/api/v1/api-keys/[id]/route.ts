import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/** Thu hồi khoá: client MCP dùng nó nhận 401 ngay lần gọi sau. */
export const DELETE = withApi({ rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } }, async ({ supabase, params }) => {
  const revoked = await rpcOrThrow<boolean>(supabase, "revoke_api_key", { p_id: params.id });
  if (!revoked) throw new ApiError(404, "That key was not found or is already revoked.");
  return { revoked: true };
});
