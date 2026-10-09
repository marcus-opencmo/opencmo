"""Đọc metadata của file media bằng ffprobe."""

from __future__ import annotations

import json
from dataclasses import dataclass

from .ffmpeg import USER_INPUT, run


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool

    @property
    def is_vertical(self) -> bool:
        return self.height > self.width


def _parse_fps(raw: str) -> float:
    """ffprobe trả fps dạng phân số, ví dụ '30000/1001'."""
    if "/" in raw:
        num, _, den = raw.partition("/")
        try:
            d = float(den)
            return float(num) / d if d else 0.0
        except ValueError:
            return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def probe_file(path: str, *, local_only: bool = False) -> MediaInfo:
    """`local_only`: file do NGƯỜI DÙNG đưa lên — chỉ cho giao thức `file`, để một file thật ra là
    playlist HLS không khiến ffprobe đi lấy URL tuỳ ý (SSRF). Pipeline vẫn probe được URL stream."""
    proc = run(
        [
            "ffprobe", "-v", "error", *(USER_INPUT if local_only else []),
            "-print_format", "json",
            "-show_format", "-show_streams",
            path,
        ],
        timeout=60,
    )
    data = json.loads(proc.stdout)
    streams = data.get("streams", [])

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError(f"No video stream found in {path}")

    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0.0)

    return MediaInfo(
        duration=duration,
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        fps=_parse_fps(str(video.get("r_frame_rate", "0/1"))),
        has_audio=has_audio,
    )
