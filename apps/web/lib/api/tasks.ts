/**
 * Task chạy nền → hình dạng client đọc được.
 *
 * Hàng `tasks` mang cả chi tiết vận hành (attempt_id, lease_until, output_path,
 * payload). Không lọc thì client thấy hết, và ta bị khoá vào hình dạng bảng khi
 * muốn đổi cách chạy việc nền.
 */

import { signedObjectUrl, type Bucket } from "../storage";
import { ApiError } from "./errors";
import type { SupabaseClient } from "./handler";

/** Kind mà web đọc qua `/tasks`; mỗi giá trị phải có trong `task-kinds.json` (`task-kinds.check.ts`). */
export const RENDER_TASK_KINDS = ["probe_media", "zip", "render_document"] as const;
export type RenderTaskKind = (typeof RENDER_TASK_KINDS)[number];

export type RenderTask = {
  id: string;
  kind: RenderTaskKind;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  clip_id: string | null;
  error: string | null;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Tiến độ 0–1 worker ghi lúc chạy (export trên server); null khi chưa có. */
  progress: number | null;
  created_at: string;
  finished_at: string | null;
  /** Signed URL của kết quả, chỉ khi `status === "done"`. */
  url: string | null;
};

export const TASK_COLUMNS =
  "id, kind, status, clip_id, settings_hash, error, bytes, duration, " +
  "width, height, progress, created_at, finished_at, output";

export type RawTask = {
  id: string;
  kind: string;
  status: string;
  clip_id: string | null;
  error: string | null;
  bytes: number | string | null;
  duration: number | string | null;
  width: number | null;
  height: number | null;
  progress?: number | string | null;
  created_at: string;
  finished_at: string | null;
  output?: OutputManifest | null;
};

export type OutputManifest = {
  manifest?: { files?: Record<string, { bucket?: string; object?: string; bytes?: number }> };
} | null;

const asNumber = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export function fileEntry(
  task: { output?: OutputManifest },
  kind: string,
): { bucket: Bucket; object: string } | null {
  const entry = task.output?.manifest?.files?.[kind];
  if (!entry?.object || !entry.bucket) return null;
  return { bucket: entry.bucket as Bucket, object: entry.object };
}

export function taskShape(task: RawTask, url: string | null): RenderTask {
  return {
    id: task.id,
    kind: task.kind as RenderTaskKind,
    status: task.status as RenderTask["status"],
    clip_id: task.clip_id,
    error: task.error,
    bytes: asNumber(task.bytes),
    duration: asNumber(task.duration),
    width: task.width,
    height: task.height,
    progress: asNumber(task.progress ?? null),
    created_at: task.created_at,
    finished_at: task.finished_at,
    url,
  };
}

/**
 * Task + link kết quả.
 *
 * Preview trả mp4, ZIP trả file zip. Export của WORKER không ký ở đây: nó có ba
 * file và đi qua `GET /exports/[id]/file?kind=` để tên file tải về do server đặt.
 *
 * `render_document` — export vẽ document trên server — thì CÓ ký ở đây (cùng
 * `finalize`, bản xuất trình duyệt cũ trước A4b, để link cũ còn tải được). Nó chỉ có
 * đúng một file, và editor mới không có trang kết quả nào để dẫn người dùng
 * tới: nó đang đứng trong editor, vừa bấm Export xong. Thiếu nhánh này thì file
 * đã render, đã upload, đã đóng watermark vẫn nằm im trong bucket và không
 * đường nào lấy ra — đường tiền kết thúc ở một cái ngõ cụt im lặng.
 */
export async function taskWithUrl(
  task: RawTask,
  options: { inline?: boolean } = {},
): Promise<RenderTask> {
  if (task.status !== "done") return taskShape(task, null);

  const entry =
    task.kind === "zip"
      ? fileEntry(task, "zip")
      : task.kind === "render_document"
        ? fileEntry(task, "mp4")
        : null;

  if (!entry) return taskShape(task, null);
  return taskShape(
    task,
    await signedObjectUrl(entry.bucket, entry.object, {
      // Bản giao khách phải rơi xuống ổ đĩa chứ không mở ra trong tab; chỉ thẻ
      // <video> trên trang project xin bản phát tại chỗ.
      download: options.inline
        ? undefined
        : task.kind === "zip"
          ? "opencmo-clips.zip"
          : "opencmo-clip.mp4",
    }),
  );
}

export async function taskById(
  supabase: SupabaseClient,
  taskId: string,
): Promise<RawTask> {
  const { data } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .maybeSingle();
  if (!data) throw new ApiError(404, "That job is no longer available.");
  return data as unknown as RawTask;
}
