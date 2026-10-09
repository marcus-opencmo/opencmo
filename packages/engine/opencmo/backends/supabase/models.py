"""Hàng `jobs`/`tasks` và các lỗi worker phải phân biệt được."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from opencmo.backends import retry

# Lease của một attempt. Worker heartbeat mỗi 30 giây (modal_app.py); quá hạn
# thì `reclaim_expired_jobs()` coi worker đã chết.
LEASE_SECONDS = 120


class InsufficientCreditsError(RuntimeError):
    """Video dài hơn số credit người dùng còn.

    Chỉ biết được sau bước probe. Phần giữ tạm đã được hoàn trong cùng giao dịch
    ở `settle_job_credits()`, nên nhánh bắt lỗi KHÔNG hoàn thêm lần nữa.
    """


class StaleAttemptError(RuntimeError):
    """Attempt này đã bị reconciler thay; kết quả của nó không được ghi."""


class ObjectTooLargeError(RuntimeError):
    """Object trong storage vượt `max_bytes` cho phép — tải dở bị huỷ và xoá
    ngay để không để lại file rác trên đĩa worker."""


# Message P0001 của `put_artifact`/`create_clip_drafts` khi attempt không còn
# hiện hành (xem 20260915094932_web_worker_review_fixes.sql). So khớp nguyên
# văn để không dịch nhầm một lỗi 400 khác (vd dữ liệu revision sai hình dạng)
# thành StaleAttemptError.
_STALE_ATTEMPT_MESSAGE = "This processing attempt is no longer active."


def _translate_stale_attempt(exc: retry.PermanentError) -> Exception:
    body = exc.body
    if isinstance(body, dict) and body.get("message") == _STALE_ATTEMPT_MESSAGE:
        return StaleAttemptError(_STALE_ATTEMPT_MESSAGE)
    return exc


@dataclass
class Job:
    id: str
    user_id: str
    source_url: str
    clips_requested: int
    # Bản free có watermark. Cờ chốt lúc tạo job, không đọc lại plan lúc render:
    # người dùng nâng cấp giữa chừng thì job đang chạy vẫn giữ nguyên điều kiện
    # lúc bấm nút, và ta luôn giải thích được vì sao một clip cũ có watermark.
    watermark: bool = True
    status: str = "queued"
    attempt: int = 0
    attempt_id: str | None = None
    # Người dùng chọn lúc tạo project ("auto" khi job cũ chưa có cột này).
    clip_length: str = "auto"
    # Các đoạn người dùng tự kéo trên thanh bar, `[{"start": s, "end": e}, …]`.
    # None nghĩa là "để AI chọn" — đúng hành vi của mọi job trước cột này.
    segments: list[dict[str, Any]] | None = None
    # Tuỳ chọn đầu ra, chọn lúc tạo project. Mặc định trùng hành vi trước khi
    # có các cột này, nên job cũ chạy lại vẫn ra đúng thứ đã giao cho người dùng.
    mode: str = "clip"
    aspect: str = "9:16"
    layout: str = "auto"
    captions: bool = True

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Job:
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            source_url=row["source_url"],
            clips_requested=int(row.get("clips_requested") or 5),
            watermark=bool(row.get("watermark", True)),
            status=row.get("status") or "queued",
            attempt=int(row.get("attempt") or 0),
            attempt_id=row.get("attempt_id"),
            clip_length=row.get("clip_length") or "auto",
            # `[]` từ database được coi là None: một mảng rỗng không mô tả được
            # đoạn nào, và rơi về nhánh AI là hành vi an toàn hơn job chết.
            segments=list(row.get("segments") or []) or None,
            mode=row.get("mode") or "clip",
            aspect=row.get("aspect") or "9:16",
            layout=row.get("layout") or "auto",
            captions=bool(row.get("captions", True)),
        )


def _first_row(payload: Any) -> dict[str, Any] | None:
    """RPC `setof` và GET đều trả một mảng; PostgREST đôi khi trả thẳng một
    object cho hàm trả `setof` một dòng. Chuẩn hoá về `dict | None` một chỗ."""
    row = payload[0] if isinstance(payload, list) and payload else payload
    return row if isinstance(row, dict) and row.get("id") else None


def _first_job(payload: Any) -> Job | None:
    row = _first_row(payload)
    return Job.from_row(row) if row else None


def _first_task(payload: Any) -> Task | None:
    row = _first_row(payload)
    return Task.from_row(row) if row else None


@dataclass
class Task:
    """Một hàng của `tasks` (mọi kind trong bảng dispatch của worker)."""

    id: str
    user_id: str
    kind: str
    clip_id: str | None = None
    settings_hash: str | None = None
    asset_id: str | None = None
    job_id: str | None = None
    payload: dict[str, Any] | None = None
    output_path: str | None = None
    output: dict[str, Any] | None = None
    status: str = "queued"
    attempt: int = 0
    attempt_id: str | None = None
    created_at: str | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Task:
        return cls(
            id=row["id"],
            user_id=row["user_id"],
            kind=row["kind"],
            clip_id=row.get("clip_id"),
            settings_hash=row.get("settings_hash"),
            asset_id=row.get("asset_id"),
            job_id=row.get("job_id"),
            payload=row.get("payload"),
            output_path=row.get("output_path"),
            output=row.get("output"),
            status=row.get("status") or "queued",
            attempt=int(row.get("attempt") or 0),
            attempt_id=row.get("attempt_id"),
            created_at=row.get("created_at"),
        )
