"""Trạng thái của MỘT lượt chạy job mà điều phối và chuỗi `except` cùng đọc."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from opencmo.backends.supabase import Job, StaleAttemptError
from opencmo.worker.job_uploads import Uploads

STALE_ATTEMPT = "This processing attempt is no longer current."


@dataclass
class JobRun:
    """Dựng TRƯỚC heartbeat và thư mục tạm: nhánh lỗi cần `uploads`, `stage` và
    `publication_sent` kể cả khi chính hai thứ đó hỏng lúc mở."""

    store: Any
    job: Job
    uploads: Uploads
    root: Path | None = None
    heartbeat: Any = None
    # Bước đang chạy — câu lỗi cho người dùng nói theo nó (`processing_error`).
    stage: str = "probe"
    # Đã gửi RPC công bố: từ đây chỉ DB biết giao dịch đã commit hay chưa.
    publication_sent: bool = False
    started: float = field(default_factory=time.monotonic)

    def set_stage(self, stage: str) -> None:
        self.stage = stage
        self.store.update_job_stage(self.job.id, self.job.attempt_id, stage)

    def mark_publication_sent(self) -> None:
        self.publication_sent = True

    def check_lease(self) -> None:
        if self.heartbeat.lost.is_set():
            raise StaleAttemptError(STALE_ATTEMPT)
