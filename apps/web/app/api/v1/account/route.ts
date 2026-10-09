import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { cmoPending } from "@/lib/cmo/pending";

export const dynamic = "force-dynamic";

type AccountSummary = {
  credits: number;
  plan: string;
  quota: {
    previews: { used: number; limit: number };
    exports: { used: number; limit: number };
    // Settings vẫn hiển thị storage; giữ field hiện hữu trong hợp đồng route.
    storage: { bytes: number; limit: number; objects: number; objectLimit: number };
  };
  resets_at: string;
  // Settings vẫn dùng hai field này, nên D4 không được làm response hẹp hơn.
  email: string;
  job_hold_credits: number;
  /** Việc CMO chờ duyệt; null khi không đếm được. Shell làm mới nó cùng credit. */
  cmo_pending: number | null;
};

/**
 * Account summary đọc một snapshot database gồm credit, plan và quota UTC.
 */
export const GET = withApi({}, async ({ supabase }) => {
  const [summary, pending] = await Promise.all([
    rpcOrThrow<Omit<AccountSummary, "cmo_pending">>(supabase, "account_summary", {}),
    cmoPending(supabase),
  ]);
  return { ...summary, cmo_pending: pending } satisfies AccountSummary;
});
