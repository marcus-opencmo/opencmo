"""Task kind của worker — đọc `packages/contracts/task-kinds.json`.

Một danh sách cho mọi nơi phân việc (vòng lặp dev, `run_task` và sweep của Modal,
harness e2e). Trước R2 nó được chép tay ở năm chỗ; quên một chỗ là task nằm
`queued` mãi mà không ai báo lỗi.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

# Máy dev: packages/engine/opencmo/worker/kinds.py → packages/contracts.
# Modal: modal_app.py chép file vào /root/contracts.
_CANDIDATES = (
    Path(__file__).resolve().parents[3] / "contracts" / "task-kinds.json",
    Path("/root/contracts/task-kinds.json"),
)


def _path() -> Path:
    for candidate in _CANDIDATES:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("packages/contracts/task-kinds.json not found")


@lru_cache(maxsize=1)
def _entries() -> tuple[tuple[str, str], ...]:
    data = json.loads(_path().read_text(encoding="utf-8"))
    return tuple((str(entry["kind"]), str(entry["handler"])) for entry in data["kinds"])


def task_kinds() -> tuple[str, ...]:
    """Mọi kind, theo thứ tự ưu tiên claim."""
    return tuple(kind for kind, _ in _entries())


def handlers() -> dict[str, Callable[[Any, Any], None]]:
    """kind → hàm `process(store, task)`. Import lười: Modal chỉ nạp khi cần."""
    result = {}
    for kind, target in _entries():
        module, _, name = target.partition(":")
        result[kind] = getattr(importlib.import_module(module), name)
    return result
