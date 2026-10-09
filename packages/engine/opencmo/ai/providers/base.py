"""Giao diện chung của provider sinh media (spec AI Studio §7.3).

Provider thật (P6–P8) gần như đều bất đồng bộ: gửi yêu cầu, nhận một mã, hỏi
lại cho tới khi xong, rồi tải file kết quả về. Bốn bước đó là bốn method ở đây;
`run()` nối chúng lại cho task worker. Adapter đồng bộ (FakeProvider) chỉ việc
xong ngay ở `submit`.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from opencmo.ai.catalog import AiModel, price_of


class ProviderError(RuntimeError):
    """Provider từ chối hoặc hỏng. `str(exc)` là câu tiếng Anh cho người dùng.

    `retryable` = lỗi tạm (quá tải, mạng) — worker trả task về hàng thay vì chốt
    hỏng. Lỗi nội dung/an toàn KHÔNG bao giờ retryable: gọi lại là trả tiền lại
    cho cùng một lời từ chối.
    """

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class Poll:
    status: Literal["running", "done", "failed"]
    error: str | None = None


@dataclass(frozen=True)
class Result:
    path: Path
    content_type: str
    extension: str
    #: Giọng đọc: mốc từng chữ `[{text, start, end}]` tính từ đầu file — thứ để
    #: dựng phụ đề cho voiceover. None = provider không cho (Gemini).
    words: list[dict[str, Any]] | None = None


class ProviderAdapter(ABC):
    #: Khoảng hỏi lại provider; provider video chậm có thể đặt dài hơn.
    poll_seconds: float = 2.0
    #: Trần chờ một lượt sinh. Quá thì hỏng + hoàn credit.
    timeout_seconds: float = 600.0

    @abstractmethod
    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        """Gửi yêu cầu, trả mã tham chiếu của provider."""

    @abstractmethod
    def poll(self, ref: str) -> Poll:
        """Trạng thái hiện tại của `ref`."""

    @abstractmethod
    def fetch(self, ref: str, dest_dir: Path) -> Result:
        """Tải kết quả về `dest_dir` THEO STREAM — không giữ cả file trong RAM."""

    def cost(self, model: AiModel, spec: dict[str, Any], result: Result) -> int:
        """Credit thật của lượt này. Mặc định là giá đặt trước; SQL không bao giờ
        chốt cao hơn phần đã đặt trước."""
        return price_of(model, spec)

    def run(
        self,
        model: AiModel,
        spec: dict[str, Any],
        workdir: Path,
        *,
        alive: Callable[[], bool] = lambda: True,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> Result | None:
        """submit → poll → fetch. Trả None khi task đã bị huỷ giữa chừng."""
        ref = self.submit(model, spec, workdir)
        started = clock()
        while True:
            if not alive():
                return None
            state = self.poll(ref)
            if state.status == "done":
                break
            if state.status == "failed":
                raise ProviderError(state.error or "Generation failed. Your credits were refunded.")
            if clock() - started > self.timeout_seconds:
                raise ProviderError("The generation took too long. Your credits were refunded.")
            sleep(self.poll_seconds)
        return self.fetch(ref, workdir)
