"""Khung chung của task worker: mọi kết cục được chốt đúng một lần, ở một chỗ."""

from __future__ import annotations

import pytest

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.worker.task_run import TaskError, run_task


class FakeStore:
    def __init__(self, canonical: Task | None = None) -> None:
        self.failed: list[str] = []
        self.removed: list[tuple[str, list[str]]] = []
        self.canonical = canonical

    def heartbeat_task(self, *_args):
        return True

    def fail_task(self, _task_id, _attempt_id, message):
        self.failed.append(message)
        return True

    def remove_objects(self, bucket, paths):
        self.removed.append((bucket, list(paths)))

    def get_task(self, _task_id):
        return self.canonical


TASK = Task(id="t1", user_id="u1", kind="zip", attempt_id="a1")


class Cancelled(Exception):
    pass


def _run(store, body, **kwargs):
    run_task(store, TASK, name="test", failed="Something failed. Please try again.", body=body, **kwargs)


def test_task_error_chot_dung_cau_cua_no_va_don_file():
    store = FakeStore()

    def body(ctx):
        ctx.uploaded("renders", "u1/a.zip")
        raise TaskError("This clip is gone.")

    _run(store, body)
    assert store.failed == ["This clip is gone."]
    assert store.removed == [("renders", ["u1/a.zip"])]


def test_loi_la_chot_cau_chung_khong_lo_noi_bo():
    store = FakeStore()

    def body(_ctx):
        raise RuntimeError("ffmpeg nổ ở dòng 42")

    _run(store, body)
    assert store.failed == ["Something failed. Please try again."]


def test_quiet_khong_ghi_gi():
    store = FakeStore()

    def body(_ctx):
        raise Cancelled()

    _run(store, body, quiet=(Cancelled,))
    assert store.failed == []


def test_loi_tam_truoc_khi_gui_ket_qua_de_lease_chay_lai():
    store = FakeStore()

    def body(ctx):
        ctx.uploaded("renders", "u1/a.zip")
        raise TransientError("504")

    with pytest.raises(TransientError):
        _run(store, body)
    assert store.failed == []
    assert store.removed == []


def test_mat_response_sau_khi_da_chot_thi_coi_la_xong():
    done = Task(id="t1", user_id="u1", kind="zip", status="done", attempt_id="a1")
    store = FakeStore(canonical=done)

    def body(ctx):
        ctx.uploaded("renders", "u1/a.zip")

        def lost_response():
            raise TransientError("response lost after commit")

        ctx.complete(lost_response)

    _run(store, body)
    assert store.failed == []
    assert store.removed == [], "file của attempt thắng không được xoá"


def test_mat_response_va_attempt_khac_da_thang_thi_don_roi_raise():
    other = Task(id="t1", user_id="u1", kind="zip", status="running", attempt_id="a2")
    store = FakeStore(canonical=other)

    def body(ctx):
        ctx.uploaded("renders", "u1/a.zip")
        ctx.complete(lambda: (_ for _ in ()).throw(TransientError("lost")))

    with pytest.raises(TransientError):
        _run(store, body)
    assert store.removed == [("renders", ["u1/a.zip"])]


def test_complete_tra_false_thi_don_file_cua_attempt_thua():
    store = FakeStore()

    def body(ctx):
        ctx.uploaded("renders", "u1/a.zip")
        assert ctx.complete(lambda: False) is False

    _run(store, body)
    assert store.failed == []
    assert store.removed == [("renders", ["u1/a.zip"])]


def test_thu_muc_tam_ton_tai_trong_body_va_bi_xoa_sau():
    store = FakeStore()
    seen = {}

    def body(ctx):
        seen["root"] = ctx.root
        assert ctx.root.is_dir()
        assert ctx.lost() is False

    _run(store, body)
    assert not seen["root"].exists()
