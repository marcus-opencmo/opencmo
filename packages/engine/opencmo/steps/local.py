"""Nguồn video là file có sẵn trên đĩa, không phải URL.

Module này cố ý phơi ra ĐÚNG bốn tên hàm và chữ ký như `download.py`, để
`pipeline.py` chỉ cần chọn module chứ không phải rẽ nhánh ở bốn chỗ. Thứ tự các
bước trong pipeline là tối ưu lớn nhất của dự án (`ARCHITECTURE.md` §3) — chỗ ít
đáng khuấy động nhất, nên cái giá phải trả là một cái tên hơi sai:
`download_sections()` ở đây KHÔNG tải gì cả. Xem docstring của nó.

Vì sao cần: yt-dlp không nhận đường dẫn local (`'...' is not a valid URL`), còn
`file://` thì bị nó tắt mặc định vì lý do bảo mật. Và vì YouTube chặn IP
datacenter, đây hiện là đường DUY NHẤT chạy được engine từ đầu tới cuối — Groq và
Gemini không bị chặn, chỉ yt-dlp bị. Nó cũng chính là đường ra mắt "upload file
trước, YouTube sau" ở `PLAN.md`.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..config import Config
from ..media.ffmpeg import extract_audio
from ..media.probe import probe_file
from ..models import Moment, SourceInfo, Transcript

log = logging.getLogger(__name__)


def is_local_source(raw: str) -> bool:
    """Nhận diện nguồn local.

    Điều kiện là "có file thật trên đĩa", KHÔNG phải "thiếu scheme http": một
    link YouTube dán thiếu `https://` cũng thiếu scheme, mà nó rõ ràng không phải
    file local.
    """
    if raw.startswith("file://"):
        return True
    try:
        return Path(raw).expanduser().is_file()
    except OSError:
        return False


def resolve_path(raw: str) -> Path:
    return Path(raw.removeprefix("file://")).expanduser()


def probe(url: str, cfg: Config) -> SourceInfo:
    """Metadata bằng ffprobe, không đụng mạng."""
    path = resolve_path(url)
    if not path.is_file():
        raise RuntimeError(f"Local file not found: {url}")

    info = probe_file(str(path))
    if info.duration <= 0:
        raise RuntimeError(f"Could not read a duration from {path.name}.")

    return SourceInfo(
        url=str(path),
        title=path.stem,
        duration=info.duration,
        uploader="",
        has_subtitles=False,
        extractor="local",
    )


def fetch_subtitles(
    url: str, cfg: Config, workdir: Path, lang: str = "en"
) -> Transcript | None:
    """File local không kèm phụ đề — luôn đi Whisper.

    Trả None thay vì ném, để `pipeline.py` đi tiếp đúng nhánh có sẵn.
    """
    return None


def download_audio(url: str, cfg: Config, workdir: Path) -> Path:
    """Trích audio bằng ffmpeg thay vì tải bằng yt-dlp.

    Cùng một lệnh với nhánh manual của `pipeline.py` (transcribe đúng đoạn đã
    tải), nên nó nằm ở `media/ffmpeg.py` chứ không lặp lại ở đây: đường yt-dlp
    128k stereo vốn đã sát trần 25MB của Groq, và hai bản sao của cùng một lệnh
    là hai chỗ để lệch nhau.
    """
    return extract_audio(resolve_path(url), workdir / "audio.m4a")


def download_sections(
    url: str, moments: list[Moment], cfg: Config, workdir: Path
) -> list[tuple[Path, float]]:
    """KHÔNG tải và cũng không cắt gì — trả về chính file gốc cho mọi khoảnh khắc.

    Giữ tên `download_sections` để `pipeline.py` dùng chung một chỗ gọi với
    `download.py`.

    `render_clip` vốn đã chạy `-ss {lead_in} -i {section} -t {duration}` với `-ss`
    đặt TRƯỚC `-i`. Nên file gốc chính là "section" của mọi clip, và `lead_in`
    chính là `moment.start`. Cắt sẵn ra file riêng sẽ tốn thêm một lượt decode
    cho mỗi clip mà không được gì — bước download vì thế còn gần như 0 giây.

    Nhiều tiến trình ffmpeg cùng đọc một file là bình thường: mỗi tiến trình một
    file descriptor riêng, chỉ đọc, và page cache dùng chung nên không cộng vào
    RAM đỉnh.
    """
    path = resolve_path(url)
    info = probe_file(str(path))
    # Kẹp lại phòng LLM trả mốc vượt quá độ dài thật — `-ss` quá đuôi file cho ra
    # clip rỗng, đúng loại lỗi im lặng mà CLAUDE.md cảnh báo.
    last = max(0.0, info.duration - 0.5)
    log.info("Nguồn local — bỏ qua bước tải, cắt thẳng %d đoạn khi render", len(moments))
    return [(path, min(max(0.0, m.start), last)) for m in moments]
