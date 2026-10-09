from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from opencmo.backends.supabase import Task
from opencmo.worker import render_document_task as rd

DOCUMENT = {"version": 1, "stage": {"children": []}}
REVISION_HASH = "d" * 64
EDITED_HASH = "a" * 64
GENERATED_KEY = json.dumps(
    {"type": "image", "model": "gemini-image", "spec": {"prompt": "a red fox", "aspectRatio": "16:9"}}
)
MANIFEST = {
    "version": 1,
    "folders": [],
    "assets": [
        {
            "id": "b1",
            "path": "broll.mp4",
            "source": "assets/broll.mp4",
            "type": "video",
            "mimeType": "video/mp4",
            "cloud": {"state": "synced", "mediaId": "m-broll"},
        },
        {
            "id": "g1",
            "path": "generated/fox.png",
            "source": "assets/generated/fox.png",
            "type": "image",
            "mimeType": "image/png",
            "generation": {"key": GENERATED_KEY, "id": "gen1"},
            "cloud": {"state": "synced", "mediaId": "m-fox"},
        },
        {
            "id": "local",
            "path": "only-here.mp4",
            "source": "assets/only-here.mp4",
            "type": "video",
            "mimeType": "video/mp4",
            "cloud": {"state": "uploading"},
        },
    ],
}


class FakeStore:
    def __init__(
        self, *, watermark: bool = True, files: dict | None = None, document: dict | None = None
    ) -> None:
        self.watermark = watermark
        self.document = document or DOCUMENT
        self.files = files or {}
        self.downloads: list[tuple[str, str]] = []
        self.replaced: tuple[str, str, bytes] | None = None
        self.completed: dict | None = None
        self.failed: str | None = None

    def get_clip(self, _clip_id):
        return {"id": "c1", "job_id": "j1"}

    def get_job_row(self, _job_id):
        return {
            "id": "j1",
            "user_id": "u1",
            "watermark": self.watermark,
            "media_manifest": {
                "masters": {
                    "c1": {"bucket": "renders", "object": "u1/c1/master.mp4", "transcript": "u1/c1/master.json"}
                }
            },
        }

    def get_editor_revision(self, revision_id):
        assert revision_id == "r1"
        return {
            "id": "r1",
            "clip_id": "c1",
            "source_hash": REVISION_HASH,
            "document": self.document,
        }

    def get_editor_transcript(self, clip_id, digest):
        assert clip_id == "c1"
        return '[{"text":"hi","words":[{"text":"hi","start":0,"end":0.5}]}]' if digest == EDITED_HASH else None

    def get_media_asset(self, media_id):
        return {
            "m-broll": {"user_id": "u1", "job_id": "j1", "status": "ready", "storage_path": "media/u1/j1/broll.mp4"},
            "m-fox": {"user_id": "u1", "job_id": "j1", "status": "ready", "storage_path": "media/u1/j1/fox.png"},
        }.get(media_id)

    def heartbeat_task(self, *_args):
        return True

    def task_progress(self, _task, _attempt, value):
        self.progress = [*getattr(self, "progress", []), value]
        return True

    def download_object(self, bucket, path, dest, **_kwargs):
        self.downloads.append((bucket, path))
        local = self.files.get((bucket, path))
        if local:
            shutil.copyfile(local, dest)
        else:
            dest.write_bytes(b"bytes")

    def replace_object(self, bucket, path, source, **_kwargs):
        self.replaced = (bucket, path, Path(source).read_bytes())
        return path

    def complete_task(self, _task, _attempt, output):
        self.completed = output
        return True

    def fail_task(self, _task, _attempt, error):
        self.failed = error
        return True


def _task(resolution: int = 1080) -> Task:
    return Task(
        id="t1",
        user_id="u1",
        kind="render_document",
        clip_id="c1",
        job_id="j1",
        payload={
            "bucket": "exports",
            "object": "u1/c1/t1.mp4",
            "editor_revision_id": "r1",
            "source_hash": REVISION_HASH,
            "resolution": resolution,
            "manifest": MANIFEST,
        },
        attempt_id="a1",
    )


def _fake_node(monkeypatch, sources: list[dict], jobs: list[dict], planned: list[str] | None = None):
    def fake(*args, timeout):
        if args[0] == "plan":
            if planned is not None:
                planned.append(Path(args[1]).read_text())
            return json.dumps({"sources": sources, "width": 1080, "height": 1920})
        job = json.loads(Path(args[1]).read_text())
        jobs.append(job)
        Path(job["out"]).write_bytes(b"mp4")
        return "{}"

    def fake_run(job_file, *, timeout, on_render, stop=None):
        job = json.loads(Path(job_file).read_text())
        jobs.append(job)
        for part in (0.25, 0.5, 1.0):
            on_render(part)
        Path(job["out"]).write_bytes(b"mp4")
        return "{}"

    monkeypatch.setattr(rd, "_node", fake)
    monkeypatch.setattr(rd, "_node_run", fake_run)
    monkeypatch.setattr(
        rd, "probe_file", lambda _path: SimpleNamespace(width=1080, height=1920, duration=12.0, has_audio=True)
    )


def test_resolves_every_kind_of_source_and_uploads_canonical_object(monkeypatch):
    jobs: list[dict] = []
    fox = {"generate": "image", "prompt": "a red fox"}
    _fake_node(
        monkeypatch,
        [
            {"kind": "video", "src": "assets/master.mp4"},
            {"kind": "transcript", "src": "assets/transcript.json"},
            {"kind": "transcript", "src": f"assets/transcripts/{EDITED_HASH}.json"},
            {"kind": "video", "src": "assets/broll.mp4"},
            {"kind": "image", "src": fox},
        ],
        jobs,
    )
    store = FakeStore(watermark=True)
    rd.process(store, _task(720))

    assert store.failed is None
    assert store.downloads == [
        ("renders", "u1/c1/master.mp4"),
        ("renders", "u1/c1/master.json"),
        ("media", "u1/j1/broll.mp4"),
        ("media", "u1/j1/fox.png"),
    ]
    job = jobs[0]
    assert job["resolution"] == 720
    assert job["document"] == DOCUMENT
    assert [entry["src"] for entry in job["media"]] == ["assets/master.mp4", "assets/broll.mp4", fox]
    edited = Path(job["transcripts"][1]["file"])
    assert job["transcripts"][1]["src"].endswith(f"{EDITED_HASH}.json")
    assert not edited.exists()  # thư mục tạm đã dọn sau khi xong
    assert rd.WATERMARK in job["videoFilter"]
    assert store.replaced is not None and store.replaced[:2] == ("exports", "u1/c1/t1.mp4")
    assert store.completed["manifest"]["files"]["mp4"] == {"bucket": "exports", "object": "u1/c1/t1.mp4", "bytes": 3}
    assert store.completed["manifest"]["editor_revision_id"] == "r1"


def test_exports_the_revision_document(monkeypatch):
    jobs: list[dict] = []
    planned: list[str] = []
    document = {"version": 1, "stage": {"children": [{"kind": "scene", "width": 10, "height": 10}]}}
    _fake_node(monkeypatch, [{"kind": "video", "src": "assets/master.mp4"}], jobs, planned)
    store = FakeStore(document=document)
    rd.process(store, _task())
    assert store.failed is None
    assert json.loads(planned[0]) == document
    assert jobs[0]["document"] == document
    assert "source" not in jobs[0]


def test_library_src_is_the_asset_path_not_its_storage_source(monkeypatch):
    # Fork chèn B-roll với `src` = đường dẫn thư viện; đổi tên chỉ đổi `path`.
    jobs: list[dict] = []
    _fake_node(monkeypatch, [{"kind": "video", "src": "broll.mp4"}, {"kind": "video", "src": "cuts/renamed.mp4"}], jobs)
    manifest = json.loads(json.dumps(MANIFEST))
    manifest["assets"].append(
        {
            "id": "b2",
            "path": "cuts/renamed.mp4",
            "source": "assets/original.mp4",
            "type": "video",
            "mimeType": "video/mp4",
            "cloud": {"state": "synced", "mediaId": "m-broll"},
        }
    )
    task = _task()
    task.payload["manifest"] = manifest
    store = FakeStore()
    rd.process(store, task)
    assert store.failed is None, store.failed
    assert store.downloads.count(("media", "u1/j1/broll.mp4")) == 2


def test_paid_plan_has_no_watermark(monkeypatch):
    jobs: list[dict] = []
    _fake_node(monkeypatch, [{"kind": "video", "src": "assets/master.mp4"}], jobs)
    store = FakeStore(watermark=False)
    rd.process(store, _task())
    assert "videoFilter" not in jobs[0]
    assert store.completed is not None


@pytest.mark.parametrize(
    ("src", "message"),
    [
        ("assets/only-here.mp4", "only-here.mp4 was only saved on the device that added it"),
        ("assets/missing.mp4", "assets/missing.mp4 is not in this project's library"),
        ({"generate": "image", "prompt": "a red fox", "aspectRatio": "1:1"}, "is not in this project's library"),
        ({"transform": "upscale", "input": "assets/broll.mp4"}, "Editing an existing file with AI is not available yet."),
    ],
)
def test_unreachable_source_fails_with_a_message_the_user_can_act_on(monkeypatch, src, message):
    jobs: list[dict] = []
    _fake_node(monkeypatch, [{"kind": "video", "src": src}], jobs)
    store = FakeStore()
    rd.process(store, _task())
    assert store.failed is not None and message in store.failed
    assert store.completed is None and jobs == []


def test_revision_that_is_not_the_one_the_task_captured_is_refused(monkeypatch):
    _fake_node(monkeypatch, [], [])
    store = FakeStore()
    store.get_editor_revision = lambda _id: {"id": "r1", "clip_id": "c1", "source_hash": "0" * 64, "document": DOCUMENT}
    rd.process(store, _task())
    assert store.failed == rd.RENDER_FAILED


def test_revision_without_document_is_refused(monkeypatch):
    _fake_node(monkeypatch, [], [])
    store = FakeStore()
    store.get_editor_revision = lambda _id: {"id": "r1", "clip_id": "c1", "source_hash": REVISION_HASH, "document": None}
    rd.process(store, _task())
    assert store.failed == rd.RENDER_FAILED


def test_generation_match_compares_only_what_the_declaration_wrote():
    record = {"generation": {"key": GENERATED_KEY}}
    assert rd._generation_matches({"generate": "image", "prompt": "a red fox"}, record)
    assert rd._generation_matches({"generate": "image", "prompt": "a red fox", "model": "gemini-image"}, record)
    assert not rd._generation_matches({"generate": "image", "prompt": "a red fox", "model": "other"}, record)
    assert not rd._generation_matches({"generate": "video", "prompt": "a red fox"}, record)
    assert not rd._generation_matches({"generate": "image", "prompt": "a fox"}, record)


NODE_READY = (
    shutil.which("node") is not None
    and shutil.which("ffmpeg") is not None
    and (rd._REPO / "node_modules/@napi-rs/canvas").exists()
)


@pytest.mark.skipif(not NODE_READY, reason="cần node + npm ci + ffmpeg")
def test_real_exporter_renders_master_with_captions(tmp_path):
    master = tmp_path / "master.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2",
            "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=2",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            str(master),
        ],
        check=True,
    )
    transcript = rd._REPO / "packages/editor-parity/fixtures/transcript.json"
    document = {
        "version": 1,
        "stage": {
            "children": [
                {
                    "kind": "scene",
                    "name": "Clip",
                    "width": 360,
                    "height": 640,
                    "fill": "#000000",
                    "active": True,
                    "children": [
                        {"kind": "video", "width": 360, "height": 640, "end": 2, "src": "assets/master.mp4"},
                        {"kind": "captions", "src": "assets/transcript.json", "preset": "classic", "end": 2},
                    ],
                }
            ]
        },
    }
    store = FakeStore(
        watermark=True,
        document=document,
        files={("renders", "u1/c1/master.mp4"): master, ("renders", "u1/c1/master.json"): transcript},
    )
    rd.process(store, _task(720))

    assert store.failed is None, store.failed
    out = tmp_path / "out.mp4"
    out.write_bytes(store.replaced[2])
    probe = json.loads(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", str(out)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    kinds = {stream["codec_type"]: stream for stream in probe["streams"]}
    assert (kinds["video"]["width"], kinds["video"]["height"]) == (720, 1280)
    assert "audio" in kinds
    assert store.completed["width"] == 720


UID = "6b519a71-93a7-412e-8274-2444a7343a08"
LOGO = f"{UID}/logo-8d519a71-93a7-412e-8274-2444a7343a08.png"


def _brand_sources(tmp_path):
    store = FakeStore()
    task = Task(id="t1", user_id=UID, kind="render_document", clip_id="c1", job_id="j1", payload={}, attempt_id="a1")
    return store, rd._Sources(store, task, store.get_job_row("j1"), tmp_path)


def test_brand_logo_comes_from_the_brand_bucket_of_the_job_owner(tmp_path):
    store, sources = _brand_sources(tmp_path)
    path = sources.media(f"brand:{LOGO}")
    assert path.exists()
    assert store.downloads == [("brand", LOGO)]


@pytest.mark.parametrize(
    "object_name",
    [
        "0b519a71-93a7-412e-8274-2444a7343a08/logo-8d519a71-93a7-412e-8274-2444a7343a08.png",  # người khác
        f"{UID}/../secret.png",
        f"{UID}/logo-x.png",
    ],
)
def test_brand_logo_outside_the_owners_folder_is_refused(tmp_path, object_name):
    store, sources = _brand_sources(tmp_path)
    with pytest.raises(rd.SourceError, match="brand logo is not available"):
        sources.media(f"brand:{object_name}")
    assert store.downloads == []


def test_node_run_reads_progress_lines_and_keeps_stdout(tmp_path, monkeypatch):
    # Exporter giả: in tiến độ ra stderr xen dòng log, JSON kết quả ra stdout.
    script = tmp_path / "fake-export.mjs"
    script.write_text(
        "for (const n of [1, 2, 4]) process.stderr.write(`progress ${n}/4\\n`);\n"
        "process.stderr.write('log thường\\n');\n"
        "process.stdout.write(JSON.stringify({ frames: 4 }) + '\\n');\n"
    )
    monkeypatch.setattr(rd, "CLIP_EXPORT", script)
    seen: list[float] = []
    out = rd._node_run(tmp_path / "job.json", timeout=30, on_render=seen.append)
    assert seen == [0.25, 0.5, 1.0]
    assert json.loads(out) == {"frames": 4}


def test_node_run_failure_carries_stderr_tail(tmp_path, monkeypatch):
    script = tmp_path / "fail.mjs"
    script.write_text("process.stderr.write('progress 1/2\\nhỏng thật\\n'); process.exit(3);\n")
    monkeypatch.setattr(rd, "CLIP_EXPORT", script)
    with pytest.raises(RuntimeError, match="hỏng thật"):
        rd._node_run(tmp_path / "job.json", timeout=30, on_render=lambda _part: None)


def test_export_reports_progress_through_every_stage(monkeypatch):
    jobs: list[dict] = []
    _fake_node(monkeypatch, [{"kind": "video", "src": "assets/master.mp4"}], jobs)
    monkeypatch.setattr(rd._Progress, "MIN_SECONDS", 0)
    store = FakeStore()
    rd.process(store, _task())
    assert store.completed
    assert store.progress[0] == 0.03
    assert rd.SOURCES_DONE in store.progress
    assert store.progress[-1] == rd.MUXED
    assert store.progress == sorted(store.progress), "tiến độ chỉ tăng"


def test_huy_export_dung_exporter_ngay(tmp_path, monkeypatch):
    """E2-d2: `cancel_export` làm heartbeat trả false → cờ `lost` bật → exporter bị giết, không chờ vẽ xong."""
    import threading
    import time as clock

    import pytest

    from opencmo.worker import render_document_task as task_module

    slow = tmp_path / "slow.mjs"
    slow.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
    monkeypatch.setattr(task_module, "CLIP_EXPORT", slow)
    stop = threading.Event()
    threading.Timer(0.5, stop.set).start()
    began = clock.monotonic()
    with pytest.raises(task_module.ExportCancelled):
        task_module._node_run(tmp_path / "job.json", timeout=120, on_render=lambda _part: None, stop=stop)
    assert clock.monotonic() - began < 5
