"""Nhịp tim tổng quát cho worker: gia hạn lease của `jobs` và `tasks`.

Một lớp cho mọi loại việc: nó nhận một hàm `beat` và bên gọi tự quyết định
beat() gọi RPC nào (`heartbeat_job` hay `heartbeat_task`), nên thêm task kind
mới không phải viết thêm heartbeat.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Self

log = logging.getLogger(__name__)

# Worker heartbeat mỗi 30 giây; lease ở database là LEASE_SECONDS = 120 (xem
# `opencmo.backends.supabase`), tức còn dư ba nhịp trước khi reconciler nhặt lại.
HEARTBEAT_SECONDS = 30


class Heartbeat:
    """Gọi `beat()` định kỳ trên một luồng nền; bật cờ `lost` khi `beat()` trả False.

    Không dừng được pipeline/handler giữa chừng khi mất lease — chỉ bật cờ để
    bên gọi tự kiểm ở các mốc an toàn (trước khi tải/ghi tốn kém) rồi dừng sớm.
    Kết quả cuối cùng của một attempt đã mất quyền vẫn bị database từ chối ở
    `complete_task`/`complete_job`, cờ này chỉ để đỡ tốn công vô ích.

    Exception từ `beat()` KHÔNG được làm chết luồng: một lần gọi RPC lỗi tạm
    không có nghĩa attempt đã mất — cứ ghi log rồi thử lại ở nhịp sau.
    """

    def __init__(
        self,
        beat: Callable[[], bool],
        name: str,
        interval: float = HEARTBEAT_SECONDS,
    ) -> None:
        self.lost = threading.Event()
        self._beat = beat
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name=f"heartbeat-{name}"
        )

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                if not self._beat():
                    log.warning("%s: mất lease, dừng heartbeat", self._thread.name)
                    self.lost.set()
                    return
            except Exception:
                log.warning(
                    "%s: heartbeat lỗi — thử lại nhịp sau", self._thread.name, exc_info=True
                )
