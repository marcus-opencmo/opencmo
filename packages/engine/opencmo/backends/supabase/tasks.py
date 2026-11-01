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

    def claim_next_task(self, kinds: list[str], max_running: int | None = None) -> Task | None:
        """Takes the next `queued` task of `kinds`: the user with the fewest running tasks first, then kind order and
        age. With `max_running`, nothing while that many tasks already run (the worker's container cap). No retry: a
        timeout may have claimed; an expired lease puts the task back in the queue."""
        params: dict[str, object] = {"p_kinds": kinds, "p_lease_seconds": LEASE_SECONDS}
        if max_running is not None:
            params["p_max_running"] = max_running
        resp = self._rpc("claim_next_task", params, idempotent=False)
        return _first_task(resp.json())

    def claim_task(self, task_id: str, max_running: int | None = None) -> Task | None:
        """Claims one task by id (the web's 'submit' path). With `max_running`, nothing while that many tasks run:
        the task stays queued and the sweep takes it when a container frees up."""
        params: dict[str, object] = {"p_task_id": task_id, "p_lease_seconds": LEASE_SECONDS}
        if max_running is not None:
            params["p_max_running"] = max_running
        resp = self._rpc("claim_task", params, idempotent=False)
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

    def complete_media_captions(self, task_id: str, attempt_id: str | None, body: str) -> str | None:
        """Ghi transcript phụ đề (E4-e) + xong task, một giao dịch; trả hash nội dung."""
        resp = self._rpc(
            "complete_media_captions",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_body": body},
            idempotent=True,
        )
        return resp.json()

    def complete_media_transcript(self, task_id: str, attempt_id: str | None, body: str, source: str) -> str | None:
        """Store a file's transcript (`media_transcripts`) and finish the task in one transaction."""
        resp = self._rpc(
            "complete_media_transcript",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_body": body, "p_source": source},
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

    def reap_agent_turns(self) -> int:
        """Close Assistant turns nobody will finish (dead request, tab closed on a card); their held
        credits come back."""
        resp = self._rpc("agent_reap_turns", {}, idempotent=True)
        value = resp.json()
        return value if isinstance(value, int) else 0

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
        has_audio: bool | None = None,
    ) -> bool:
        """`has_audio`: a ready file with an audio stream is queued for its free transcript."""
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
                "p_has_audio": has_audio,
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

    def get_page_capture(self, capture_id: str) -> dict[str, Any] | None:
        """A page capture (`page_captures`); the task checks it is its own before capturing."""
        resp = self._send(
            "GET", "/rest/v1/page_captures", idempotent=True, params={"id": f"eq.{capture_id}", "select": "*"}
        )
        return _first_row(resp.json())

    def complete_page_capture(
        self, task_id: str, attempt_id: str | None, title: str, width: int, height: int
    ) -> bool:
        """The capture is ready and its task done, in one transaction (paths are fixed by the RPC)."""
        resp = self._rpc(
            "complete_page_capture",
            {"p_task_id": task_id, "p_attempt_id": attempt_id, "p_title": title, "p_width": width, "p_height": height},
            idempotent=True,
        )
        return resp.json() is True

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
