"""Generate: đọc spec/code cảnh, công bố media sinh ra."""

from __future__ import annotations

from typing import Any

from opencmo.backends.supabase.http import _Http
from opencmo.backends.supabase.models import _first_row


class GenerationsMixin(_Http):
    def get_generation(self, generation_id: str) -> dict[str, Any] | None:
        resp = self._send(
            "GET",
            "/rest/v1/generations",
            idempotent=True,
            params={"id": f"eq.{generation_id}", "select": "*"},
        )
        return _first_row(resp.json())

    def get_ai_model(self, model_id: str) -> dict[str, Any] | None:
        """Hàng catalog trong DB (G5): giá, giới hạn, bật/tắt — nguồn sự thật khi chạy."""
        resp = self._send(
            "GET",
            "/rest/v1/ai_models",
            idempotent=True,
            params={"id": f"eq.{model_id}", "select": "id,price,limits,enabled"},
        )
        return _first_row(resp.json())

    def get_scene_code(self, user_id: str, code_hash: str) -> str | None:
        """Code của cảnh `template: "code"` (spec code-scenes), đúng của người dùng đó."""
        resp = self._send(
            "GET",
            "/rest/v1/scene_codes",
            idempotent=True,
            params={"user_id": f"eq.{user_id}", "hash": f"eq.{code_hash}", "select": "code"},
        )
        # Không dùng `_first_row`: nó đòi cột `id`, mà truy vấn này chỉ chọn `code`.
        rows = resp.json()
        row = rows[0] if isinstance(rows, list) and rows else None
        return str(row["code"]) if isinstance(row, dict) and isinstance(row.get("code"), str) else None

    def complete_generation(
        self,
        task_id: str,
        attempt_id: str | None,
        *,
        object_name: str,
        name: str,
        duration: float | None,
        width: int | None,
        height: int | None,
        credits: int,
        words: list[dict[str, Any]] | None = None,
    ) -> bool:
        """False = task không còn thuộc attempt này (bị huỷ, bị reclaim) — người
        gọi phải xoá file vừa tải lên, vì không hàng nào tham chiếu nó."""
        resp = self._rpc(
            "complete_generation",
            {
                "p_task_id": task_id,
                "p_attempt_id": attempt_id,
                "p_object_name": object_name,
                "p_name": name,
                "p_duration": duration,
                "p_width": width,
                "p_height": height,
                "p_credits": credits,
                "p_words": words,
            },
            idempotent=True,
        )
        return resp.json() is True
