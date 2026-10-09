"""Cấu hình engine. Đọc từ biến môi trường, có mặc định hợp lý."""

from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit


def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass
class Config:
    # --- API ---
    groq_api_key: str = field(default_factory=lambda: os.getenv("GROQ_API_KEY", ""))
    # Bước chọn khoảnh khắc chạy được với Gemini HOẶC Anthropic. Có key nào thì
    # dùng key đó; nếu có cả hai, Gemini được ưu tiên (rẻ hơn, quota free rộng).
    gemini_api_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", ""))
    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    # The one default LLM provider (same choice as CMO_LLM_PROVIDER on the web app). Empty keeps
    # the old rule: Gemini when its key exists, else Anthropic.
    llm_provider: str = field(
        default_factory=lambda: os.getenv("OPENCMO_LLM_PROVIDER", "").strip().lower()
    )

    # Bỏ trống -> tự chọn theo provider: Gemini 2.5 Flash hoặc Claude Haiku 4.5.
    # Transcript 45 phút ~12k token vào, chi phí chọn khoảnh khắc ~$0.01–0.02/video
    # (Gemini Flash rẻ hơn, và có bậc miễn phí).
    select_model: str = field(
        default_factory=lambda: os.getenv("OPENCMO_SELECT_MODEL", "")
    )
    whisper_model: str = "whisper-large-v3-turbo"

    # --- Đầu ra ---
    out_dir: Path = field(default_factory=lambda: Path("./clips"))
    work_dir: Path | None = None  # None -> tempdir tự xóa

    # Tỉ lệ khung đầu ra. `clip_width`/`clip_height` suy ra từ đây ở
    # `__post_init__`, nên người gọi chỉ cần đặt MỘT trong hai — đặt kích thước
    # tường minh vẫn thắng, để CLI và test cũ không đổi hành vi.
    aspect: str = "9:16"

    # "auto" KHÔNG phải một layout của revision settings: nó là câu hỏi
    # "cắt hay đệm?" mà chỉ trả lời được sau khi bám mặt chạy xong. Dò được mặt
    # → fill (cắt quanh người nói). Không dò được → fit (thu nhỏ + viền đen).
    # Đây là câu trả lời cho nguồn screencast: crop 9:16 một màn hình code cắt
    # vào đúng vùng trống. Xem note.md mục "Còn lại" #2.
    layout: str = "auto"

    captions: bool = True
    # Burn hook do LLM viết thành tiêu đề ở đầu clip. Bật mặc định: clip không
    # có dòng mở đầu phải cuộn mất hai giây người xem mới biết nó nói về gì.
    #
    # Cờ này phải đi ĐÔI với `default_settings(headline=...)` ở
    # `editing/models.py`: revision đầu tiên của clip mô tả đúng file vừa giao,
    # nên tắt một bên là mở editor ra thấy khác clip đã tải về.
    headline: bool = True

    clip_width: int = 0
    clip_height: int = 0
    clip_min_seconds: float = 10.0
    clip_max_seconds: float = 60.0

    # Watermark: chữ burn vào clip của bản free. None = không có.
    # Đây là đòn bẩy bán hàng chứ không phải hạn chế kỹ thuật (VISION.md §4):
    # người dùng thấy cái giá mỗi lần xem lại clip của chính mình.
    watermark: str | None = field(default_factory=lambda: os.getenv("OPENCMO_WATERMARK") or None)

    # Preview độ phân giải thấp. Xem ARCHITECTURE.md §7 — cắt egress 5–10 lần.
    make_preview: bool = True
    preview_height: int = 640
    preview_bitrate: str = "500k"

    # --- Hiệu năng ---
    # Mặc định nửa số core. Xem ngân sách RAM ở ARCHITECTURE.md §2:
    # mỗi tiến trình ffmpeg ~400MB, nên đây cũng là cái chốt giữ RAM trong 2GB.
    max_parallel: int = field(
        default_factory=lambda: _env_int("OPENCMO_MAX_PARALLEL", 2)
    )
    encoder: str | None = field(default_factory=lambda: os.getenv("OPENCMO_ENCODER") or None)

    # --- Mạng ---
    proxy: str | None = field(default_factory=lambda: os.getenv("OPENCMO_PROXY") or None)
    cookies_file: str | None = field(default_factory=lambda: os.getenv("OPENCMO_COOKIES") or None)

    # --- Bám mặt ---
    # Chỉ detect 4 frame/giây rồi nội suy. Xem ARCHITECTURE.md §4.
    face_sample_fps: float = 4.0
    face_tracking: bool = True

    def __post_init__(self) -> None:
        self.max_parallel = max(1, min(2, self.max_parallel))

        # Import ở đây chứ không ở đầu file: `media.frame` không import gì của
        # `config`, nhưng đặt ở đầu file thì một lần đổi thứ tự import sau này
        # là một vòng import — và lỗi đó chỉ hiện ra lúc chạy.
        from .media.frame import ASPECT_SIZES

        if self.aspect not in ASPECT_SIZES:
            raise ValueError(f"Unsupported aspect ratio: {self.aspect}")
        if self.layout not in ("auto", "fill", "fit"):
            raise ValueError(f"Unsupported frame layout: {self.layout}")
        width, height = ASPECT_SIZES[self.aspect]
        if not self.clip_width:
            self.clip_width = width
        if not self.clip_height:
            self.clip_height = height
        # Một session cho TOÀN pipeline, không đổi IP giữa probe và tải đoạn.
        self.proxy = fresh_proxy_session(self.proxy)

    def validate_for_transcribe(self) -> None:
        if not self.groq_api_key:
            raise RuntimeError(
                "Missing GROQ_API_KEY — required to transcribe videos without subtitles."
            )

    def validate_for_select(self) -> None:
        if self.llm_provider == "gemini" and not self.gemini_api_key:
            raise RuntimeError("OPENCMO_LLM_PROVIDER is gemini but GEMINI_API_KEY is missing.")
        if self.llm_provider == "anthropic" and not self.anthropic_api_key:
            raise RuntimeError("OPENCMO_LLM_PROVIDER is anthropic but ANTHROPIC_API_KEY is missing.")
        if not self.gemini_api_key and not self.anthropic_api_key:
            raise RuntimeError(
                "Missing GEMINI_API_KEY or ANTHROPIC_API_KEY — "
                "moment selection needs one of them."
            )

    @property
    def select_provider(self) -> str:
        """Provider for moment selection: 'gemini' or 'anthropic'.

        OPENCMO_LLM_PROVIDER wins so the whole product runs on one LLM; without it, the key
        that exists decides.
        """
        if self.llm_provider in ("gemini", "anthropic"):
            return self.llm_provider
        return "gemini" if self.gemini_api_key else "anthropic"

    @property
    def resolved_select_model(self) -> str:
        if self.select_model:
            return self.select_model
        return "gemini-3.6-flash" if self.select_provider == "gemini" else "claude-haiku-4-5"


def fresh_proxy_session(proxy: str | None) -> str | None:
    """Cùng proxy IPRoyal với session (tức IP) mới; proxy khác giữ nguyên."""
    if proxy and (urlsplit(proxy).hostname or "").endswith(".iproyal.com"):
        return re.sub(r"_session-[^_@]+", f"_session-{uuid.uuid4().hex[:12]}", proxy)
    return proxy
