"""task-kinds.json là nguồn duy nhất: mọi handler import được, không kind trùng."""

from __future__ import annotations

from opencmo.worker import kinds


def test_moi_kind_co_handler_import_duoc():
    handlers = kinds.handlers()
    assert list(handlers) == list(kinds.task_kinds())
    assert all(callable(handler) for handler in handlers.values())


def test_kind_khong_trung_va_dung_thu_tu_uu_tien():
    names = kinds.task_kinds()
    assert len(names) == len(set(names))
    # Người dùng đang nhìn "Checking video…"/"Generating…" → hai kind ngắn đứng đầu;
    # ZIP có trạng thái riêng trên trang project nên đứng cuối.
    assert names[:2] == ("probe_media", "generate")
    assert names[-1] == "zip"
