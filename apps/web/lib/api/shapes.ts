/**
 * Hàng database → hình dạng JSON mà `components/clipping/*` đã đọc từ bản local.
 *
 * Giữ nguyên hợp đồng ở `tests/contracts/clipping/*.json` là điều kiện để phần
 * giao diện gần như không phải sửa: nó đã chạy thật vài ngày trên bản local.
 * Mọi chỗ lệch tên cột (pinned ↔ favorite, idx ↔ index, duration_seconds ↔
 * duration) được dịch ở ĐÂY, một chỗ, chứ không rải trong từng route.
 */

import type {
  Project,
  ProjectClip,
  ProjectSettings,
  SourceSegment,
} from "../clipping-types";
import { ASPECTS, JOB_LAYOUTS } from "../settings-schema";
import { isSourceUpload, sourceObjectPath } from "../upload";

/** Cùng bảng lựa chọn độ dài với worker. */
const CLIP_LENGTHS: Record<string, [number, number]> = {
  auto: [10, 60],
  short: [15, 30],
  medium: [30, 60],
  long: [60, 90],
};

/**
 * Mặc định ở đây phải TRÙNG mặc định của `create_job()`: job tạo trước khi có
 * các cột này không có giá trị nào để đọc, và chúng đã chạy ra 9:16 có phụ đề.
 */
export function projectSettings(job: {
  clip_length: string | null;
  mode?: string | null;
  aspect?: string | null;
  layout?: string | null;
  captions?: boolean | null;
}): ProjectSettings {
  const key = job.clip_length && job.clip_length in CLIP_LENGTHS ? job.clip_length : "auto";
  const [min, max] = CLIP_LENGTHS[key];
  return {
    clip_length: key as ProjectSettings["clip_length"],
    min_seconds: min,
    max_seconds: max,
    mode: job.mode === "full" ? "full" : "clip",
    aspect: (ASPECTS.includes(job.aspect as never) ? job.aspect : "9:16") as ProjectSettings["aspect"],
    layout: (JOB_LAYOUTS.includes(job.layout as never)
      ? job.layout
      : "auto") as ProjectSettings["layout"],
    captions: job.captions ?? true,
  };
}

/**
 * Nhãn nguồn.
 *
 * Với link thì chính là link. Với file upload thì lấy phần tên đã làm sạch mà
 * `sourcePath()` gắn trước dấu `__` — đó là thứ duy nhất còn lại của tên gốc,
 * và "Uploaded file" cho mọi project trông giống hệt nhau trong thư viện.
 */
export function sourceName(sourceUrl: string): string {
  if (!isSourceUpload(sourceUrl)) return sourceUrl;
  const file = sourceObjectPath(sourceUrl).split("/").pop() ?? "";
  const stem = file.split("__")[0];
  return stem ? `${stem}.mp4` : "Uploaded file";
}

export type JobRow = {
  id: string;
  source_url: string;
  name: string | null;
  title: string | null;
  pinned: boolean | null;
  status: string;
  stage: string | null;
  duration_seconds: number | string | null;
  clips_requested: number;
  clip_length: string | null;
  mode: string | null;
  aspect: string | null;
  layout: string | null;
  captions: boolean | null;
  segments: { start: number | string; end: number | string }[] | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  attempt_started_at: string | null;
};

export type ClipRow = {
  id: string;
  idx: number;
  hook: string | null;
  start_seconds: number | string;
  end_seconds: number | string;
  score: number | string | null;
  reason: string | null;
  storage_path: string | null;
  preview_path: string | null;
};

const number = (value: number | string | null | undefined, fallback = 0): number => {
  // PostgREST trả `numeric` dưới dạng CHUỖI để không mất chữ số. Ép về number ở
  // đây, một chỗ — quên một lần là UI cộng chuỗi và ra "1020" thay vì 30.
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function clipShape(
  row: ClipRow,
  extra: {
    revision: number | null;
    previewAspect: ProjectClip["preview_aspect"];
    previewWidth: ProjectClip["preview_width"];
    previewHeight: ProjectClip["preview_height"];
    previewUrl: string;
    downloadUrl: string;
    exportUrl: string | null;
    exportRevision: number | null;
  },
): ProjectClip {
  return {
    id: row.id,
    index: row.idx,
    revision: extra.revision,
    moment: {
      start: number(row.start_seconds),
      end: number(row.end_seconds),
      hook: row.hook ?? "",
      reason: row.reason ?? "",
      score: number(row.score),
    },
    available: Boolean(row.storage_path),
    preview_aspect: extra.previewAspect,
    preview_width: extra.previewWidth,
    preview_height: extra.previewHeight,
    preview_url: extra.previewUrl,
    download_url: extra.downloadUrl,
    export_url: extra.exportUrl,
    export_revision: extra.exportRevision,
  };
}

/**
 * `jobs.segments` → hợp đồng. `[]` được đưa về null: một mảng rỗng không mô tả
 * đoạn nào, và UI phân biệt "tự chọn" với "để AI chọn" bằng đúng chỗ này.
 */
export function projectSegments(
  raw: { start: number | string; end: number | string }[] | null | undefined,
): SourceSegment[] | null {
  if (!raw || raw.length === 0) return null;
  return raw.map((s) => ({ start: number(s.start), end: number(s.end) }));
}

export function projectShape(
  job: JobRow,
  clips: ProjectClip[] = [],
  hasTranscript?: boolean,
): Project {
  const project: Project = {
    id: job.id,
    source_name: sourceName(job.source_url),
    title: job.name ?? job.title ?? null,
    favorite: Boolean(job.pinned),
    status: job.status as Project["status"],
    stage: (job.stage ?? "queued") as Project["stage"],
    duration: job.duration_seconds === null ? null : number(job.duration_seconds),
    clips_requested: job.clips_requested,
    error: job.error,
    created_at: job.created_at,
    finished_at: job.finished_at,
    settings: projectSettings(job),
    attempt_started_at: job.attempt_started_at,
    segments: projectSegments(job.segments),
    clips,
  };
  if (hasTranscript !== undefined) project.has_transcript = hasTranscript;
  return project;
}

export type TaskRow = {
  id: string;
  clip_id: string | null;
  settings_hash: string | null;
  status: string;
  bytes: number | string | null;
  duration: number | string | null;
  width: number | null;
  height: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  output?: { files?: Record<string, { bucket: string; object: string }> } | null;
};

/**
 * Con trỏ phân trang: base64 của `(created_at, id)`.
 *
 * Mờ là cố ý — client không được tự dựng con trỏ, vì hình dạng của nó là chi
 * tiết của câu query keyset và sẽ đổi khi cách sắp xếp đổi.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
