import { notFound, rpcOrThrow, withApi } from "@/lib/api/handler";
import { generationView, type GenerationRow } from "@/lib/generate/models";

export const dynamic = "force-dynamic";

/** Huỷ lượt đang xếp hàng hoặc đang chạy; credit giữ được hoàn toàn bộ (trigger trên `tasks`). */
export const POST = withApi({}, async ({ supabase, params }) => {
  if (!/^[0-9a-f-]{36}$/.test(params.id ?? "")) throw notFound("Generation not found.");
  const row = await rpcOrThrow<GenerationRow>(supabase, "cancel_generation", { p_id: params.id });
  return generationView(row);
});
