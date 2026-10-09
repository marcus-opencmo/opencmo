import { ApiError } from "@/lib/api/errors";
import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { projectShape, type JobRow } from "@/lib/api/shapes";
import { createClipJob, createClipJobInput } from "@/lib/clipping/create";

export const dynamic = "force-dynamic";

/** Một clip trong panel Clips của editor. */
export type ClippingClip = { id: string; idx: number; hook: string | null; score: number | null; thumbnail_url: string | null };
export type ClippingJob = ReturnType<typeof projectShape> & { clips_found: ClippingClip[] };

const LIMIT = 12;

/**
 * Cắt clip từ trong editor (G1-b). POST tạo job (giữ credit, link phải có xác nhận chính
 * chủ); GET trả các job clip gần đây kèm clip, cho panel Clips theo dõi tiến độ.
 */
export const POST = withApi({ body: createClipJobInput }, async ({ supabase, user, body }) => createClipJob(supabase, user.id, body));

export const GET = withApi({}, async ({ supabase }) => {
  const jobs = await rpcOrThrow<JobRow[]>(supabase, "list_projects", { p_limit: LIMIT });
  const ids = jobs.map((job) => job.id);
  const clips = ids.length
    ? await supabase
        .from("clips")
        .select("id, job_id, idx, hook, score, storage_path, preview_path")
        .in("job_id", ids)
        .eq("kind", "moment")
        .order("idx", { ascending: true })
    : { data: [], error: null };
  if (clips.error) throw new ApiError(503, "Could not load your clips. Please try again.");
  const byJob = new Map<string, ClippingClip[]>();
  for (const clip of (clips.data ?? []) as (ClippingClip & { job_id: string; storage_path: string | null; preview_path: string | null })[]) {
    const list = byJob.get(clip.job_id) ?? [];
    list.push({
      id: clip.id,
      idx: clip.idx,
      hook: clip.hook,
      score: clip.score === null ? null : Number(clip.score),
      thumbnail_url: clip.preview_path || clip.storage_path ? `/api/v1/clips/${clip.id}/file?preview=1` : null,
    });
    byJob.set(clip.job_id, list);
  }
  return { items: jobs.map((job) => ({ ...projectShape(job), clips_found: byJob.get(job.id) ?? [] })) };
});
