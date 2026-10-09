import "server-only";

/**
 * W0 Onboarding (docs/cmo/san-pham.md §4.3): website → bốn document.
 *
 * Mọi ghi đi qua RPC dưới quyền người dùng (luật web #1): `start_cmo_run` chặn
 * chạy chồng và giới hạn 5 lượt/ngày TRƯỚC khi tốn tiền LLM; agent ghi document
 * bằng `save_marketing_document` kèm id lượt; lượt luôn được kết thúc, kể cả khi lỗi.
 */

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, type SupabaseClient } from "@/lib/api/handler";

import { DOCUMENT_KINDS } from "./documents";
import { draftDocuments, GenerateError } from "./generate";
import { readSite, SiteError } from "./site";

type RunRow = { id: string };

export async function runOnboarding(supabase: SupabaseClient, site: string): Promise<{ runId: string }> {
  const run = firstRow(await rpcOrThrow<RunRow | RunRow[]>(supabase, "start_cmo_run", { p_kind: "onboard", p_input: { site } }));
  if (!run) throw new ApiError(500, "Could not start building your plan.");

  try {
    const snapshot = await readSite(site);
    const drafts = await draftDocuments(snapshot);
    for (const kind of DOCUMENT_KINDS) {
      await rpcOrThrow(supabase, "save_marketing_document", { p_kind: kind, p_body: drafts[kind], p_run: run.id });
    }
    await rpcOrThrow(supabase, "finish_cmo_run", { p_id: run.id, p_ok: true });
    return { runId: run.id };
  } catch (error) {
    const known = error instanceof SiteError || error instanceof GenerateError;
    const message = known ? error.message : "We could not build your plan. Try again in a minute.";
    if (!known && !(error instanceof ApiError)) console.error("[cmo] onboarding thất bại", error);
    await supabase.rpc("finish_cmo_run", { p_id: run.id, p_ok: false, p_error: message });
    if (error instanceof ApiError) throw error;
    throw new ApiError(known && error instanceof SiteError ? 422 : 502, message);
  }
}
