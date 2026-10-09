"""E4-e: phụ đề cho file thư viện — chỉ rút audio đoạn đã chọn, mốc theo giây của file."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from opencmo.backends.supabase import Task
from opencmo.models import Transcript, TranscriptSegment, Word
from opencmo.worker import transcribe_media_task

USER = "11111111-1111-4111-8111-111111111111"


def _media(path: Path, *, audio: bool = True, seconds: int = 6) -> Path:
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s=160x90:r=10:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=f=440:d={seconds}", "-c:a", "aac", "-shortest"]
    subprocess.run([*args, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


class FakeStore:
    def __init__(self, source: Path, *, row: dict | None = None) -> None:
        self.source = source
        self.row = row if row is not None else {
            "id": "asset-1", "user_id": USER, "job_id": "job-1", "status": "ready", "storage_path": "media/u/broll.mp4",
        }
        self.downloads: list[str] = []
        self.completed: tuple | None = None
        self.failed: list[tuple] = []

    def get_media_asset(self, _asset_id):
        return self.row

    def heartbeat_task(self, *_args):
        return True

    def download_object(self, bucket, path, dest, **_kwargs):
        self.downloads.append(f"{bucket}/{path}")
        dest.write_bytes(self.source.read_bytes())

    def complete_media_captions(self, task_id, attempt_id, body):
        self.completed = (task_id, attempt_id, body)
        return "a" * 64

    def fail_task(self, *args):
        self.failed.append(args)
        return True


def _task(start: float = 2.0, end: float = 5.0) -> Task:
    return Task(
        id="task-1", user_id=USER, kind="transcribe_media", clip_id="clip-1", job_id="job-1", asset_id="asset-1",
        attempt_id="att-1", payload={"source_in": start, "source_out": end, "credits": 1},
    )


def _fake_whisper(seen: list[float]):
    def transcribe(audio: Path, _cfg) -> Transcript:
        seconds = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio)],
            check=True, capture_output=True, text=True,
        ).stdout
        seen.append(float(seconds))
        return Transcript(segments=[TranscriptSegment(0.1, 0.9, "hi there", [Word(0.1, 0.4, "hi"), Word(0.5, 0.9, "there")])])

    return transcribe


def test_chi_cat_doan_da_chon_va_doi_moc_ve_giay_cua_file(tmp_path, monkeypatch):
    seen: list[float] = []
    monkeypatch.setattr(transcribe_media_task, "transcribe_audio", _fake_whisper(seen))
    store = FakeStore(_media(tmp_path / "broll.mp4"))
    transcribe_media_task.process(store, _task(2.0, 5.0))

    assert not store.failed
    assert store.downloads == ["media/u/broll.mp4"]
    # Audio gửi Whisper chỉ dài đúng đoạn 2…5 s, không phải cả file 6 s.
    assert abs(seen[0] - 3.0) < 0.15
    body = json.loads(store.completed[2])
    assert [word["text"] for word in body[0]["words"]] == ["hi", "there"]
    assert [word["start"] for word in body[0]["words"]] == [2.1, 2.5]


def test_file_khong_co_tieng_bao_loi_tieng_anh(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe_media_task, "transcribe_audio", _fake_whisper([]))
    store = FakeStore(_media(tmp_path / "mute.mp4", audio=False))
    transcribe_media_task.process(store, _task())
    assert store.completed is None
    assert store.failed[0][2] == transcribe_media_task.NO_AUDIO


def test_khong_co_loi_noi_va_file_khong_con(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe_media_task, "transcribe_audio", lambda *_: Transcript(segments=[]))
    store = FakeStore(_media(tmp_path / "broll.mp4"))
    transcribe_media_task.process(store, _task())
    assert store.failed[0][2] == transcribe_media_task.NO_SPEECH

    other = FakeStore(tmp_path / "broll.mp4", row={"id": "asset-1", "user_id": "someone-else", "job_id": "job-1", "status": "ready", "storage_path": "media/x.mp4"})
    transcribe_media_task.process(other, _task())
    assert other.downloads == []
    assert other.failed[0][2] == transcribe_media_task.GONE
