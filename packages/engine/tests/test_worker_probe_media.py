from __future__ import annotations

import json
from pathlib import Path

from opencmo.backends.supabase import Task
from opencmo.worker import probe_media


class FakeStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.completed = None
        self.removed = []

    def get_media_asset(self, _asset_id):
        return {
            "id": "asset-1", "user_id": "user-1", "job_id": "job-1",
            "storage_path": "media/user-1/job-1/bad.mp4",
        }

    def heartbeat_task(self, *_args):
        return True

    def download_object(self, _bucket, _path, dest, **_kwargs):
        dest.write_bytes(b"not a video")

    def complete_media_probe(self, *args, **kwargs):
        self.completed = (args, kwargs)
        return True

    def remove_objects(self, bucket, paths):
        self.removed.append((bucket, paths))


def test_file_rac_bi_reject_va_xoa_khoi_storage(tmp_path):
    store = FakeStore(tmp_path)
    task = Task(
        id="task-1", user_id="user-1", kind="probe_media", asset_id="asset-1",
        attempt_id="attempt-1",
    )

    probe_media.process(store, task)

    assert store.completed[1]["ok"] is False
    assert store.completed[1]["error"] == probe_media.BAD_MEDIA
    assert store.removed == [("media", ["user-1/job-1/bad.mp4"])]


def test_thieu_asset_id_thi_fail_task_ngay_khong_de_treo(tmp_path):
    """Task không có asset_id phải hỏng ngay, không nằm `running` tới hết lease.

    `complete_media_probe` tra theo asset_id nên id rỗng luôn trả false: task
    lặp lại tới hết `max_attempts` rồi mới failed, trong lúc đó UI vẫn quay.
    """
    store = FakeStore(tmp_path)
    failed: list[tuple] = []
    store.fail_task = lambda *args: failed.append(args) or True
    task = Task(
        id="task-2", user_id="user-1", kind="probe_media", asset_id=None,
        attempt_id="attempt-1",
    )

    probe_media.process(store, task)

    assert failed == [("task-2", "attempt-1", probe_media.BAD_MEDIA)]
    assert store.completed is None


def test_anh_png_qua_probe_khong_co_thoi_luong(tmp_path):
    """Frame chụp từ clip (AI transition) và ảnh tham chiếu: ảnh đọc được thì `ready`, duration rỗng."""
    import subprocess

    still = tmp_path / "still.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", str(still)],
        check=True,
    )
    store = FakeStore(tmp_path)
    store.get_media_asset = lambda _id: {
        "id": "asset-1", "user_id": "user-1", "job_id": "job-1",
        "storage_path": "media/user-1/job-1/frame.png",
    }
    sizes: list[int] = []

    def download(_bucket, _path, dest, **kwargs):
        sizes.append(kwargs["max_bytes"])
        dest.write_bytes(still.read_bytes())

    store.download_object = download
    task = Task(id="task-3", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1")

    probe_media.process(store, task)

    assert store.completed[1] == {"duration": None, "width": 64, "height": 48, "ok": True, "error": None}
    assert sizes == [probe_media.MAX_IMAGE_BYTES]
    assert store.removed == []


def _cube(size: int) -> str:
    lines = ["TITLE \"test\"", f"LUT_3D_SIZE {size}"]
    for b in range(size):
        for g in range(size):
            for r in range(size):
                lines.append(f"{r / (size - 1)} {g / (size - 1)} {b / (size - 1)}")
    return "\n".join(lines)


def test_lut_cube_hop_le_thi_ready_kich_thuoc_luoi(tmp_path):
    store = FakeStore(tmp_path)
    store.get_media_asset = lambda _id: {
        "id": "asset-1", "user_id": "user-1", "job_id": "job-1",
        "storage_path": "media/user-1/job-1/look.cube",
    }
    store.download_object = lambda _bucket, _path, dest, **_kw: dest.write_text(_cube(5))
    task = Task(id="task-3", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1")

    probe_media.process(store, task)

    assert store.completed[1] == {"duration": None, "width": 5, "height": 5, "ok": True, "error": None}
    assert store.removed == []


def test_lut_hong_hoac_1d_thi_reject_va_xoa(tmp_path):
    for body in ["LUT_3D_SIZE 5\n0 0 0", "LUT_1D_SIZE 4\n0 0 0", "\x00\xff garbage"]:
        store = FakeStore(tmp_path)
        store.get_media_asset = lambda _id: {
            "id": "asset-1", "user_id": "user-1", "job_id": "job-1",
            "storage_path": "media/user-1/job-1/look.cube",
        }
        store.download_object = lambda _bucket, _path, dest, _body=body, **_kw: dest.write_text(_body)
        task = Task(id="task-4", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1")

        probe_media.process(store, task)

        assert store.completed[1]["ok"] is False
        assert store.removed == [("media", ["user-1/job-1/look.cube"])]


def _lottie_store(tmp_path, body: str):
    store = FakeStore(tmp_path)
    store.get_media_asset = lambda _id: {
        "id": "asset-1", "user_id": "user-1", "job_id": "job-1",
        "storage_path": "media/user-1/job-1/wave.json",
    }
    store.download_object = lambda _bucket, _path, dest, **_kw: dest.write_text(body)
    return store


def test_lottie_hop_le_thi_ready_kich_thuoc_va_thoi_luong(tmp_path):
    """G4: Lottie lên Storage để export trên server vẽ được (trước chỉ nằm ở máy người dùng)."""
    body = '{"v":"5.7.4","fr":30,"ip":0,"op":90,"w":512,"h":256,"layers":[]}'
    store = _lottie_store(tmp_path, body)
    probe_media.process(store, Task(id="task-5", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1"))
    assert store.completed[1] == {"duration": 3.0, "width": 512, "height": 256, "ok": True, "error": None}
    assert store.removed == []


def test_json_khong_phai_lottie_thi_reject_va_xoa(tmp_path):
    for body in ['{"segments":[]}', "[1,2]", "not json", '{"v":"5","fr":0,"w":1,"h":1,"layers":[]}']:
        store = _lottie_store(tmp_path, body)
        probe_media.process(store, Task(id="task-6", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1"))
        assert store.completed[1]["ok"] is False, body
        assert store.removed == [("media", ["user-1/job-1/wave.json"])], body


def test_lottie_tro_file_ngoai_thi_reject(tmp_path):
    """Skottie trên worker không được đọc file khác trên máy qua tài nguyên ngoài của Lottie."""
    for asset in ({"id": "i", "w": 1, "h": 1, "u": "/etc/", "p": "passwd"}, {"id": "i", "w": 1, "h": 1, "u": "", "p": "../x.png", "e": 0}):
        body = json.dumps({"v": "5.7.4", "fr": 30, "ip": 0, "op": 30, "w": 10, "h": 10, "layers": [], "assets": [asset]})
        store = _lottie_store(tmp_path, body)
        probe_media.process(store, Task(id="task-7", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1"))
        assert store.completed[1]["ok"] is False, asset
    embedded = json.dumps({"v": "5.7.4", "fr": 30, "ip": 0, "op": 30, "w": 10, "h": 10, "layers": [],
                           "assets": [{"id": "i", "w": 1, "h": 1, "u": "", "p": "data:image/png;base64,AAAA", "e": 1}]})
    store = _lottie_store(tmp_path, embedded)
    probe_media.process(store, Task(id="task-8", user_id="user-1", kind="probe_media", asset_id="asset-1", attempt_id="attempt-1"))
    assert store.completed[1]["ok"] is True, "ảnh nhúng data: vẫn được"
