"""Vòng lặp worker dev: ưu tiên, phục hồi lỗi và chốt lỗi an toàn."""

from __future__ import annotations

from collections import deque

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Job, Task
from opencmo.worker.kinds import task_kinds
from opencmo.worker.loop import JOB_FAILURE, TASK_FAILURE, run_forever


class FakeStore:
    def __init__(self) -> None:
        self.jobs = deque()
        # Every kind task-kinds.json lists, as the real claim RPC takes them.
        self.tasks = {kind: deque() for kind in task_kinds()}
        self.claimed_kinds = []
        self.failed_tasks = []
        self.failed_jobs = []
        self.reclaims = []
        self.closed = False

    def reclaim_expired_tasks(self):
        self.reclaims.append("tasks")

    def reclaim_expired(self):
        self.reclaims.append("jobs")

    def claim_next_job(self):
        return self.jobs.popleft() if self.jobs else None

    def claim_next_task(self, kinds):
        # Như RPC thật sau R2: một lượt cho cả mảng, kind đứng trước thắng.
        self.claimed_kinds.append(list(kinds))
        for kind in kinds:
            if self.tasks[kind]:
                return self.tasks[kind].popleft()
        return None

    def fail_task(self, task_id, attempt_id, message):
        self.failed_tasks.append((task_id, attempt_id, message))
        return True

    def fail(self, job_id, attempt_id, message):
        self.failed_jobs.append((job_id, attempt_id, message))
        return {"transitioned": True}

    def close(self):
        self.closed = True


def _stop_after(calls, count):
    def sleep(seconds):
        calls.append(seconds)
        if len(calls) >= count:
            raise KeyboardInterrupt

    return sleep


def test_job_is_claimed_before_tasks_and_store_closes():
    store = FakeStore()
    store.jobs.append(Job("j1", "u1", "https://x", 1, attempt_id="a1"))
    store.tasks["probe_media"].append(Task("t1", "u1", "probe_media"))
    handled = []
    sleeps = []

    run_forever(
        lambda: store,
        {"job": lambda _store, item: handled.append(item.id)},
        sleep=_stop_after(sleeps, 1),
    )

    assert handled == ["j1"]
    assert store.claimed_kinds[0][0] == "probe_media"
    assert store.closed is True


def test_tasks_are_claimed_in_one_call_in_user_wait_priority():
    store = FakeStore()
    store.tasks["capture_page"].append(Task("capture-1", "u1", "capture_page", attempt_id="a1"))
    store.tasks["probe_media"].append(Task("probe-1", "u1", "probe_media", attempt_id="a2"))
    handled = []

    run_forever(
        lambda: store,
        {kind: (lambda _store, item: handled.append(item.id)) for kind in ("capture_page", "probe_media")},
        sleep=lambda _seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    # One RPC per pass, the array in task-kinds.json's order; the P4 upload (publish_media) comes last.
    assert store.claimed_kinds[0] == list(task_kinds())
    assert task_kinds()[:7] == (
        "probe_media", "generate", "transcribe_media", "transcribe_asset", "render_document", "render_stills",
        "capture_page",
    )
    assert task_kinds()[-1] == "publish_media"
    assert handled == ["probe-1", "capture-1"]
    assert len(store.claimed_kinds) == 3


def test_loop_dispatches_all_work_kinds():
    store = FakeStore()
    store.jobs.append(Job("job-1", "u1", "https://x", 1, attempt_id="a-job"))
    for kind in ("probe_media", "render_document", "capture_page"):
        store.tasks[kind].append(Task(f"{kind}-1", "u1", kind, attempt_id=f"a-{kind}"))
    handled = []
    handlers = {
        "job": lambda _store, item: handled.append("job"),
        **{
            kind: (lambda _store, item, kind=kind: handled.append(kind))
            for kind in ("probe_media", "render_document", "capture_page")
        },
    }

    run_forever(
        lambda: store,
        handlers,
        sleep=lambda _seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    assert handled == ["job", "probe_media", "render_document", "capture_page"]


def test_task_handler_error_is_reported_in_english():
    store = FakeStore()
    store.tasks["capture_page"].append(Task("t1", "u1", "capture_page", attempt_id="a1"))

    def boom(_store, _item):
        raise RuntimeError("nội bộ")

    run_forever(
        lambda: store,
        {"capture_page": boom},
        sleep=lambda _seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    assert store.failed_tasks == [("t1", "a1", TASK_FAILURE)]
    assert TASK_FAILURE.isascii()


def test_job_handler_error_is_finalized():
    store = FakeStore()
    store.jobs.append(Job("j1", "u1", "https://x", 1, attempt_id="a1"))

    def boom(_store, _item):
        raise RuntimeError("boom")

    run_forever(
        lambda: store,
        {"job": boom},
        sleep=lambda _seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    assert store.failed_jobs == [("j1", "a1", JOB_FAILURE)]


def test_reclaims_every_sixty_seconds():
    store = FakeStore()
    times = iter((0.0, 30.0, 61.0))
    sleeps = []

    run_forever(
        lambda: store,
        {},
        sleep=_stop_after(sleeps, 3),
        clock=lambda: next(times),
    )
    assert store.reclaims == ["tasks", "jobs", "tasks", "jobs"]


def test_transient_error_backs_off_without_failing_claimed_work():
    class FlakyStore(FakeStore):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def claim_next_job(self):
            self.calls += 1
            if self.calls <= 2:
                raise TransientError("temporary")

    store = FlakyStore()
    sleeps = []
    run_forever(lambda: store, {}, sleep=_stop_after(sleeps, 3), clock=lambda: 0.0)
    assert sleeps == [2.0, 4.0, 2]
    assert store.failed_jobs == [] and store.failed_tasks == []
