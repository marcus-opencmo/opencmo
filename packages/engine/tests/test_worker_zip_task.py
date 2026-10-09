from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from opencmo.backends.supabase import Task
from opencmo.worker import zip_task


class FakeStore:
    def __init__(self, root: Path, *, wrong_user: bool = False) -> None:
        self.root = root
        self.failed = None
        self.completed = None
        self.uploaded = None
        user = "other" if wrong_user else "user-1"
        self.exports = [
            Task(
                id=f"export-{index}", user_id=user, kind="render_document", clip_id=f"clip-{index}",
                status="done", attempt_id=f"attempt-{index}",
                payload={"editor_revision_id": f"rev-{index}"},
                output={"manifest": {"files": {"mp4": {
                    "bucket": "exports",
                    "object": f"{user}/clip-{index}/export-{index}.mp4",
                }}}},
            )
            for index in range(2)
        ]
        for index in range(2):
            path = root / "exports" / user / f"clip-{index}" / f"export-{index}.mp4"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{index}-mp4")

    def get_tasks(self, _ids):
        return self.exports

    def get_job_row(self, _job_id):
        return {"id": "job-1", "user_id": "user-1"}

    def get_clip(self, clip_id):
        index = int(clip_id.rsplit("-", 1)[1])
        return {"id": clip_id, "job_id": "job-1", "idx": index}

    def get_editor_revision(self, revision_id):
        index = int(revision_id.rsplit("-", 1)[1])
        return {"id": revision_id, "clip_id": f"clip-{index}", "number": index + 3}

    def heartbeat_task(self, *_args):
        return True

    def download_object(self, bucket, path, dest, **_kwargs):
        shutil.copyfile(self.root / bucket / path, dest)

    def upload_object(self, bucket, path, source, **_kwargs):
        target = self.root / bucket / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        self.uploaded = target

    def complete_task(self, _task, _attempt, output):
        self.completed = output
        return True

    def fail_task(self, _task, _attempt, error):
        self.failed = error
        return True

    def remove_objects(self, _bucket, _paths):
        pass


def _task() -> Task:
    return Task(
        id="zip-1", user_id="user-1", kind="zip", job_id="job-1",
        payload={"export_task_ids": ["export-0", "export-1"]}, attempt_id="attempt-1",
    )


def test_zip_goi_ban_xuat_tu_editor(tmp_path):
    store = FakeStore(tmp_path)

    zip_task.process(store, _task())

    assert store.failed is None
    with zipfile.ZipFile(store.uploaded) as archive:
        assert archive.namelist() == ["clip-01-rev3.mp4", "clip-02-rev4.mp4"]
        assert archive.read("clip-02-rev4.mp4") == b"1-mp4"


def test_zip_tu_choi_task_khong_phai_ban_xuat_editor(tmp_path):
    store = FakeStore(tmp_path)
    store.exports[0].kind = "export"

    zip_task.process(store, _task())

    assert store.failed == zip_task.UNAVAILABLE
    assert store.uploaded is None


def test_zip_tu_choi_revision_cua_clip_khac(tmp_path):
    store = FakeStore(tmp_path)
    store.exports[0].payload = {"editor_revision_id": "rev-1"}

    zip_task.process(store, _task())

    assert store.failed == zip_task.UNAVAILABLE
    assert store.uploaded is None


def test_zip_tu_choi_export_cua_user_khac(tmp_path):
    store = FakeStore(tmp_path, wrong_user=True)

    zip_task.process(store, _task())

    assert store.failed == zip_task.UNAVAILABLE
    assert store.uploaded is None


def test_zip_tu_choi_object_khong_dung_prefix_canonical(tmp_path):
    store = FakeStore(tmp_path)
    store.exports[0].output["manifest"]["files"]["mp4"]["object"] = "user-1/clip-1/export-1.mp4"

    zip_task.process(store, _task())

    assert store.failed == zip_task.UNAVAILABLE
    assert store.uploaded is None


def test_zip_originals_does_not_require_editor_exports(tmp_path):
    store = FakeStore(tmp_path)
    rows = []
    for index in range(2):
        key = f'user-1/job-1/1/{index}.mp4'
        path = tmp_path / 'clips' / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f'original-{index}'.encode())
        rows.append({'id': f'clip-{index}', 'job_id': 'job-1', 'idx': index, 'storage_path': key})
    store.get_clip = lambda clip_id: next(row for row in rows if row['id'] == clip_id)
    task = _task()
    task.payload = {'clip_ids': ['clip-1', 'clip-0']}
    zip_task.process(store, task)
    assert store.failed is None
    with zipfile.ZipFile(store.uploaded) as archive:
        assert archive.namelist() == ['clip-01.mp4', 'clip-02.mp4']
        assert archive.read('clip-01.mp4') == b'original-0'


def test_zip_original_rejects_foreign_path(tmp_path):
    store = FakeStore(tmp_path)
    store.get_clip = lambda _: {'id': 'clip-0', 'job_id': 'job-1', 'idx': 0,
                                'storage_path': 'other/job-1/1/file.mp4'}
    task = _task()
    task.payload = {'clip_ids': ['clip-0']}
    zip_task.process(store, task)
    assert store.uploaded is None
    assert store.failed == zip_task.UNAVAILABLE
