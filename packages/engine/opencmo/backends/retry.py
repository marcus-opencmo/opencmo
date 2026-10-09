"""Retry có phân loại cho các lời gọi Supabase của worker.

Hai luật, sinh ra từ lỗi 504 ngày 13/09:

1. Chỉ retry thao tác IDEMPOTENT. Timeout không có nghĩa request chưa chạy —
   server có thể đã commit rồi mới mất response. Thao tác không idempotent
   (`claim_next_job_attempt`) gặp lỗi tạm thì ném `TransientError` ngay, việc
   phục hồi thuộc về lease ở database.
2. Lỗi vĩnh viễn (401/403/404/409/422…) không bao giờ retry: gọi lại chỉ trễ
   thêm rồi vẫn hỏng, và che mất nguyên nhân thật.

Message của hai exception là tiếng Anh và KHÔNG chứa host: chúng có thể bị ghi
vào `jobs.error`, cột mà trang kết quả đọc (xem `apps/web/lib/jobError.ts`).
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable

import httpx

log = logging.getLogger(__name__)

TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})

# Ba lần thử lại sau lần đầu. Tổng chờ cỡ 7–9 giây: đủ vượt một nhịp nghẽn của
# gateway, chưa đủ lâu để lease 120 giây của job hết hạn trong lúc chờ.
DELAYS = (1.0, 2.0, 4.0)
DEADLINE_SECONDS = 30.0


class TransientError(RuntimeError):
    """Database tạm không trả lời được; thử lại sau có thể thành công."""


class PermanentError(RuntimeError):
    """Request bị từ chối vì lý do sẽ không tự hết.

    `body` giữ JSON gốc (nếu parse được) của response bị từ chối — message của
    exception này cố tình chung chung để không lộ host Supabase khi lọt vào
    `jobs.error`, nhưng một số RPC (`put_artifact`, `create_clip_drafts`) ném
    lỗi nghiệp vụ có `code`/`message` riêng (vd P0001 "attempt đã hết hạn") mà
    bên gọi cần đọc lại để dịch sang exception cụ thể (`StaleAttemptError`).
    """

    def __init__(self, message: str, status: int | None = None, body: object = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _safe_json(resp: httpx.Response) -> object:
    try:
        return resp.json()
    except ValueError:
        return None


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("retry-after")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        # Dạng HTTP-date hiếm gặp ở gateway này; rơi về backoff thường.
        return None


def call(
    send: Callable[[], httpx.Response],
    *,
    idempotent: bool,
    what: str,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    rng: Callable[[], float] = random.random,
    delays: tuple[float, ...] = DELAYS,
    deadline: float = DEADLINE_SECONDS,
) -> httpx.Response:
    start = clock()
    reason = ""

    for attempt in range(len(delays) + 1):
        hint = None
        try:
            resp = send()
        except httpx.TransportError as exc:
            reason = type(exc).__name__
        else:
            if resp.status_code < 400:
                return resp
            if resp.status_code not in TRANSIENT_STATUS:
                raise PermanentError(
                    f"Database request was rejected (HTTP {resp.status_code}) during {what}.",
                    resp.status_code,
                    body=_safe_json(resp),
                )
            reason = f"HTTP {resp.status_code}"
            hint = _retry_after(resp)

        if not idempotent:
            raise TransientError(f"Database was unavailable during {what} ({reason}).")
        if attempt == len(delays):
            break

        # Jitter để nhiều worker cùng gặp một nhịp nghẽn không dội lại cùng lúc.
        delay = delays[attempt] * (1 + 0.25 * rng())
        if hint is not None:
            delay = max(delay, hint)
        if clock() - start + delay > deadline:
            break

        log.warning("%s lỗi tạm (%s) — thử lại sau %.1fs", what, reason, delay)
        sleep(delay)

    log.error("%s hết lượt thử lại (%s)", what, reason)
    raise TransientError(f"Database kept failing during {what} ({reason}).")
