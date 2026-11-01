import "server-only";

import { rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The turn's bookkeeping: model usage, messages, tool calls and the settlement.
 *
 * Service role only since security fix 9: with the user's own token (or any OAuth client holding
 * it) a turn could be settled before its running model call was recorded, so that call was never
 * charged, and tool calls had no size cap. The route has already verified the user (`withApi`);
 * each `_for` RPC checks the turn belongs to that id.
 */
export type LedgerCall = "agent_record_usage" | "agent_append" | "agent_record_tool" | "agent_finish_turn";
export type Ledger = <T = unknown>(name: LedgerCall, args: Record<string, unknown>) => Promise<T>;

export function serviceLedger(userId: string, admin: SupabaseClient = createAdminClient() as unknown as SupabaseClient): Ledger {
  return (name, args) => rpcOrThrow(admin, `${name}_for`, { p_user: userId, ...args });
}
