"""Khung chung của một task worker (R2).

Trước R2 mỗi handler tự chép cùng một khung: heartbeat, thư mục tạm, cờ
`completion_sent`, nhánh "lỗi tạm sau khi đã gửi kết quả", câu lỗi tiếng Anh và
dọn file đã tải lên khi hỏng. Chép sáu lần thì sớm muộn một bản lệch — và lệch ở
đây là hỏng im lặng: task `done` bị chốt `failed`, hay file của attempt thắng bị
xoá. Khung này giữ đúng một bản.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from typing import Any

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.worker.heartbeat import Heartbeat

log = logging.getLogger(__name__)


class TaskError(Exception):
    """Lỗi người dùng nên thấy: câu (tiếng Anh) đi thẳng vào `tasks.error`."""


@contextmanager
def task_workspace(store: Any, task: Task, name: str) -> Iterator[tuple[Heartbeat, Path]]:
    """Heartbeat của attempt + thư mục tạm, cho handler có kết cục riêng."""
    with (
        Heartbeat(lambda: store.heartbeat_task(task.id, task.attempt_id), f"{name}-{task.id}") as heartbeat,
        tempfile.TemporaryDirectory(prefix=f"opencmo-{name}-") as tmp,
    ):
        yield heartbeat, Path(tmp)


class TaskContext:
    def __init__(self, store: Any, task: Task, root: Path, heartbeat: Heartbeat) -> None:
        self.store = store
        self.task = task
        self.root = root
        self._heartbeat = heartbeat
        self.completion_sent = False
        self._uploads: list[tuple[str, str]] = []

    @property
    def lost_event(self) -> Event:
        """Bật khi attempt mất lease; truyền cho tiến trình con để dừng sớm."""
        return self._heartbeat.lost

    def lost(self) -> bool:
        return self._heartbeat.lost.is_set()

    def uploaded(self, bucket: str, object_name: str) -> None:
        """Đăng ký file vừa tải lên để dọn nếu task hỏng hoặc attempt thua."""
        self._uploads.append((bucket, object_name))

    def complete(self, call: Callable[[], Any]) -> Any:
        """Gọi RPC chốt kết quả. Từ đây lỗi tạm có thể là "đã chốt nhưng mất
        response", nên `run_task` phải hỏi lại database trước khi coi là hỏng.
        RPC trả False (attempt khác đã thắng) thì file của attempt này là rác."""
        self.completion_sent = True
        result = call()
        if result is False:
            self.cleanup()
        return result

    def cleanup(self) -> None:
        by_bucket: dict[str, list[str]] = {}
        for bucket, object_name in self._uploads:
            by_bucket.setdefault(bucket, []).append(object_name)
        self._uploads.clear()
        for bucket, paths in by_bucket.items():
            try:
                self.store.remove_objects(bucket, paths)
            except Exception:
                # Dọn là việc phụ: retention quét lại sau. Không để nó che lỗi chính.
                log.warning("Không dọn được file của task %s", self.task.id, exc_info=True)


def run_task(
    store: Any,
    task: Task,
    *,
    name: str,
    failed: str,
    body: Callable[[TaskContext], None],
    quiet: tuple[type[BaseException], ...] = (),
) -> None:
    """Chạy `body` trong khung chung và chốt mọi kết cục ở một chỗ.

    - `TaskError` → `fail_task` với đúng câu của nó.
    - Lỗi lạ → log + `fail_task(failed)` (câu chung, không lộ chi tiết nội bộ).
    - `quiet` (vd export đã bị huỷ) → không ghi gì thêm.
    - `TransientError` → để lease/reconciler chạy lại; riêng khi đã gửi kết quả
      thì hỏi lại database: task đã `done` đúng attempt này là xong, không raise.
    """
    ctx: TaskContext | None = None
    try:
        with task_workspace(store, task, name) as (heartbeat, root):
            ctx = TaskContext(store, task, root, heartbeat)
            body(ctx)
    except TransientError:
        if ctx is not None and ctx.completion_sent:
            canonical = store.get_task(task.id)
            if canonical is not None and canonical.status == "done" and canonical.attempt_id == task.attempt_id:
                return
            if canonical is None or canonical.attempt_id != task.attempt_id or canonical.status != "running":
                ctx.cleanup()
        raise
    except quiet:
        log.info("Task %s (%s) dừng không ghi kết quả", task.id, name)
    except TaskError as error:
        store.fail_task(task.id, task.attempt_id, str(error))
        if ctx is not None:
            ctx.cleanup()
    except Exception:
        log.exception("Task %s (%s) lỗi", task.id, name)
        store.fail_task(task.id, task.attempt_id, failed)
        if ctx is not None:
            ctx.cleanup()
