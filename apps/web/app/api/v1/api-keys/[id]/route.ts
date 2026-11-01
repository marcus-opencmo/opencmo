import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revokes a key: an MCP client using it gets 401 on its next call. */
export const DELETE = withApi({ rateLimit: { bucket: "project-write", limit: 60, windowSeconds: 3600 } }, async ({ supabase, params }) => {
  // Not a key id is "not found", not a Postgres cast error (a 500 and an error log).
  if (!UUID.test(String(params.id ?? ""))) throw new ApiError(404, "That key was not found or is already revoked.");
  const revoked = await rpcOrThrow<boolean>(supabase, "revoke_api_key", { p_id: params.id });
  if (!revoked) throw new ApiError(404, "That key was not found or is already revoked.");
  return { revoked: true };
});
