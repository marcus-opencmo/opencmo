"""Object một attempt job đã đẩy lên Storage, để nhánh lỗi dọn được đúng chúng."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from opencmo.backends.supabase import BUCKET, SOURCES_BUCKET

log = logging.getLogger(__name__)

# Master + transcript của editor sống cùng preview/export: worker ghi, người
# dùng chỉ đọc, và policy SELECT đã lọc theo `foldername[1] = auth.uid()`.
RENDERS_BUCKET = "renders"


class Uploads:
    """Mọi upload của job đi qua `put` (hoặc `record` khi object do Storage tự
    nhân bản). Quên ghi nhận một object là nó nằm lại trong bucket khi job lỗi
    mà không ai biết."""

    def __init__(self, store: Any) -> None:
        self.store = store
        self.objects: dict[str, list[str]] = {BUCKET: [], SOURCES_BUCKET: [], RENDERS_BUCKET: []}

    def put(self, bucket: str, name: str, local_file: Path, *, content_type: str) -> str:
        self.store.upload_object(bucket, name, local_file, content_type=content_type)
        self.record(bucket, name)
        return name

    def record(self, bucket: str, name: str) -> None:
        self.objects.setdefault(bucket, []).append(name)

    def cleanup(self, job_id: str) -> None:
        cleanup(self.store, self.objects, job_id)


def cleanup(store: Any, objects: dict[str, list[str]], job_id: str) -> None:
    if not any(objects.values()):
        return
    # RPC có thể đã commit dù client mất response. Chỉ xoá sau khi đọc được
    # canonical; nếu DB mất mạng thì để cron dọn sau, không đánh cược file user.
    try:
        rows = store.list_clips(job_id)
        job = store.get_job_row(job_id) or {}
    except Exception:
        log.warning("Giữ object của %s vì chưa xác định được publication", job_id, exc_info=True)
        return
    protected = {path for row in rows for path in
                 (row.get("storage_path"), row.get("preview_path")) if path}
    manifest = job.get("media_manifest") or {}
    # Giữ theo TỪNG bucket. Gộp chung một tập là xoá nhầm ngay khi hai bucket có
    # hai họ đường dẫn khác nhau — master nằm trong `renders`, không phải
    # `sources`, nên một tập chung sẽ không bao giờ khớp và master vừa công bố
    # bị dọn mất.
    masters = manifest.get("masters") or {}
    keep = {
        BUCKET: protected,
        SOURCES_BUCKET: {entry.get("object") for entry in
                         [*manifest.get("sections", []),
                          *manifest.get("proxies", {}).values()]},
        RENDERS_BUCKET: {path for entry in masters.values()
                         for path in (entry.get("object"), entry.get("transcript"))
                         if path},
    }
    for bucket, paths in objects.items():
        paths = [path for path in paths if path not in keep.get(bucket, set())]
        if not paths:
            continue
        try:
            store.remove_objects(bucket, paths)
        except Exception:
            log.warning("Không dọn được %d object trong %s", len(paths), bucket, exc_info=True)
