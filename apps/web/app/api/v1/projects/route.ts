import { rpcOrThrow, withApi } from "@/lib/api/handler";
import { encodeCursor, decodeCursor, projectShape, type JobRow } from "@/lib/api/shapes";
import { ApiError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const LIMIT = 24;

/**
 * Thư viện project, phân trang keyset.
 *
 * Trang danh sách không ký sẵn signed URL. Nó chỉ lấy id clip đầu tiên bằng một
 * query batch rồi trả route phát có kiểm quyền; route đó ký URL khi trình duyệt
 * thật sự nạp thumbnail. Như vậy 24 project không tạo hàng trăm chữ ký thừa.
 */
export const GET = withApi({}, async ({ request, supabase }) => {
  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? decodeCursor(cursorParam) : null;
  if (cursorParam && !cursor) {
    throw new ApiError(422, "This page link is no longer valid.");
  }

  // Trần 49 chứ không phải 50: `list_projects` tự kẹp ở 50, nên xin 51 hàng để
  // dò trang sau sẽ nhận đúng 50 và `next_cursor` im lặng thành null.
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || LIMIT, 1), 49);
  const rows = await rpcOrThrow<JobRow[]>(supabase, "list_projects", {
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_query: (url.searchParams.get("q") ?? "").slice(0, 200),
    // Lấy dư một hàng để biết CÓ trang sau hay không mà không phải đếm tổng.
    p_limit: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const jobIds = page.map((job) => job.id);
  const clipResult = jobIds.length
    ? await supabase
        .from("clips")
        .select("id, job_id, idx, storage_path, preview_path")
        .in("job_id", jobIds)
        // Clip "cả video" (E2-c) không phải một clip AI cắt: không tính, không làm ảnh bìa.
        .eq("kind", "moment")
        .order("idx", { ascending: true })
    : { data: [], error: null };
  if (clipResult.error) {
    throw new ApiError(503, "Could not load project previews. Please try again.");
  }
  const firstClipByJob = new Map<string, string>();
  const clipCount = new Map<string, number>();
  for (const clip of (clipResult.data ?? []) as {
    id: string;
    job_id: string;
    storage_path: string | null;
    preview_path: string | null;
  }[]) {
    clipCount.set(clip.job_id, (clipCount.get(clip.job_id) ?? 0) + 1);
    if (!firstClipByJob.has(clip.job_id) && (clip.preview_path || clip.storage_path)) {
      firstClipByJob.set(clip.job_id, clip.id);
    }
  }
  return {
    items: page.map((job) => {
      const clipId = firstClipByJob.get(job.id);
      return {
        ...projectShape(job),
        thumbnail_url: clipId ? `/api/v1/clips/${clipId}/file?preview=1` : null,
        clip_count: clipCount.get(job.id) ?? 0,
      };
    }),
    next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
});
