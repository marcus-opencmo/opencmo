import { rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/** Hạn xoá tài khoản free (migration 20261108090000): `delete_after` null khi đã trả tiền. */
export const GET = withApi({}, async ({ supabase }) =>
  rpcOrThrow<{ paid: boolean; delete_after: string | null }>(supabase, "account_retention", {}),
);
