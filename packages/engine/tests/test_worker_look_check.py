"""`look_check`: ownership of the paths, the code questions on real tiny MP4s, the judge seam and the note."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from opencmo.backends.supabase import Task
from opencmo.worker import look_check_task as look
from opencmo.worker.task_run import TaskContext

USER = "11111111-1111-4111-8111-111111111111"
CLIP = "22222222-2222-4222-8222-222222222222"
TASK = "33333333-3333-4333-8333-333333333333"
REF = "44444444-4444-4444-8444-444444444444"
PATH = f"{USER}/{CLIP}/{TASK}.mp4"

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def _mp4(path: Path, video: str, audio: str | None = "sine=frequency=440:duration=6") -> Path:
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", video]
    if audio:
        args += ["-f", "lavfi", "-i", audio]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "6"]
    args += ["-c:a", "aac", "-shortest"] if audio else []
    subprocess.run([*args, str(path)], check=True)
    return path


# Moving picture, not black, not frozen: a test pattern that scrolls.
MOVING = "testsrc2=size=320x568:rate=25:duration=6"


@pytest.fixture(autouse=True)
def _no_providers(monkeypatch):
    monkeypatch.setattr(look.moderation, "ready", lambda: False)
    monkeypatch.setenv(look.look_judge.FAKE_ENV, "pass")


def _answers(result):
    return {a["id"]: a for a in result["answers"]}


def _check(path: Path, tmp: Path, **kw):
    return look.check_file(path, tmp / "frames", {"path": PATH, "clip_id": CLIP}, look.MAX_FRAMES, slideshow=kw.get("slideshow", False))


def test_clean_export_passes(tmp_path):
    result = _check(_mp4(tmp_path / "ok.mp4", MOVING), tmp_path)
    assert result["pass"] is True, result
    assert [a["id"] for a in result["answers"]] == [q for q, _ in look.QUESTIONS]
    assert _answers(result)["content_allowed"]["pass"] is None, "no checker on this machine: not checked"
    assert 1 <= len(result["frameTimes"]) <= look.MAX_FRAMES
    assert all(0 < t < 6 for t in result["frameTimes"]), "never the very first or last frame"
    assert look.note([result]) == ""


def test_black_stretch_fails_with_its_time(tmp_path):
    video = "testsrc2=size=320x568:rate=25:duration=6,drawbox=enable='between(t,2,3.5)':color=black:t=fill"
    result = _check(_mp4(tmp_path / "black.mp4", video), tmp_path)
    black = _answers(result)["no_black_frames"]
    assert result["pass"] is False and black["pass"] is False
    assert 1.8 <= black["at"] <= 2.2
    assert look.note([result]).startswith("Look check: A black stretch of 1.")


def test_frozen_picture_fails_but_not_in_a_slideshow(tmp_path):
    still = _mp4(tmp_path / "still.mp4", "color=c=blue:size=320x568:rate=25:duration=6")
    assert _answers(_check(still, tmp_path))["no_frozen_frames"]["pass"] is False
    assert _answers(_check(still, tmp_path, slideshow=True))["no_frozen_frames"]["pass"] is None, "slides hold on purpose"


def test_no_sound_and_silence_fail(tmp_path):
    mute = _check(_mp4(tmp_path / "mute.mp4", MOVING, audio=None), tmp_path)
    assert _answers(mute)["sound_present"] == {"id": "sound_present", "pass": False, "why": "The video has no sound"}
    silent = _check(_mp4(tmp_path / "silent.mp4", MOVING, audio="anullsrc=r=48000:cl=stereo"), tmp_path)
    assert _answers(silent)["sound_present"]["pass"] is False


def test_a_silent_slideshow_passes(tmp_path):
    # Slides with no music picked have no audio track on purpose; the note would be noise on every such card.
    mute = _check(_mp4(tmp_path / "mute.mp4", MOVING, audio=None), tmp_path, slideshow=True)
    assert _answers(mute)["sound_present"]["pass"] is None
    assert mute["pass"] is True


def test_judge_failure_names_the_frame_time(tmp_path, monkeypatch):
    monkeypatch.setenv(look.look_judge.FAKE_ENV, "fail")
    result = _check(_mp4(tmp_path / "ok.mp4", MOVING), tmp_path)
    captions = _answers(result)["captions_inside"]
    assert result["pass"] is False and captions["pass"] is False
    assert captions["at"] == result["frameTimes"][0]


def test_unanswered_judge_never_fails(tmp_path, monkeypatch):
    monkeypatch.delenv(look.look_judge.FAKE_ENV)
    monkeypatch.setattr(look.look_judge, "_ask", lambda frames: None)
    result = _check(_mp4(tmp_path / "ok.mp4", MOVING), tmp_path)
    assert result["pass"] is True
    assert _answers(result)["text_readable"]["pass"] is None


def test_blocked_frame_is_not_sent_to_the_judge(tmp_path, monkeypatch):
    monkeypatch.setattr(look.moderation, "ready", lambda: True)

    def blocked(_images):
        raise look.ProviderError("blocked")

    monkeypatch.setattr(look.moderation, "check_images", blocked)
    monkeypatch.setattr(look.look_judge, "judge", lambda *_: pytest.fail("judge called on a blocked frame"))
    result = _check(_mp4(tmp_path / "ok.mp4", MOVING), tmp_path)
    assert _answers(result)["content_allowed"]["pass"] is False and result["pass"] is False


def _task(**payload) -> Task:
    base = {"ref_kind": "editor_project", "ref_id": REF, "round": 0, "files": [{"path": PATH, "clip_id": CLIP}]}
    return Task(id=TASK, user_id=USER, kind="look_check", attempt_id="a-1", payload={**base, **payload})


@pytest.mark.parametrize(
    "payload",
    [
        {"files": [{"path": f"{USER}/{CLIP}/{TASK}.preview.mp4", "clip_id": CLIP}]},
        {"files": [{"path": f"99999999-9999-4999-8999-999999999999/{CLIP}/{TASK}.mp4", "clip_id": CLIP}]},
        {"files": [{"path": f"{USER}/{REF}/{TASK}.mp4", "clip_id": CLIP}]},
        {"files": [{"path": f"{USER}/{CLIP}/../{TASK}.mp4", "clip_id": CLIP}]},
        {"round": 2},
        {"ref_kind": "job"},
        {"files": []},
    ],
)
def test_refuses_anything_but_the_owners_full_size_export(payload):
    with pytest.raises(ValueError):
        look._input(_task(**payload))


class Store:
    def __init__(self, source: Path) -> None:
        self.source, self.completed, self.downloads = source, None, []

    def download_object(self, bucket, path, dest, *, max_bytes=None):
        assert bucket == "exports"
        self.downloads.append(path)
        shutil.copy(self.source, dest)
        return dest

    def heartbeat_task(self, *_):
        return True

    def complete_task(self, _task_id, _attempt_id, output):
        self.completed = output
        return True


def test_task_writes_one_result_per_file(tmp_path):
    store = Store(_mp4(tmp_path / "src.mp4", MOVING))
    task = _task(round=1)
    ctx = TaskContext(store, task, tmp_path, SimpleNamespace(lost=Event()))
    look._run(ctx)
    out = store.completed
    assert store.downloads == [PATH]
    assert out["pass"] is True and out["round"] == 1 and out["note"] == ""
    assert [f["clipId"] for f in out["files"]] == [CLIP]
