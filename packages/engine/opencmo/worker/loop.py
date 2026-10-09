"""Vòng lặp worker dùng chung cho máy dev và lớp bọc Modal."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping
from typing import Protocol

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Job, SupabaseStore, Task
from opencmo.worker.kinds import task_kinds

log = logging.getLogger(__name__)

TASK_FAILURE = "Rendering failed. Please try again."
JOB_FAILURE = "Processing failed. Please try again."


class Handler(Protocol):
    def __call__(self, store: SupabaseStore, item: Job | Task) -> None: ...


def _claim_work(store: SupabaseStore) -> Job | Task | None:
    job = store.claim_next_job()
    if job is not None:
        return job
    # Một lượt cho mọi kind: `claim_next_task` sắp theo vị trí trong mảng, nên
    # thứ tự ưu tiên của `task-kinds.json` vẫn giữ (migration R2).
    return store.claim_next_task(list(task_kinds()))


def _dispatch(
    store: SupabaseStore,
    handlers: Mapping[str, Handler],
    item: Job | Task,
) -> None:
    key = "job" if isinstance(item, Job) else item.kind
    handler = handlers.get(key)
    if handler is None:
        if isinstance(item, Task):
            store.fail_task(item.id, item.attempt_id, f"Unsupported task kind: {item.kind}.")
            return
        store.fail(item.id, item.attempt_id, JOB_FAILURE)
        return

    try:
        handler(store, item)
    except (KeyboardInterrupt, TransientError):
        # Lỗi tạm không được chốt failed: lease/reconciler sẽ trả việc về hàng.
        raise
    except Exception:
        log.exception("Worker xử lý %s %s bị lỗi", key, item.id)
        if isinstance(item, Task):
            store.fail_task(item.id, item.attempt_id, TASK_FAILURE)
        else:
            store.fail(item.id, item.attempt_id, JOB_FAILURE)


def run_forever(
    store_factory: Callable[[], SupabaseStore],
    handlers: Mapping[str, Handler],
    poll_seconds: float = 2,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Nhận và xử lý tuần tự một job/task mỗi lượt.

    Hai tiến trình dev có thể chạy song song; `SKIP LOCKED` trong database bảo
    đảm chúng không nhận cùng một việc. Lỗi kết nối dùng backoff 2→30 giây và
    để lease phục hồi việc đã claim nhưng mất response.
    """

    store = store_factory()
    last_reclaim = float("-inf")
    backoff = 2.0
    try:
        while True:
            try:
                now = clock()
                if now - last_reclaim >= 60:
                    store.reclaim_expired_tasks()
                    store.reclaim_expired()
                    last_reclaim = now

                item = _claim_work(store)
                if item is None:
                    sleep(poll_seconds)
                else:
                    _dispatch(store, handlers, item)
                backoff = 2.0
            except TransientError as exc:
                log.warning("Supabase tạm không sẵn sàng: %s; thử lại sau %.0fs", exc, backoff)
                sleep(backoff)
                backoff = min(backoff * 2, 30.0)
    except KeyboardInterrupt:
        log.info("Đã dừng worker theo yêu cầu.")
    finally:
        close = getattr(store, "close", None)
        if close is not None:
            close()
