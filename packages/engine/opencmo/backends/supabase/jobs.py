"""Job cắt clip: lease, publication, artifact, đối soát credit."""

from __future__ import annotations

import uuid
from typing import Any

from opencmo.backends import retry
from opencmo.backends.supabase.http import _JSON, _Http
from opencmo.backends.supabase.models import (
    LEASE_SECONDS,
    InsufficientCreditsError,
    Job,
    StaleAttemptError,
    _first_job,
    _first_row,
    _translate_stale_attempt,
)


class JobsMixin(_Http):
    def claim_next_job(self) -> Job | None:
        """Nhận job queued cũ nhất và mở attempt mới. KHÔNG retry: timeout có
        thể đã claim; lease hết hạn sẽ trả job đó về hàng đợi."""
        resp = self._rpc(
            "claim_next_job_attempt", {"p_lease_seconds": LEASE_SECONDS}, idempotent=False
        )
        return _first_job(resp.json())

    def claim_job(self, job_id: str) -> Job | None:
        """Chiếm đúng một job: 'queued' → 'running' kèm attempt mới.

        Trả về hàng canonical từ database — owner, nguồn, watermark lấy ở đây,
        không lấy từ payload của web. None nghĩa là đã có worker khác nhận.
        """
        resp = self._rpc(
            "claim_job_attempt",
            {"p_job_id": job_id, "p_lease_seconds": LEASE_SECONDS},
            idempotent=False,
        )
        return _first_job(resp.json())

    def get_job(self, job_id: str) -> Job | None:
        resp = self._send(
            "GET",
            "/rest/v1/jobs",
            idempotent=True,
            params={"id": f"eq.{job_id}", "select": "*"},
        )
        return _first_job(resp.json())

    def heartbeat(self, job_id: str, attempt_id: str | None) -> bool:
        """Gia hạn lease. False nghĩa là attempt đã mất quyền — dừng làm tiếp."""
        resp = self._rpc(
            "heartbeat_job",
            {"p_job_id": job_id, "p_attempt_id": attempt_id, "p_lease_seconds": LEASE_SECONDS},
            idempotent=True,
        )
        return resp.json() is True

    def set_call_id(self, job_id: str, attempt_id: str | None, call_id: str) -> None:
        self._send(
            "PATCH",
            "/rest/v1/jobs",
            idempotent=True,
            params={"id": f"eq.{job_id}", "attempt_id": f"eq.{attempt_id}"},
            json={"call_id": call_id},
            headers={**_JSON, "Prefer": "return=minimal"},
        )

    def complete(
        self,
        job_id: str,
        attempt_id: str | None,
        *,
        title: str,
        duration: float,
        clips: list[dict[str, Any]],
    ) -> bool:
        """Chốt done + chèn clip trong một giao dịch. False = attempt đã bị thay."""
        resp = self._rpc(
            "complete_job",
            {
                "p_job_id": job_id,
                "p_attempt_id": attempt_id,
                "p_title": title,
                "p_duration_seconds": duration,
                "p_clips": clips,
            },
            idempotent=True,
        )
        return resp.json() is True

    def fail(self, job_id: str, attempt_id: str | None, error: str) -> dict[str, Any]:
        """Chốt failed + hoàn credit trong một giao dịch, replay được.

        `error` hiện trên trang kết quả nên phải là tiếng Anh.
        """
        key = f"fail:{attempt_id}" if attempt_id else f"fail:{uuid.uuid4()}"
        resp = self._rpc(
            "finalize_job_failure",
            {
                "p_job_id": job_id,
                "p_attempt_id": attempt_id,
                "p_error": error[:2000],
                "p_operation_key": key,
            },
            idempotent=True,
        )
        return resp.json() or {}

    def reclaim_expired(self, max_attempts: int = 3) -> dict[str, Any]:
        resp = self._rpc(
            "reclaim_expired_jobs", {"p_max_attempts": max_attempts}, idempotent=True
        )
        return resp.json() or {}

    # ------------------------------------------------- artifact / drafts / publish

    def put_artifact(
        self, job_id: str, attempt_id: str | None, kind: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Ghi một artifact AI (transcript, moments, ...). Replay đúng dữ liệu
        trả lại hàng cũ; replay KHÁC dữ liệu hoặc attempt không còn hiện hành
        thì RPC raise — dịch lỗi P0001 sang `StaleAttemptError`."""
        try:
            resp = self._rpc(
                "put_artifact",
                {"p_job_id": job_id, "p_attempt_id": attempt_id, "p_kind": kind, "p_data": data},
                idempotent=True,
            )
        except retry.PermanentError as exc:
            translated = _translate_stale_attempt(exc)
            if translated is not exc:
                raise translated from exc
            raise
        return resp.json()

    def create_clip_drafts(
        self, job_id: str, attempt_id: str | None, revisions: list[dict[str, Any]]
    ) -> int:
        """Tạo revision #1 + draft cho các clip chưa có draft. Xem docstring
        `put_artifact` về việc dịch lỗi attempt hết hạn."""
        try:
            resp = self._rpc(
                "create_clip_drafts",
                {"p_job_id": job_id, "p_attempt_id": attempt_id, "p_revisions": revisions},
                idempotent=True,
            )
        except retry.PermanentError as exc:
            translated = _translate_stale_attempt(exc)
            if translated is not exc:
                raise translated from exc
            raise
        return int(resp.json())

    def publish_job_clip(self, job_id: str, attempt_id: str | None, clip: dict[str, Any]) -> bool:
        """Công bố clip tải được ngay, không chờ các clip khác hay editor."""
        response = self._rpc(
            "publish_job_clip",
            {"p_job_id": job_id, "p_attempt_id": attempt_id, "p_clip": clip},
            idempotent=True,
        )
        return response.json() is True

    def complete_job_publication(
        self,
        job_id: str,
        attempt_id: str | None,
        *,
        title: str,
        duration: float,
        clips: list[dict[str, Any]],
        revisions: list[dict[str, Any]],
        manifest: dict[str, Any],
    ) -> bool:
        """Công bố clip + revision + draft + manifest trong MỘT giao dịch —
        xem 20260916090000_worker_d2_publication.sql. False = attempt không
        còn hiện hành hoặc job không còn running; không ghi gì."""
        resp = self._rpc(
            "complete_job_publication",
            {
                "p_job_id": job_id,
                "p_attempt_id": attempt_id,
                "p_title": title,
                "p_duration_seconds": duration,
                "p_clips": clips,
                "p_revisions": revisions,
                "p_manifest": manifest,
            },
            idempotent=True,
        )
        return resp.json() is True

    def update_job_stage(self, job_id: str, attempt_id: str | None, stage: str) -> None:
        """Cập nhật `jobs.stage` (hiện tiến độ) — chỉ ghi khi đúng attempt và
        job còn đang chạy, nên attempt cũ về muộn không ghi đè tiến độ mới."""
        self._send(
            "PATCH",
            "/rest/v1/jobs",
            idempotent=True,
            params={"id": f"eq.{job_id}", "attempt_id": f"eq.{attempt_id}", "status": "eq.running"},
            json={"stage": stage},
            headers={**_JSON, "Prefer": "return=minimal"},
        )

    def update_job_title(self, job_id: str, attempt_id: str | None, title: str) -> None:
        """Ghi tiêu đề nguồn ngay sau probe, cùng rào attempt với `update_job_stage`.

        Trước đây tiêu đề chỉ tới lúc công bố clip, nên job hỏng giữa chừng hiện
        "Your video" + URL thô dù probe đã biết tên (UAT production 29/09). Tên
        người dùng tự đặt nằm ở cột `name` và được ưu tiên, nên không bị đè.
        """
        self._send(
            "PATCH",
            "/rest/v1/jobs",
            idempotent=True,
            params={"id": f"eq.{job_id}", "attempt_id": f"eq.{attempt_id}", "status": "eq.running"},
            json={"title": title[:500]},
            headers={**_JSON, "Prefer": "return=minimal"},
        )

    def get_job_row(self, job_id: str) -> dict[str, Any] | None:
        resp = self._send(
            "GET", "/rest/v1/jobs", idempotent=True, params={"id": f"eq.{job_id}", "select": "*"}
        )
        return _first_row(resp.json())

    def list_artifacts(self, job_id: str, kind: str) -> list[dict[str, Any]]:
        resp = self._send(
            "GET",
            "/rest/v1/artifacts",
            idempotent=True,
            params={
                "job_id": f"eq.{job_id}",
                "kind": f"eq.{kind}",
                "select": "version,data,created_at,attempt_id",
                "order": "version.asc",
            },
        )
        return resp.json() or []

    def list_clips(self, job_id: str) -> list[dict[str, Any]]:
        resp = self._send(
            "GET",
            "/rest/v1/clips",
            idempotent=True,
            params={"job_id": f"eq.{job_id}", "select": "*", "order": "idx.asc"},
        )
        return resp.json() or []

    # ------------------------------------------------------------- credits

    def settle(self, job_id: str, duration_seconds: float, attempt_id: str | None = None) -> None:
        """Đối soát credit theo độ dài THẬT, ngay sau bước probe.

        Lúc người dùng bấm nút chưa ai biết video dài bao nhiêu, nên web chỉ giữ
        tạm một khoản. Đây là nhịp thứ hai: cộng lại phần thừa, hoặc trừ thêm
        phần thiếu. Không đủ để trừ thêm thì dừng job NGAY tại đây — thà dừng
        trước khi tải còn hơn render xong 5 clip rồi mới biết không thu được tiền.

        Khoá thao tác theo attempt: Modal chạy lại cùng attempt thì settle lần
        hai trả đúng kết quả lần đầu thay vì tính lại.
        """
        key = f"settle:{attempt_id}" if attempt_id else f"settle:{uuid.uuid4()}"
        body: dict[str, Any] = {
            "p_job_id": job_id,
            "p_duration_seconds": duration_seconds,
            "p_operation_key": key,
        }
        if attempt_id:
            body["p_attempt_id"] = attempt_id

        result = self._rpc("settle_job_credits", body, idempotent=True).json()
        if result is None:
            raise StaleAttemptError("This processing attempt is no longer current.")
        if result is False:
            raise InsufficientCreditsError(
                "Not enough credits for a video this long — the hold has been refunded."
            )
