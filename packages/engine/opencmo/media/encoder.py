"""Dò encoder H.264 khả dụng bằng cách TEST-ENCODE THẬT.

Vì sao không đọc `ffmpeg -encoders`:
    Danh sách đó cho biết encoder nào được BIÊN DỊCH VÀO ffmpeg, không cho biết
    phần cứng nào đang có. Một build ffmpeg thông thường liệt kê `h264_nvenc`
    ngay cả trên máy chỉ có iGPU Intel — gọi vào sẽ lỗi lúc chạy.

Cách duy nhất đáng tin là encode thử một frame và xem nó có chạy không.
Xem ARCHITECTURE.md §4.
"""

from __future__ import annotations

import logging
import os
import platform
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg import try_run

log = logging.getLogger(__name__)

_VAAPI_DEVICE = os.getenv("OPENCMO_VAAPI_DEVICE", "/dev/dri/renderD128")


@dataclass(frozen=True)
class Encoder:
    """Một encoder đã được xác nhận chạy được trên máy này."""

    name: str
    hardware: bool
    # Tham số đặt TRƯỚC -i (ví dụ khởi tạo thiết bị VAAPI).
    input_args: list[str] = field(default_factory=list)
    # Nối vào cuối chuỗi -vf (ví dụ hwupload cho VAAPI).
    filter_suffix: str = ""
    quality_args: list[str] = field(default_factory=list)

    def __str__(self) -> str:
        return f"{self.name} ({'phần cứng' if self.hardware else 'phần mềm'})"


# Ứng viên theo thứ tự ưu tiên. Encoder phần cứng trước — không hẳn vì nhanh hơn
# (với clip ngắn thì encode chưa bao giờ là nút thắt), mà vì chúng dùng ít điện,
# chạy mát, và không chiếm hết CPU đang cần cho các job song song khác.
_CANDIDATES: list[Encoder] = [
    Encoder("h264_nvenc", True, quality_args=["-preset", "p4", "-cq", "23"]),
    Encoder("h264_qsv", True, quality_args=["-global_quality", "23"]),
    Encoder(
        "h264_vaapi",
        True,
        input_args=["-vaapi_device", _VAAPI_DEVICE],
        filter_suffix="format=nv12,hwupload",
        quality_args=["-qp", "23"],
    ),
    Encoder("h264_videotoolbox", True, quality_args=["-q:v", "55"]),
    Encoder("libx264", False, quality_args=["-preset", "veryfast", "-crf", "23"]),
]

_SOFTWARE_FALLBACK = _CANDIDATES[-1]

_cache: Encoder | None = None


def _platform_order() -> list[Encoder]:
    """Sắp lại ứng viên theo hệ điều hành để bớt lượt thử vô ích."""
    system = platform.system()
    if system == "Darwin":
        preferred = ("h264_videotoolbox",)
    elif system == "Linux":
        preferred = ("h264_nvenc", "h264_qsv", "h264_vaapi")
    else:  # Windows
        preferred = ("h264_nvenc", "h264_qsv", "h264_amf")

    ordered = [c for n in preferred for c in _CANDIDATES if c.name == n]
    ordered += [c for c in _CANDIDATES if c not in ordered]
    return ordered


def _test_encode(enc: Encoder, workdir: Path) -> bool:
    """Encode đúng 1 frame. Chạy được thì encoder này dùng được thật."""
    if enc.name == "h264_vaapi" and not Path(_VAAPI_DEVICE).exists():
        return False

    out = workdir / f"probe_{enc.name}.mp4"
    vf = enc.filter_suffix or "null"

    args = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        *enc.input_args,
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1:duration=1",
        "-vf", vf,
        "-c:v", enc.name,
        *enc.quality_args,
        "-frames:v", "1",
        str(out),
    ]
    ok = try_run(args, timeout=30)
    out.unlink(missing_ok=True)
    return ok


def detect(force: str | None = None) -> Encoder:
    """Trả về encoder dùng được, có cache.

    `force` là tên encoder do người dùng chỉ định (biến OPENCMO_ENCODER).
    Vẫn được kiểm chứng — chỉ định sai thì rơi về libx264 kèm cảnh báo.
    """
    global _cache
    if _cache is not None and force is None:
        return _cache

    with tempfile.TemporaryDirectory(prefix="opencmo-enc-") as tmp:
        workdir = Path(tmp)

        if force:
            match = next((c for c in _CANDIDATES if c.name == force), None)
            if match is None:
                match = Encoder(force, hardware=False)
            if _test_encode(match, workdir):
                log.info("Dùng encoder do người dùng chỉ định: %s", match)
                _cache = match
                return match
            log.warning("Encoder '%s' được chỉ định nhưng không chạy được. Rơi về dò tự động.", force)

        for candidate in _platform_order():
            if _test_encode(candidate, workdir):
                log.info("Đã chọn encoder: %s", candidate)
                _cache = candidate
                return candidate

    log.warning("Không encoder nào qua được test. Dùng libx264 không kiểm chứng.")
    _cache = _SOFTWARE_FALLBACK
    return _SOFTWARE_FALLBACK


def reset_cache() -> None:
    """Dùng trong test."""
    global _cache
    _cache = None
