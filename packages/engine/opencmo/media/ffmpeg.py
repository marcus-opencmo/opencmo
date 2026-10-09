"""Chạy ffmpeg/ffprobe dưới dạng subprocess.

Nguyên tắc: engine KHÔNG BAO GIỜ giữ frame video trong bộ nhớ.
Mọi biến đổi đi qua ffmpeg, thứ dùng RAM cố định bất kể video dài bao nhiêu.
Xem ARCHITECTURE.md §2, luật 1 và 2.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


class FFmpegError(RuntimeError):
    pass


def require_binaries() -> None:
    # Tiếng Anh vì `run_pipeline` gọi hàm này BÊN TRONG job: lỗi ở đây bị worker
    # bắt và ghi vào `jobs.error`, rồi trang kết quả in thẳng ra cho người dùng.
    # Xem quy tắc ngôn ngữ ở đầu CLAUDE.md.
    missing = [b for b in ("ffmpeg", "ffprobe") if shutil.which(b) is None]
    if missing:
        raise FFmpegError(
            f"{', '.join(missing)} not found in PATH. "
            "Install with: apt install ffmpeg / brew install ffmpeg"
        )


#: Demuxer được đọc file media của NGƯỜI DÙNG (upload, ảnh/video đầu vào). ffmpeg đoán định dạng
#: theo nội dung: không giới hạn thì một file là playlist HLS / concat khiến worker đọc file khác trên
#: máy hay đi lấy URL tuỳ ý (SSRF, đọc file cục bộ). Không có hls, concat, image2 (chuỗi file theo mẫu).
USER_MEDIA_FORMATS = (
    "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,aac,ogg,flac,avi,mpegts,gif,png_pipe,jpeg_pipe,webp_pipe"
)
#: Tham số đặt TRƯỚC `-i` của một file người dùng đã tải về máy.
USER_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", USER_MEDIA_FORMATS]


def run(
    args: list[str], *, timeout: int = 1800, stdin_path: Path | None = None
) -> subprocess.CompletedProcess[str]:
    """Chạy một lệnh và raise kèm stderr khi lỗi.

    ffmpeg viết mọi thứ ra stderr kể cả khi thành công, nên chỉ đọc nó lúc thất bại.

    Thông báo lỗi bằng tiếng Anh: đây là đường lỗi hay gặp nhất của một job thật,
    và nó chạy thẳng ra `jobs.error` rồi lên màn hình người dùng.
    """
    log.debug("run: %s", " ".join(args))
    if stdin_path is not None:
        # stdin là file: ffmpeg đọc `pipe:0`, không mở được file hay URL nào khác.
        with stdin_path.open("rb") as stdin:
            proc = subprocess.run(args, stdin=stdin, capture_output=True, text=True, timeout=timeout, check=False)
    else:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise FFmpegError(f"Command failed (code {proc.returncode}): {' '.join(args[:6])}…\n{tail}")
    return proc


def try_run(args: list[str], *, timeout: int = 60) -> bool:
    """Chạy thử, trả về True/False thay vì raise. Dùng cho việc dò khả năng."""
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
        return proc.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def extract_audio(source: Path, target: Path, *, start: float = 0.0, duration: float | None = None) -> Path:
    """Trích audio từ một file có sẵn, sẵn sàng cho Whisper.

    Mono 16kHz vì Whisper vốn resample về đúng mức đó bên trong — hạ xuống không
    mất độ chính xác. 32k thay vì 48k: Groq chặn ở 25MB, 48k chỉ chứa được ~70
    phút, 32k chứa được ~100 phút (~14MB cho 54 phút).

    `-ss` đặt TRƯỚC `-i` (input seeking). Đặt sau thì ffmpeg decode từ đầu file
    tới điểm cắt — xem ARCHITECTURE.md §4.
    """
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", str(source)]
    if duration is not None:
        args += ["-t", f"{duration:.3f}"]
    args += ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", str(target)]
    run(args)
    if not target.exists():
        # Tiếng Anh: lỗi này chạy thẳng vào `jobs.error` rồi lên màn hình.
        raise FFmpegError("Audio extraction failed: no output file.")
    return target
