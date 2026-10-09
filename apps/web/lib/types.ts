/** Kiểu của các bảng dùng trong app. Khớp với supabase/migrations. */

export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job = {
  id: string;
  user_id: string;
  source_url: string;
  title: string | null;
  duration_seconds: number | null;
  status: JobStatus;
  clips_requested: number;
  error: string | null;
  watermark: boolean;
  expires_at: string;
  created_at: string;
  finished_at: string | null;
};

export type Clip = {
  id: string;
  job_id: string;
  idx: number;
  hook: string | null;
  start_seconds: number;
  end_seconds: number;
  score: number | null;
  reason: string | null;
  storage_path: string | null;
  preview_path: string | null;
};

export type LedgerEntry = {
  id: string;
  delta: number;
  reason: string;
  job_id: string | null;
  created_at: string;
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Processing",
  done: "Done",
  failed: "Failed",
};
