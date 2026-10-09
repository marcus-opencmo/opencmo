"""`Heartbeat` tổng quát (tách khỏi modal_app.py) — không chạm mạng, không chạm thread thật lâu."""

from __future__ import annotations

import threading
import time

from opencmo.worker.heartbeat import HEARTBEAT_SECONDS, Heartbeat


def test_heartbeat_seconds_default_matches_contract():
    assert HEARTBEAT_SECONDS == 30


def test_heartbeat_calls_beat_repeatedly_and_stops_on_exit():
    calls = []
    done = threading.Event()

    def beat() -> bool:
        calls.append(1)
        if len(calls) >= 3:
            done.set()
        return True

    with Heartbeat(beat, "t1", interval=0.01):
        assert done.wait(timeout=2.0)

    # Sau __exit__, luồng đã dừng: không còn beat nào chạy tiếp sau khi ta chốt số lần.
    count_at_exit = len(calls)
    time.sleep(0.05)
    assert len(calls) == count_at_exit


def test_heartbeat_sets_lost_when_beat_returns_false():
    hb = Heartbeat(lambda: False, "t2", interval=0.01)
    with hb:
        assert hb.lost.wait(timeout=2.0)


def test_heartbeat_logs_and_continues_on_exception():
    calls = []

    def beat() -> bool:
        calls.append(1)
        raise RuntimeError("mạng lỗi tạm")

    # Ném exception ở MỌI lần gọi không được làm chết luồng — beat() phải được
    # gọi lại ở nhịp sau thay vì luồng heartbeat âm thầm biến mất.
    hb = Heartbeat(beat, "t3", interval=0.01)
    with hb:
        deadline = time.monotonic() + 2.0
        while len(calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.005)
    assert len(calls) >= 3
