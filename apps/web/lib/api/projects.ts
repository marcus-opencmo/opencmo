/**
 * Đọc một project đầy đủ: job + clip + draft + export mới nhất mỗi clip.
 *
 * Dùng chung giữa `GET /projects/[id]` và các route ghi (rename/cancel/retry)
 * vì cả ba đều trả về CÙNG hình dạng `project.json` — UI thay thẳng object cũ
 * bằng object mới sau mỗi thao tác, không phải gọi thêm một vòng.
 *
 * Mọi câu select ở đây KHÔNG lọc `user_id`: RLS đã lọc (ràng buộc web số 2).
 * Không thấy hàng nào thì là "Project not found." — cùng câu với project không
 * tồn tại, để không cho không một máy dò id.
 */

import { ApiError, notFound, type SupabaseClient } from "./handler";
import {
  clipShape,
  projectShape,
  type ClipRow,
  type JobRow,
  type TaskRow,
} from "./shapes";
import type { Project } from "../clipping-types";

export const PROJECT_NOT_FOUND = "Project not found.";

/**
 * Output canonical là revision lớn nhất, KHÔNG phải task kết thúc sau cùng.
 * Hai worker có thể hoàn tất ngược thứ tự; dùng `finished_at` sẽ làm frame cũ
 * quay lại sau khi user vừa chọn frame mới.
 */
export function latestExportByRevision<
  T extends { clip_id: string | null; revision: number },
>(rows: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!row.clip_id) continue;
    const current = latest.get(row.clip_id);
    if (!current || row.revision > current.revision) latest.set(row.clip_id, row);
  }
  return latest;
}

const ASPECT_RATIOS: [Project["settings"]["aspect"], number][] = [
  ["9:16", 9 / 16],
  ["1:1", 1],
  ["16:9", 16 / 9],
];

/**
 * Tỷ lệ của file editor đã xuất, đọc từ kích thước thật của nó: bản xuất từ
 * editor có thể đổi khung (kể cả 4:5), nên không suy từ tỷ lệ lúc tạo job.
 * Khung ngoài ba tỷ lệ của trang (4:5) lấy tỷ lệ gần nhất.
 */
export function aspectOfSize(
  width: number | null | undefined,
  height: number | null | undefined,
): Project["settings"]["aspect"] | undefined {
  if (!width || !height) return undefined;
  const ratio = width / height;
  return ASPECT_RATIOS.reduce((best, item) =>
    Math.abs(Math.log(item[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? item : best,
  )[0];
}

const JOB_COLUMNS =
  "id, source_url, name, title, pinned, status, stage, duration_seconds, " +
  "clips_requested, clip_length, mode, aspect, layout, captions, " +
  "segments, error, created_at, finished_at, attempt_started_at";

const CLIP_COLUMNS =
  "id, idx, hook, start_seconds, end_seconds, score, reason, storage_path, preview_path";

export async function jobRowOrThrow(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobRow> {
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new ApiError(503, "Could not load this project. Please try again.");
  if (!data) throw notFound(PROJECT_NOT_FOUND);
  return data as unknown as JobRow;
}

/** Tên file người dùng thấy khi tải clip về. */
export function clipFilename(clip: Pick<ClipRow, "hook" | "idx">): string {
  const slug = (clip.hook ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const index = String(clip.idx).padStart(2, "0");
  return `${index}-${slug || "clip"}.mp4`;
}

export async function projectDetail(
  supabase: SupabaseClient,
  jobId: string,
): Promise<Project> {
  const job = await jobRowOrThrow(supabase, jobId);

  const [clipsResult, transcriptResult] = await Promise.all([
    supabase
      .from("clips")
      .select(`${CLIP_COLUMNS}, settings_hash`)
      .eq("job_id", jobId)
      .eq("kind", "moment")
      .order("idx"),
    supabase.from("artifacts").select("kind").eq("job_id", jobId).eq("kind", "transcript").limit(1),
  ]);

  if (clipsResult.error || transcriptResult.error) {
    throw new ApiError(503, "Could not refresh your clips. Please try again.");
  }
  const clipRows = (clipsResult.data ?? []) as unknown as (ClipRow & { settings_hash: string | null })[];
  const clipIds = clipRows.map((clip) => clip.id);

  // Một lượt gọi cho TẤT CẢ clip, không phải mỗi clip một lượt: một project 10
  // clip mà gọi vòng lặp là 10 round-trip cho một lần mở trang.
  const exportsResult = clipIds.length
    ? await supabase
        .from("tasks")
        .select(
          "id, clip_id, settings_hash, status, bytes, duration, width, height, " +
            "error, created_at, finished_at, output, editor_revisions(number)",
        )
        .in("clip_id", clipIds)
        .eq("kind", "render_document")
        .eq("status", "done")
    : { data: [] };

  if ("error" in exportsResult && exportsResult.error) {
    throw new ApiError(503, "Could not refresh your clips. Please try again.");
  }

  // Không dựa vào thứ tự trả về hay finished_at: task revision cũ có thể xong
  // sau task mới. Helper bên dưới chọn revision lớn nhất làm output canonical.
  type LatestExport = TaskRow & {
    revision: number;
    previewAspect?: Project["settings"]["aspect"];
  };
  const exports: LatestExport[] = [];
  for (const row of (exportsResult.data ?? []) as unknown as (TaskRow & {
    editor_revisions: { number: number } | { number: number }[] | null;
  })[]) {
    if (!row.clip_id) continue;
    const revision = Array.isArray(row.editor_revisions) ? row.editor_revisions[0] : row.editor_revisions;
    exports.push({
      ...row,
      revision: revision?.number ?? 0,
      previewAspect: aspectOfSize(row.width, row.height),
    });
  }
  const latestExport = latestExportByRevision(exports);

  const clips = await Promise.all(
    clipRows.map(async (clip) => {
      const exported = latestExport.get(clip.id);
      const fallbackSize = {
        "9:16": [1080, 1920],
        "1:1": [1080, 1080],
        "16:9": [1920, 1080],
      }[(job.aspect ?? "9:16") as Project["settings"]["aspect"]];
      // Đường dẫn tới từ hàng database, không bao giờ từ query string — đó là
      // luật của `signedObjectUrl`.
      const playable = clip.preview_path ?? clip.storage_path;
      return clipShape(clip, {
        // Từ R7 mỗi clip có đúng một bộ settings gốc (`clips.settings`): có nó là
        // mở được editor. Giữ trường `revision` = 1 để client không đổi.
        revision: clip.settings_hash ? 1 : null,
        previewAspect:
          exported?.previewAspect ??
          (job.aspect as Project["settings"]["aspect"] | undefined),
        previewWidth: exported?.width ?? fallbackSize[0],
        previewHeight: exported?.height ?? fallbackSize[1],
        previewUrl: exported
          ? `/api/v1/tasks/${exported.id}/file?preview=1`
          : playable
            ? `/api/v1/clips/${clip.id}/file?preview=1`
            : "",
        downloadUrl: clip.storage_path
          ? `/api/v1/clips/${clip.id}/file`
          : "",
        exportUrl: exported ? `/api/v1/tasks/${exported.id}/file` : null,
        exportRevision: exported ? exported.revision : null,
      });
    }),
  );

  return projectShape(job, clips, (transcriptResult.data ?? []).length > 0);
}
