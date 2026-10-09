"""Task của worker (export, phụ đề, probe media…) và các hàng nó đọc lại."""

from __future__ import annotations

from typing import Any

from opencmo.backends.supabase.http import _Http
from opencmo.backends.supabase.models import LEASE_SECONDS, Task, _first_row, _first_task


class TasksMixin(_Http):
    # ------------------------------------------------------------- tasks (D2)
    #
    # Cùng mẫu lease + attempt như `jobs` ở trên (xem
    # 20260914093000_web_rpc_worker.sql): claim sinh attempt mới, heartbeat gia
    # hạn, complete/fail chỉ ghi cho attempt hiện hành và replay được.

    def claim_next_task(self, kinds: list[str]) -> Task | None:
        """Nhận task `queued` cũ nhất trong các `kinds`. KHÔNG retry: timeout có
        thể đã claim; lease hết hạn sẽ trả task đó về hàng đợi."""
        resp = self._rpc(
            "claim_next_task",
            {"p_kinds": kinds, "p_lease_seconds": LEASE_SECONDS},
            idempotent=False,
        )
        return _first_task(resp.json())

    def claim_task(self, task_id: str) -> Task | None:
        """Chiếm đúng một task đã có id (đường 'submit' web đánh thức worker)."""
        resp = self._rpc(
            "claim_task",
            {"p_task_id": task_id, "p_lease_seconds": LEASE_SECONDS},
            idempotent=False,
        )
        return _first_task(resp.json())

    def heartbeat_task(self, task_id: str, attempt_id: str | None) -> bool:
        """Gia hạn lease. False nghĩa là attempt đã mất quyền — dừng làm tiếp."""
        resp = self._rpc(
            "heartbeat_task",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_lease_seconds": LEASE_SECONDS},
            idempotent=True,
        )
        return resp.json() is True

    def task_progress(self, task_id: str, attempt_id: str | None, progress: float) -> bool:
        """Tiến độ 0–1 của task (thanh Export). Chỉ attempt đang giữ task ghi được."""
        resp = self._rpc(
            "task_progress",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_progress": round(float(progress), 4)},
            idempotent=True,
        )
        return resp.json() is True

    def complete_task(
        self, task_id: str, attempt_id: str | None, output: dict[str, Any] | None
    ) -> bool:
        resp = self._rpc(
            "complete_task",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_output": output},
            idempotent=True,
        )
        return resp.json() is True

    def complete_full_edit(
        self,
        task_id: str,
        attempt_id: str | None,
        *,
        settings: dict[str, Any],
        settings_hash: str,
        master: dict[str, Any],
    ) -> bool:
        """Công bố chế độ cả video (E2-c): revision #1 + draft + master + xong task, một giao dịch."""
        resp = self._rpc(
            "complete_full_edit",
            {
                "p_task_id": task_id,
                "p_attempt_id": attempt_id,
                "p_settings": settings,
                "p_settings_hash": settings_hash,
                "p_master": master,
            },
            idempotent=True,
        )
        return resp.json() is True

    def complete_media_captions(self, task_id: str, attempt_id: str | None, body: str) -> str | None:
        """Ghi transcript phụ đề (E4-e) + xong task, một giao dịch; trả hash nội dung."""
        resp = self._rpc(
            "complete_media_captions",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_body": body},
            idempotent=True,
        )
        return resp.json()

    def fail_task(self, task_id: str, attempt_id: str | None, error: str) -> bool:
        """`error` hiện THẲNG trên màn hình người dùng — phải là tiếng Anh."""
        resp = self._rpc(
            "fail_task",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_error": error[:2000]},
            idempotent=True,
        )
        return resp.json() is True

    def reclaim_expired_tasks(self, max_attempts: int = 3) -> dict[str, Any]:
        resp = self._rpc(
            "reclaim_expired_tasks", {"p_max_attempts": max_attempts}, idempotent=True
        )
        return resp.json() or {}

    def complete_media_probe(
        self,
        asset_id: str,
        attempt_id: str | None,
        *,
        duration: float | None,
        width: int | None,
        height: int | None,
        ok: bool,
        error: str | None = None,
    ) -> bool:
        resp = self._rpc(
            "complete_media_probe",
            {
                "p_asset_id": asset_id,
                "p_attempt_id": attempt_id,
                "p_duration": duration,
                "p_width": width,
                "p_height": height,
                "p_ok": ok,
                "p_error": error,
            },
            idempotent=True,
        )
        return resp.json() is True

    # --------------------------------------------------------- read helpers
    #
    # GET service-role, luôn idempotent. ID trong payload của web/task KHÔNG
    # BAO GIỜ được tin — mọi hàm xử lý phải đọc lại hàng canonical ở đây.

    def get_task(self, task_id: str) -> Task | None:
        resp = self._send(
            "GET", "/rest/v1/tasks", idempotent=True, params={"id": f"eq.{task_id}", "select": "*"}
        )
        return _first_task(resp.json())

    def get_clip(self, clip_id: str) -> dict[str, Any] | None:
        resp = self._send(
            "GET", "/rest/v1/clips", idempotent=True, params={"id": f"eq.{clip_id}", "select": "*"}
        )
        return _first_row(resp.json())

    def get_media_asset(self, asset_id: str) -> dict[str, Any] | None:
        resp = self._send(
            "GET",
            "/rest/v1/media_assets",
            idempotent=True,
            params={"id": f"eq.{asset_id}", "select": "*"},
        )
        return _first_row(resp.json())

    def get_editor_revision(self, revision_id: str) -> dict[str, Any] | None:
        """Ảnh chụp bất biến của document lúc bấm Export (`editor_revisions`)."""
        resp = self._send(
            "GET",
            "/rest/v1/editor_revisions",
            idempotent=True,
            params={"id": f"eq.{revision_id}", "select": "*"},
        )
        return _first_row(resp.json())

    def get_editor_transcript(self, clip_id: str, digest: str) -> str | None:
        """Transcript người dùng đã sửa, đúng từng byte đã lưu (địa chỉ theo sha256)."""
        resp = self._send(
            "GET",
            "/rest/v1/editor_transcripts",
            idempotent=True,
            params={"clip_id": f"eq.{clip_id}", "hash": f"eq.{digest}", "select": "body"},
        )
        # Không qua `_first_row`: bảng này không có cột `id`, và hàm đó coi hàng
        # thiếu `id` là không có hàng — transcript đã sửa thành "không tồn tại".
        rows = resp.json() or []
        return str(rows[0]["body"]) if rows and isinstance(rows[0], dict) and "body" in rows[0] else None

    def get_tasks(self, task_ids: list[str]) -> list[Task]:
        if not task_ids:
            return []
        resp = self._send(
            "GET",
            "/rest/v1/tasks",
            idempotent=True,
            params={"id": f"in.({','.join(task_ids)})", "select": "*"},
        )
        return [Task.from_row(row) for row in resp.json() or []]
