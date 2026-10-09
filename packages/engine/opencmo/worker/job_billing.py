"""Tính tiền job theo độ dài THẬT, ngay sau bước probe."""

from __future__ import annotations

from typing import Any

from opencmo.worker.job_context import JobRun


def settle_on_probe(run: JobRun, source: Any) -> None:
    """Nhịp hai của credit (`settle_job_credits`). Không đủ tiền thì `settle` ném
    `InsufficientCreditsError` — phần giữ đã hoàn trong cùng giao dịch, nên nhánh
    bắt lỗi của `process()` không hoàn thêm. Dừng ở đây là trước khi tải đoạn nào."""
    job = run.job
    run.store.settle(job.id, source.duration, attempt_id=job.attempt_id)
    if source.title and source.title != "untitled":
        run.store.update_job_title(job.id, job.attempt_id, source.title)
    run.check_lease()
