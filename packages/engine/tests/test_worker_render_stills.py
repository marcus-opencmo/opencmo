"""`render_stills`: ownership, destination, watermark and the output. Drawing is `clip-export`'s
(`look.test.ts`), so `_node` is replaced and writes real PNGs; ffmpeg's watermark runs for real."""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

from opencmo.backends.supabase import Task
from opencmo.worker import render_stills_task as stills
from opencmo.worker.task_run import TaskContext

ZIP = "u-1/c-1/t-1.zip"


class Store:
    def __init__(self, tmp: Path, *, owner: str = "u-1", watermark: bool = False) -> None:
        self.tmp, self.owner, self.watermark = tmp, owner, watermark
        self.uploads: dict[str, tuple[str, bytes]] = {}
        self.completed: dict | None = None

    def get_clip(self, _clip_id):
        return {"id": "c-1", "job_id": "j-1"}

    def get_job_row(self, _job_id):
        return {"id": "j-1", "user_id": self.owner, "watermark": self.watermark}

    def get_editor_revision(self, _revision_id):
        return {"clip_id": "c-1", "source_hash": "h", "document": {"version": 1}}

    def heartbeat_task(self, _task_id, _attempt_id):
        return True

    def replace_object(self, bucket, name, local, *, content_type=None):
        assert bucket == "exports"
        self.uploads[name] = (content_type, Path(local).read_bytes())
        return name

    def complete_task(self, _task_id, _attempt_id, output):
        self.completed = output
        return True


def _task(**payload) -> Task:
    return Task(
        id="t-1", user_id="u-1", kind="render_stills", clip_id="c-1", job_id="j-1", attempt_id="a-1",
        payload={"bucket": "exports", "object": ZIP, "still_prefix": "u-1/c-1/t-1", "editor_revision_id": "r-1", "source_hash": "h", **payload},
    )


def _png(path: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=360x640:d=1", "-frames:v", "1", str(path)], check=True)


@pytest.fixture
def node(monkeypatch: pytest.MonkeyPatch):
    def fake(command, file, *_rest, timeout):
        if command == "plan":
            return json.dumps({"sources": [], "width": 360, "height": 640})
        spec = json.loads(Path(file).read_text())
        out = Path(spec["out_dir"])
        out.mkdir()
        files = [out / f"slide-0{n}.png" for n in (1, 2)]
        for path in files:
            _png(path)
        return json.dumps({"files": [str(path) for path in files], "width": 360, "height": 640})

    monkeypatch.setattr(stills, "_node", fake)


def _run(store: Store, task: Task, root: Path) -> None:
    stills._run(TaskContext(store, task, root, SimpleNamespace(lost=Event())))


def test_uploads_each_still_and_the_zip_then_completes(tmp_path: Path, node) -> None:
    store = Store(tmp_path)
    _run(store, _task(), tmp_path)
    assert {name: kind for name, (kind, _) in store.uploads.items()} == {
        "u-1/c-1/t-1-01.png": "image/png", "u-1/c-1/t-1-02.png": "image/png", ZIP: "application/zip",
    }
    (tmp_path / "got.zip").write_bytes(store.uploads[ZIP][1])
    with zipfile.ZipFile(tmp_path / "got.zip") as bundle:
        assert bundle.namelist() == ["slide-01.png", "slide-02.png"]
    done = store.completed
    assert done is not None
    assert (done["count"], done["cover_index"], done["width"], done["height"]) == (2, 0, 360, 640)
    assert [item["object"] for item in done["stills"]] == ["u-1/c-1/t-1-01.png", "u-1/c-1/t-1-02.png"]
    assert done["zip"] == {"object": ZIP, "bytes": len(store.uploads[ZIP][1])}
    # Job deletion walks this list: every object written must be in it.
    assert {entry["object"] for entry in done["manifest"]["files"].values()} == set(store.uploads)


def test_watermark_changes_the_png_only_when_the_job_has_one(tmp_path: Path, node) -> None:
    plain = Store(tmp_path, watermark=False)
    (tmp_path / "a").mkdir()
    _run(plain, _task(), tmp_path / "a")
    marked = Store(tmp_path, watermark=True)
    (tmp_path / "b").mkdir()
    _run(marked, _task(), tmp_path / "b")
    name = "u-1/c-1/t-1-01.png"
    assert plain.uploads[name][1] != marked.uploads[name][1]
    # Still a PNG, not a sniffed container.
    assert marked.uploads[name][1][:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.parametrize("payload", [{"object": "u-2/c-1/t-1.zip"}, {"object": "u-1/c-1/t-1.mp4"}, {"bucket": "media"}])
def test_refuses_any_other_destination(tmp_path: Path, node, payload) -> None:
    with pytest.raises(ValueError, match="destination"):
        _run(Store(tmp_path), _task(**payload), tmp_path)


def test_refuses_another_users_job(tmp_path: Path, node) -> None:
    with pytest.raises(ValueError, match="ownership"):
        _run(Store(tmp_path, owner="u-2"), _task(), tmp_path)
