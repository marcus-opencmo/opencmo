"""Nguồn media của worker web: cache section và proxy cho editor."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import re
import shutil
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from opencmo.backends.retry import PermanentError, TransientError
from opencmo.backends.supabase import SOURCES_BUCKET, Job, Task
from opencmo.config import Config
from opencmo.media.ffmpeg import run
from opencmo.media.probe import probe_file
from opencmo.models import Moment
from opencmo.steps import download

log = logging.getLogger(__name__)

UPLOAD_UNAVAILABLE = "This upload is not available. Upload the video again."
UNSAFE_SOURCE = (
    "This link points to a private or local network. "
    "Use a public HTTP or HTTPS video URL."
)


class UploadUnavailableError(ValueError):
    pass


class UnsafeSourceError(ValueError):
    pass


@dataclass(frozen=True)
class SourceSegment:
    """File nguồn dùng để cắt, và mốc thời gian NGUỒN ứng với giây 0 của file."""

    path: Path
    offset: float = 0.0


@dataclass(frozen=True)
class ResolvedWebSource(SourceSegment):
    """SourceSegment kèm entry để attempt thắng công bố vào DB manifest."""

    manifest: dict[str, Any] | None = None
    uploaded: bool = False


def _safe_name(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def upload_object_name(job: Job) -> str:
    """Trả storage key canonical ``user_id/filename`` của nguồn upload."""
    raw = job.source_url.removeprefix("storage://")
    decoded = unquote(raw)
    parts = decoded.split("/")
    safe_file = re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,240}", parts[-1] if parts else "")
    if (
        decoded != raw
        or "\\" in raw
        or len(parts) != 2
        or parts[0] != job.user_id
        or not safe_file
        or parts[1] in {".", ".."}
    ):
        raise UploadUnavailableError(UPLOAD_UNAVAILABLE)
    return raw


def validate_public_url(value: str) -> None:
    """Chỉ nhận URL HTTP(S) có DNS trỏ hoàn toàn tới địa chỉ public."""
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        if (
            parsed.scheme not in {"http", "https"}
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or hostname.lower() == "localhost"
            or hostname.lower().endswith(".localhost")
        ):
            raise UnsafeSourceError(UNSAFE_SOURCE)
        addresses = socket.getaddrinfo(hostname, parsed.port, type=socket.SOCK_STREAM)
        if not addresses or any(
            not ipaddress.ip_address(item[4][0]).is_global for item in addresses
        ):
            raise UnsafeSourceError(UNSAFE_SOURCE)
    except (OSError, ValueError) as exc:
        raise UnsafeSourceError(UNSAFE_SOURCE) from exc


def _local_manifest_path(workdir: Path) -> Path:
    return workdir / ".section-manifest.json"


def _read_local_sections(workdir: Path) -> list[dict[str, Any]]:
    path = _local_manifest_path(workdir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _write_local_sections(workdir: Path, sections: list[dict[str, Any]]) -> None:
    _local_manifest_path(workdir).write_text(json.dumps(sections, sort_keys=True))


def _published_sections(store: Any, job: Job) -> list[dict[str, Any]]:
    row = store.get_job_row(job.id) or {}
    manifest = row.get("media_manifest") or {}
    sections = list(manifest.get("sections") or [])
    return [section for section in sections if isinstance(section, dict)]


def _covers(section: dict[str, Any], start: float, end: float) -> bool:
    try:
        return float(section["start"]) <= start and end <= float(section["end"])
    except (KeyError, TypeError, ValueError):
        return False


def _download_cached_section(
    store: Any, section: dict[str, Any], workdir: Path
) -> ResolvedWebSource:
    bucket = str(section.get("bucket") or SOURCES_BUCKET)
    object_name = str(section["object"])
    target = workdir / f"cached-{_safe_name(bucket + '/' + object_name)}.mp4"
    if not target.is_file():
        store.download_object(bucket, object_name, target)
    return ResolvedWebSource(target, float(section["offset"]), section, False)


def _section_object(job: Job, start: float, end: float, task: Task | None) -> str:
    start_ms = round(start * 1000)
    end_ms = round(end * 1000)
    if task is not None:
        return (
            f"{job.user_id}/{job.id}/sections/task-{task.id}/{task.attempt_id}/"
            f"{start_ms}-{end_ms}.mp4"
        )
    return (
        f"{job.user_id}/{job.id}/sections/{job.attempt_id}/"
        f"{start_ms}-{end_ms}.mp4"
    )


def resolve_web_source(
    store: Any,
    job: Job,
    start: float,
    end: float,
    workdir: Path,
    cfg: Config,
    *,
    task: Task | None = None,
) -> ResolvedWebSource:
    """Lấy file phủ khoảng nguồn mà không tải nguyên video link.

    Cache đã công bố được đọc từ manifest DB. Cache mới trong cùng attempt có
    thêm một manifest cục bộ để các clip kế tiếp tái sử dụng trước khi job được
    công bố nguyên tử; file JSON này không bao giờ được upload lên Storage.
    """
    if end <= start:
        raise ValueError("Source range must have a positive duration.")
    workdir.mkdir(parents=True, exist_ok=True)

    # Section đã công bố là source master của clip. Luôn thử nó TRƯỚC nguồn
    # upload: đảo thứ tự này lại sẽ khiến mỗi lần đổi frame tải cả video dài từ
    # Storage, dù pipeline đã cắt và giữ đúng đoạn cần render.
    local_sections = _read_local_sections(workdir)
    for section in [*local_sections, *_published_sections(store, job)]:
        if not _covers(section, start, end):
            continue
        local_path = section.get("local_path")
        if local_path and Path(local_path).is_file():
            return ResolvedWebSource(Path(local_path), float(section["offset"]), section, True)
        return _download_cached_section(store, section, workdir)

    if job.source_url.startswith("storage://"):
        object_name = upload_object_name(job)
        # Mỗi task có workdir riêng nên basename không đụng nhau; giữ tên gốc
        # để SourceInfo/title của upload không biến thành chuỗi hash nội bộ.
        target = workdir / Path(object_name).name
        if not target.is_file():
            try:
                store.download_object(SOURCES_BUCKET, object_name, target)
            except TransientError:
                target.unlink(missing_ok=True)
                raise
            except (PermanentError, OSError) as exc:
                target.unlink(missing_ok=True)
                raise UploadUnavailableError(UPLOAD_UNAVAILABLE) from exc
        return ResolvedWebSource(target, 0.0)

    validate_public_url(job.source_url)

    with tempfile.TemporaryDirectory(dir=workdir, prefix="section-") as tmp:
        downloaded, lead_in = download._download_one_section(
            job.source_url,
            0,
            Moment(start=start, end=end, hook=""),
            cfg,
            Path(tmp),
        )
        offset = max(0.0, start - lead_in)
        info = probe_file(str(downloaded), local_only=True)
        covered_end = offset + info.duration
        object_name = _section_object(job, offset, covered_end, task)
        target = workdir / f"section-{round(offset * 1000)}-{round(covered_end * 1000)}.mp4"
        shutil.move(str(downloaded), target)

    store.upload_object(SOURCES_BUCKET, object_name, target, content_type="video/mp4")
    section = {
        "bucket": SOURCES_BUCKET,
        "object": object_name,
        "bytes": target.stat().st_size,
        "start": offset,
        "end": covered_end,
        "offset": offset,
        "duration": info.duration,
        "attempt_id": task.attempt_id if task is not None else job.attempt_id,
        "local_path": str(target),
    }
    local_sections.append(section)
    _write_local_sections(workdir, local_sections)
    published = {key: value for key, value in section.items() if key != "local_path"}
    return ResolvedWebSource(target, offset, published, True)


def make_editor_proxy(
    section: SourceSegment | Path,
    out: Path,
    *,
    start: float = 0.0,
    duration: float | None = None,
) -> Path:
    """Tạo proxy H.264 540p với GOP ngắn để editor tua nhanh."""
    source = section.path if isinstance(section, SourceSegment) else section
    out.parent.mkdir(parents=True, exist_ok=True)
    window = ["-ss", f"{start:.3f}"] if start > 0 else []
    limit = ["-t", f"{duration:.3f}"] if duration is not None else []
    run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            *window, "-i", str(source), *limit,
            "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale=-2:540",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-g", "30", "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "96k",
            str(out),
        ],
        timeout=600,
    )
    return out


def keyframe_at_or_before(source: Path, when: float, *, lookback: float = 20.0) -> float:
    """Mốc keyframe gần nhất KHÔNG SAU `when`, đọc từ packet của stream video.

    `-c copy` chỉ cắt được ở keyframe. Biết TRƯỚC mốc đó, thay vì để ffmpeg tự
    lùi, là khác biệt giữa "biết chính xác giây 0 của file ra nằm ở đâu trên
    video gốc" và "lệch tối đa một GOP mà không ai biết". Lệch đó đi thẳng vào
    `masters.offset`, rồi vào `sourceIn` và mốc phụ đề — hỏng im lặng.

    Đọc PACKET chứ không phải frame: `-skip_frame nokey` bắt ffprobe decode,
    còn packet thì chỉ phải phân tích container.
    """
    if when <= 0:
        return 0.0
    begin = max(0.0, when - lookback)
    try:
        proc = run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "packet=pts_time,flags",
                "-read_intervals", f"{begin:.3f}%{when + 0.5:.3f}",
                "-of", "csv=p=0",
                str(source),
            ],
            timeout=60,
        )
    except Exception:
        # Không đọc được thì cắt từ đầu file: thêm vài giây vào master, nhưng
        # `offset` vẫn là một con số ĐÚNG. Đoán một mốc gần đúng thì không.
        log.warning("Không đọc được keyframe của %s — cắt master từ đầu section", source,
                    exc_info=True)
        return 0.0

    best = 0.0
    for line in proc.stdout.splitlines():
        raw_time, _, flags = line.partition(",")
        if "K" not in flags:
            continue
        try:
            stamp = float(raw_time)
        except ValueError:
            continue
        if stamp <= when + 1e-3:
            best = max(best, stamp)
    return best


def make_editor_master(
    section: SourceSegment | Path,
    out: Path,
    *,
    start: float = 0.0,
    duration: float | None = None,
) -> float:
    """Cắt master cho editor bằng MỘT lượt `-c copy`. Trả về giây 0 của `out`
    trên thang thời gian của `section`.

    `-c copy` là cố ý: master giữ nguyên độ phân giải nguồn mà không thêm một
    lượt encode nào vào ngân sách 3 phút — đây là I/O, không phải CPU.

    Mép cắt bám keyframe nên file ra bắt đầu SỚM hơn `start` tối đa một GOP.
    Phần thừa đó không bị vứt: `sourceIn` trong TSX bù lại, và giá trị trả về là
    thứ duy nhất cho biết bù bao nhiêu.
    """
    source = section.path if isinstance(section, SourceSegment) else section
    out.parent.mkdir(parents=True, exist_ok=True)
    begin = keyframe_at_or_before(source, start)
    window = ["-ss", f"{begin:.3f}"] if begin > 0 else []
    # Tính từ mép thật, không từ `start`: thiếu phần bù này là cụt đuôi clip
    # đúng bằng khoảng lùi về keyframe, và cụt đuôi thì không ai thấy cho tới
    # lúc xem lại clip đã xuất.
    limit = (
        ["-t", f"{(start - begin) + duration:.3f}"] if duration is not None else []
    )
    run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            *window, "-i", str(source), *limit,
            "-map", "0:v:0", "-map", "0:a?",
            "-c", "copy", "-movflags", "+faststart",
            str(out),
        ],
        timeout=600,
    )
    return begin
