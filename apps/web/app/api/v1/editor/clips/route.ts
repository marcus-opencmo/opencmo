import { ApiError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { sourceName } from "@/lib/api/shapes";

export const dynamic = "force-dynamic";

type ClipRow = { id: string; job_id: string; idx: number; hook: string | null; kind: string | null; created_at: string };
type JobRow = { id: string; name: string | null; title: string | null; source_url: string };

/** Một mục của ô chọn clip trong editor. */
export type EditorClip = {
  clip_id: string;
  project_id: string;
  project: string;
  label: string;
  /** `blank` = New edit (không có video nguồn); `full` = cả video; `moment` = clip đã cắt. */
  kind: string;
  /** Lần sửa gần nhất trong editor; null = chưa mở editor lần nào. */
  edited_at: string | null;
};

const LIMIT = 60;

/**
 * Clip mở được trong editor: mục "Editor" trên rail (E0) mở mục đầu tiên, ô chọn
 * clip của editor liệt kê cả danh sách. Clip sửa gần nhất đứng đầu, rồi tới clip
 * mới nhất chưa mở lần nào. Mọi đọc dưới RLS — chỉ clip của chính người gọi.
 */
export const GET = withApi({}, async ({ supabase }) => {
  const [clips, edited] = await Promise.all([
    supabase.from("clips").select("id, job_id, idx, hook, kind, created_at").order("created_at", { ascending: false }).limit(LIMIT),
    supabase.from("editor_projects").select("clip_id, updated_at").order("updated_at", { ascending: false }).limit(LIMIT),
  ]);
  if (clips.error || edited.error) throw new ApiError(503, "Could not load your clips. Please try again.");
  const rows = (clips.data ?? []) as ClipRow[];
  const editedAt = new Map(((edited.data ?? []) as { clip_id: string; updated_at: string }[]).map((row) => [row.clip_id, row.updated_at]));

  // Clip đã sửa nhưng cũ hơn trang 60 clip mới nhất vẫn phải có mặt.
  const missing = [...editedAt.keys()].filter((id) => !rows.some((row) => row.id === id));
  if (missing.length) {
    const extra = await supabase.from("clips").select("id, job_id, idx, hook, kind, created_at").in("id", missing);
    rows.push(...((extra.data ?? []) as ClipRow[]));
  }
  const jobIds = [...new Set(rows.map((row) => row.job_id))];
  const jobs = jobIds.length ? await supabase.from("jobs").select("id, name, title, source_url").in("id", jobIds) : { data: [], error: null };
  const jobById = new Map(((jobs.data ?? []) as JobRow[]).map((job) => [job.id, job]));

  const items: EditorClip[] = rows
    .filter((row) => jobById.has(row.job_id))
    .map((row) => {
      const job = jobById.get(row.job_id)!;
      return {
        clip_id: row.id,
        project_id: row.job_id,
        project: job.name ?? job.title ?? sourceName(job.source_url),
        label: row.hook?.trim() || `Clip ${row.idx + 1}`,
        kind: row.kind ?? "moment",
        edited_at: editedAt.get(row.id) ?? null,
      };
    })
    .sort((a, b) => (b.edited_at ?? "").localeCompare(a.edited_at ?? ""));
  return { items };
});
