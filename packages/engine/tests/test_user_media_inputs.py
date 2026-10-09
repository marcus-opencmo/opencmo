"""File media của người dùng: ffmpeg chỉ được dùng demuxer media thường (không HLS/concat).

Một upload là playlist HLS có thể khiến ffprobe/ffmpeg trên worker đọc file khác trên máy hay
đi lấy URL tuỳ ý. Đặt tên `.m3u8` để ffmpeg chắc chắn nhận ra HLS nếu không bị chặn.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from opencmo.media.ffmpeg import FFmpegError
from opencmo.media.probe import probe_file


def _mp4(path: Path) -> Path:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:d=1", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


def test_upload_mp4_van_doc_duoc(tmp_path):
    info = probe_file(str(_mp4(tmp_path / "clip.mp4")), local_only=True)
    assert (info.width, info.height) == (160, 120)


def test_upload_la_playlist_hls_bi_tu_choi(tmp_path):
    target = _mp4(tmp_path / "secret.mp4")
    playlist = tmp_path / "upload.m3u8"
    playlist.write_text(f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile://{target}\n#EXT-X-ENDLIST\n")
    # Không chặn: ffprobe đọc theo playlist ra đúng kích thước file kia.
    assert probe_file(str(playlist)).width == 160
    with pytest.raises((FFmpegError, ValueError)):
        probe_file(str(playlist), local_only=True)
