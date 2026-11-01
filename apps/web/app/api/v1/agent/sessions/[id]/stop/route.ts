import { notFound, rpcOrThrow, withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";

/** Dừng lượt đang chạy: chốt credit theo usage đã ghi, gỡ khoá. Vòng lặp thấy ở bước kế. */
export const POST = withApi({}, async ({ supabase, params }) => {
  if (!/^[0-9a-f-]{36}$/.test(params.id ?? "")) throw notFound("Assistant session not found.");
  const turn = await rpcOrThrow<{ number: number; status: string; credits: number | null } | null>(
    supabase,
    "agent_stop",
    { p_session_id: params.id },
  );
  return { stopped: Boolean(turn?.number), turn: turn?.number ? { number: turn.number, credits: turn.credits } : null };
});
