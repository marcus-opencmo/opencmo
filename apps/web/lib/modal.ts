/**
 * Gọi worker trên Modal.
 *
 * Vì sao là HTTP chứ không phải `run_job.spawn()`: spawn là API Python, app này
 * là TypeScript. Endpoint `submit` trong `packages/engine/modal_app.py` là cây
 * cầu giữa hai bên.
 *
 * Hàm này KHÔNG BAO GIỜ ném lỗi ra ngoài. Job đã nằm trong database ở trạng
 * thái 'queued' rồi; nếu Modal không nhận được cú đánh thức thì `sweep()` — cron
 * mỗi phút — sẽ nhặt nó lên. Đánh sập việc tạo job chỉ vì lưới an toàn phải làm
 * việc là đổi một chậm trễ 60 giây lấy một lỗi đỏ trước mặt người dùng.
 */
export type WakePayload =
  | {
      id: string;
      user_id: string;
      source_url: string;
      clips_requested: number;
      watermark: boolean;
    }
  | { task_id: string };

/**
 * `submit` của Modal nhận `{job_id}` HOẶC `{task_id}` (D2 Task 4.1). Preview,
 * export, probe B-roll và ZIP đều đi qua nhánh task.
 */
export async function wakeWorker(job: WakePayload): Promise<boolean> {
  const url = process.env.MODAL_SUBMIT_URL;
  const token = process.env.OPENCMO_WORKER_TOKEN;

  if (!url || !token) {
    console.warn("[modal] chưa cấu hình MODAL_SUBMIT_URL — chờ sweep() nhặt job");
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        "task_id" in job
          ? { token, task_id: job.task_id }
          : { token, job_id: job.id },
      ),
      // Modal khởi động nguội có thể mất vài giây. Quá mức này thì bỏ, để cron lo.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error("[modal] submit lỗi", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[modal] không gọi được submit", err);
    return false;
  }
}
