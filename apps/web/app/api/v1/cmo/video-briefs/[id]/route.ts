import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { firstRow, rpcOrThrow, withApi } from "@/lib/api/handler";
import { briefPrompt, type VideoBrief } from "@/lib/cmo/brief";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

type BriefRow = VideoBrief & { id: string; job_id: string; status: string };

/** One video brief and the message the project assistant will receive (read under RLS). */
export const GET = withApi({}, async ({ supabase, params }) => {
  if (!UUID.test(params.id ?? "")) throw new ApiError(404, "Brief not found.");
  const { data } = await supabase.from("cmo_video_briefs").select("id, job_id, status, hook, broll, visuals, pacing").eq("id", params.id).maybeSingle();
  const brief = data as BriefRow | null;
  if (!brief) throw new ApiError(404, "Brief not found.");
  return { id: brief.id, project_id: brief.job_id, status: brief.status, prompt: briefPrompt(brief) };
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("skip"), reason: z.string().trim().max(400).optional() }),
]);

/**
 * The founder approves or skips a brief. Approving edits nothing: it returns the project link
 * that opens the brief in the project assistant, where every change needs its own approval.
 */
export const POST = withApi(
  { body, rateLimit: { bucket: "presets", limit: 60, windowSeconds: 3600 } },
  async ({ supabase, body, params }) => {
    if (!UUID.test(params.id ?? "")) throw new ApiError(404, "Brief not found.");
    const row = firstRow(
      await rpcOrThrow<BriefRow | BriefRow[]>(supabase, "cmo_decide_video_brief", {
        p_id: params.id,
        p_action: body.action,
        p_reason: body.action === "skip" ? (body.reason ?? null) : null,
      }),
    );
    if (!row) throw new ApiError(500, "Could not save your decision.");
    return { id: row.id, status: row.status, href: body.action === "approve" ? `/app/projects/${row.job_id}?brief=${row.id}` : null };
  },
);
