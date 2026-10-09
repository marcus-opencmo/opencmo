/**
 * Ngữ cảnh của một clip: hàng clip + job chứa nó.
 *
 * Mọi route `/clips/[id]/*` cần cả hai — độ dài nguồn để `parseSettings` kẹp
 * mốc thời gian, manifest để tìm proxy, watermark để render. Đọc dưới phiên
 * người dùng nên RLS lọc; không thấy là "Clip not found.", cùng câu với clip
 * không tồn tại.
 */

import { notFound, type SupabaseClient } from "./handler";

export const CLIP_NOT_FOUND = "Clip not found.";

export type ProxyEntry = {
  bucket: string;
  object: string;
  width?: number;
  height?: number;
  duration?: number;
  offset?: number;
};

export type ClipContext = {
  /** `kind`: `moment` (khoảnh khắc), `full` (cả video, E2-c), `blank` (New edit, F1 — không có nguồn). */
  clip: { id: string; job_id: string; idx: number; kind: string };
  job: {
    id: string;
    status: string;
    aspect: string;
    duration_seconds: number | null;
    media_manifest: { proxies?: Record<string, ProxyEntry> } | null;
  };
};

export async function clipContext(
  supabase: SupabaseClient,
  clipId: string,
): Promise<ClipContext> {
  const { data } = await supabase
    .from("clips")
    .select("id, job_id, idx, kind, jobs!inner(id, status, aspect, duration_seconds, media_manifest)")
    .eq("id", clipId)
    .maybeSingle();

  if (!data) throw notFound(CLIP_NOT_FOUND);
  const row = data as unknown as ClipContext["clip"] & {
    jobs: ClipContext["job"] | ClipContext["job"][];
  };
  const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
  if (!job) throw notFound(CLIP_NOT_FOUND);

  return { clip: { id: row.id, job_id: row.job_id, idx: row.idx, kind: row.kind ?? "moment" }, job };
}

/** Độ dài nguồn cho `parseSettings`; 0 nghĩa là chưa probe xong. */
export function sourceDuration(context: ClipContext): number {
  const value = context.job.duration_seconds;
  return value === null ? 0 : Number(value);
}
