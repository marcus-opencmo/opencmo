"""E2-c: chuẩn bị "Edit full video" — remux nguyên upload, transcript cả video, công bố một lượt."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from opencmo.backends.supabase import Task
from opencmo.editing.models import ARTIFACT_VERSION
from opencmo.media.probe import probe_file
from opencmo.worker import prepare_full_task

USER = "11111111-1111-4111-8111-111111111111"


def _video(path: Path, seconds: int = 4) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=s=320x180:r=30:d={seconds}",
            "-f", "lavfi", "-i", f"sine=f=440:d={seconds}",
            "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path),
        ],
        check=True,
    )
    return path


class FakeStore:
    def __init__(self, source: Path, source_url: str = f"storage://{USER}/talk.mp4") -> None:
        self.source = source
        self.source_url = source_url
        self.uploads: dict[str, bytes] = {}
        self.completed: dict | None = None
        self.failed: list[tuple] = []

    def get_clip(self, _clip_id):
        return {"id": "clip-1", "job_id": "job-1", "kind": "full"}

    def get_job_row(self, _job_id):
        return {"id": "job-1", "user_id": USER, "source_url": self.source_url, "aspect": "9:16", "captions": True, "caption_preset": "bold"}

    def heartbeat_task(self, *_args):
        return True

    def download_object(self, _bucket, _path, dest, **_kwargs):
        dest.write_bytes(self.source.read_bytes())

    def upload_object(self, bucket, path, file, **_kwargs):
        self.uploads[f"{bucket}/{path}"] = Path(file).read_bytes()

    def list_artifacts(self, _job_id, kind):
        assert kind == "transcript"
        words = [{"start": 0.5, "end": 0.9, "text": "hello"}, {"start": 3.0, "end": 3.4, "text": "world"}]
        return [{"data": {"version": ARTIFACT_VERSION, "language": "en", "segments": [{"start": 0.5, "end": 3.4, "text": "hello world", "words": words}]}}]

    def complete_full_edit(self, task_id, attempt_id, **kwargs):
        self.completed = {"task": task_id, "attempt": attempt_id, **kwargs}
        return True

    def fail_task(self, *args):
        self.failed.append(args)
        return True


def _task() -> Task:
    return Task(id="task-1", user_id=USER, kind="prepare_full", clip_id="clip-1", job_id="job-1", attempt_id="att-1")


def test_remux_ca_video_va_cong_bo(tmp_path):
    store = FakeStore(_video(tmp_path / "talk.mp4"))
    prepare_full_task.process(store, _task())

    assert not store.failed
    done = store.completed
    assert done and done["master"]["offset"] == 0
    assert abs(done["master"]["duration"] - 4) < 0.1
    assert abs(done["settings"]["source_end"] - done["master"]["duration"]) < 1e-6
    assert len(done["settings_hash"]) == 64
    # Master là bản remux (không giải mã): cùng độ phân giải nguồn, có tiếng.
    master = tmp_path / "master.mp4"
    master.write_bytes(store.uploads[f"renders/{done['master']['object']}"])
    info = probe_file(str(master))
    assert (info.width, info.height) == (320, 180)
    # Transcript cả video, gốc 0 = giây 0 của file.
    transcript = json.loads(store.uploads[f"renders/{done['master']['transcript']}"])
    starts = [word["start"] for line in transcript for word in line["words"]]
    assert starts == [0.5, 3.0]


def test_job_link_bi_tu_choi_khong_tai(tmp_path):
    store = FakeStore(tmp_path / "missing.mp4", source_url="https://youtu.be/abc")
    prepare_full_task.process(store, _task())
    assert store.failed == [("task-1", "att-1", "Full-video editing works on videos you uploaded.")]
    assert not store.uploads
