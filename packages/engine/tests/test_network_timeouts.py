"""Mọi gọi mạng của pipeline phải có trần thời gian.

Local không có `timeout=1800` của Modal: một request treo làm job nằm
`running` mãi, vì heartbeat ở thread riêng vẫn gia hạn lease.
"""

import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

from opencmo.config import Config
from opencmo.steps import download, select, transcribe


def test_ytdlp_opts_have_socket_timeout():
    assert download._base_opts(Config())["socket_timeout"] > 0


def test_anthropic_client_has_timeout(monkeypatch):
    seen = {}

    class Anthropic:
        def __init__(self, **kwargs):
            seen.update(kwargs)
            raise RuntimeError("stop")

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=Anthropic))
    with pytest.raises(RuntimeError, match="stop"):
        select._select_with_anthropic("x", Config(anthropic_api_key="k"))
    assert seen["timeout"] == select._LLM_TIMEOUT_S
    assert seen["max_retries"] <= 2


def test_transcribe_rejects_oversized_audio_before_upload(tmp_path, monkeypatch):
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"")
    with audio.open("r+b") as fh:
        fh.truncate(transcribe.TRANSCRIBE_MAX_BYTES + 1)

    def no_upload(*_a, **_k):
        raise AssertionError("không được upload file quá cỡ")

    monkeypatch.setattr(transcribe.httpx, "post", no_upload)
    with pytest.raises(RuntimeError, match="^Audio is too large to transcribe"):
        transcribe.transcribe_audio(audio, Config(elevenlabs_api_key="k"))


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="cần ffmpeg",
)
def test_download_audio_downmixes_oversized_stream(tmp_path, monkeypatch):
    """Luồng gốc quá trần upload phải ra mono 16kHz bitrate thấp; lọt trần thì giữ nguyên."""
    monkeypatch.setattr(download, "TRANSCRIBE_MAX_BYTES", 100_000)

    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def download(self, _urls):
            assert "postprocessors" not in self.opts
            target = Path(self.opts["outtmpl"].replace("%(ext)s", "m4a"))
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                 "sine=frequency=440:sample_rate=44100:duration=20", "-ac", "2",
                 "-c:a", "aac", "-b:a", "128k", str(target)],
                check=True,
            )

    import yt_dlp

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    out = download.download_audio("https://example.com/v", Config(), tmp_path)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=channels,sample_rate", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert probe == "16000,1"
    assert not list(tmp_path.glob("audio_src.*"))
    # 20 giây ở 32k ≈ 80KB; 128k stereo là ~320KB.
    assert out.stat().st_size < 150_000


def test_download_audio_keeps_small_m4a(tmp_path, monkeypatch):
    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def download(self, _urls):
            Path(self.opts["outtmpl"].replace("%(ext)s", "m4a")).write_bytes(b"x" * 1000)

    import yt_dlp

    def no_transcode(*_a, **_k):
        raise AssertionError("file nhỏ không được mã hoá lại")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    monkeypatch.setattr(download, "extract_audio", no_transcode)
    out = download.download_audio("https://example.com/v", Config(), tmp_path)
    assert out.stat().st_size == 1000


def _fake_ytdlp(monkeypatch, failures):
    """YoutubeDL giả: ném lần lượt các lỗi trong `failures`, rồi ghi file đoạn."""
    import yt_dlp

    seen_proxies = []

    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def download(self, _urls):
            seen_proxies.append(self.opts.get("proxy"))
            if failures:
                raise yt_dlp.utils.DownloadError(failures.pop(0))
            Path(self.opts["outtmpl"].replace("%(ext)s", "mp4")).write_bytes(b"x")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)
    monkeypatch.setattr(
        download, "probe_file", lambda _p: types.SimpleNamespace(width=1920, height=1080)
    )
    return seen_proxies


def test_tai_doan_thu_lai_voi_session_proxy_moi(monkeypatch, tmp_path):
    # Proxy sticky rơi IP giữa chừng → 403 → ffmpeg exit 1 (UAT production 29/09).
    from opencmo.models import Moment

    proxies = _fake_ytdlp(monkeypatch, ["ERROR: ffmpeg exited with code 1"])
    cfg = Config(proxy="http://u:p_country-us_session-aaaa_lifetime-10m@geo.iproyal.com:12321")
    out, _lead = download._download_one_section(
        "https://youtu.be/x", 0, Moment(start=10, end=20, hook="h"), cfg, tmp_path
    )
    assert out.exists()
    assert len(proxies) == 2
    assert proxies[0] != proxies[1]


def test_tai_doan_khong_thu_lai_loi_vinh_vien(monkeypatch, tmp_path):
    import yt_dlp

    from opencmo.models import Moment

    proxies = _fake_ytdlp(monkeypatch, ["ERROR: [youtube] x: Private video"])
    with pytest.raises(yt_dlp.utils.DownloadError):
        download._download_one_section(
            "https://youtu.be/x", 0, Moment(start=10, end=20, hook="h"), Config(), tmp_path
        )
    assert len(proxies) == 1

