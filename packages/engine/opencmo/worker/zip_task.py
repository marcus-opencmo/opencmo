"""Gói đúng snapshot export đã chọn thành ZIP mà không giữ file trong RAM."""

from __future__ import annotations

import re
import zipfile
from typing import Any

from opencmo.backends.supabase import Task
from opencmo.worker.task_run import TaskContext, TaskError, run_task

RENDERS_BUCKET = "renders"
EXPORTS_BUCKET = "exports"
UNAVAILABLE = "One of these clips is no longer available. Refresh the project and try again."
RENDER_FAILED = "We could not prepare the download. Please try downloading again."


class ExportUnavailableError(TaskError):
    pass


def _validated_exports(store: Any, task: Task) -> list[tuple[Task, dict, dict]]:
    """Bản xuất từ editor (`render_document`) đã chốt trong payload lúc bấm.

    Mỗi id được `request_zip` kiểm chủ + project rồi; ở đây kiểm lại bằng service
    role vì payload là thứ duy nhất nối file trong ZIP với người tải.
    """
    job = store.get_job_row(task.job_id) if task.job_id else None
    if not job or job.get("user_id") != task.user_id:
        raise ExportUnavailableError(UNAVAILABLE)
    raw_ids = (task.payload or {}).get("export_task_ids")
    if (
        not isinstance(raw_ids, list)
        or not 1 <= len(raw_ids) <= 10
        or len(set(raw_ids)) != len(raw_ids)
        or not all(isinstance(item, str) for item in raw_ids)
    ):
        raise ExportUnavailableError(UNAVAILABLE)
    by_id = {row.id: row for row in store.get_tasks(raw_ids)}
    result = []
    for export_id in raw_ids:
        export = by_id.get(export_id)
        revision_id = ((export.payload or {}).get("editor_revision_id") if export else None)
        if (
            export is None
            or export.kind != "render_document"
            or export.status != "done"
            or export.user_id != task.user_id
            or not export.clip_id
            or not isinstance(revision_id, str)
        ):
            raise ExportUnavailableError(UNAVAILABLE)
        clip = store.get_clip(export.clip_id)
        revision = store.get_editor_revision(revision_id)
        if (
            not clip
            or clip.get("job_id") != task.job_id
            or not revision
            or revision.get("clip_id") != export.clip_id
        ):
            raise ExportUnavailableError(UNAVAILABLE)
        # Cùng đích duy nhất mà `render_document_task._canonical` ghi vào.
        entry = ((((export.output or {}).get("manifest") or {}).get("files")) or {}).get("mp4")
        if (
            not isinstance(entry, dict)
            or entry.get("bucket") != EXPORTS_BUCKET
            or entry.get("object") != f"{task.user_id}/{export.clip_id}/{export.id}.mp4"
        ):
            raise ExportUnavailableError(UNAVAILABLE)
        result.append((export, clip, revision))
    return result


def _original_files(store: Any, task: Task) -> list[tuple[str, str, str]]:
    job = store.get_job_row(task.job_id) if task.job_id else None
    ids = (task.payload or {}).get("clip_ids")
    if (not job or job.get("user_id") != task.user_id
            or not isinstance(ids, list) or not 1 <= len(ids) <= 10
            or not all(isinstance(value, str) for value in ids)
            or len(set(ids)) != len(ids)):
        raise ExportUnavailableError(UNAVAILABLE)
    clips = []
    for clip_id in ids:
        clip = store.get_clip(clip_id)
        if not clip or clip.get("job_id") != task.job_id:
            raise ExportUnavailableError(UNAVAILABLE)
        key = clip.get("storage_path") or ""
        prefix = re.escape(f"{task.user_id}/{task.job_id}/")
        if not re.fullmatch(prefix + r"[A-Za-z0-9_-]+/[A-Za-z0-9][A-Za-z0-9._-]*", key):
            raise ExportUnavailableError(UNAVAILABLE)
        clips.append(clip)
    return [("clips", clip["storage_path"], f"clip-{int(clip['idx']) + 1:02d}.mp4")
            for clip in sorted(clips, key=lambda clip: int(clip["idx"]))]


def _files(store: Any, task: Task) -> list[tuple[str, str, str]]:
    if "clip_ids" in (task.payload or {}):
        return _original_files(store, task)
    return [
        (
            EXPORTS_BUCKET,
            export.output["manifest"]["files"]["mp4"]["object"],
            f"clip-{int(clip['idx']) + 1:02d}-rev{int(revision['number'])}.mp4",
        )
        for export, clip, revision in _validated_exports(store, task)
    ]


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="zip", failed=RENDER_FAILED, body=_run)


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    entries = _files(store, task)
    archive = ctx.root / "export.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as output:
        for bucket, object_name, name in entries:
            if ctx.lost():
                return
            local = ctx.root / name
            store.download_object(bucket, object_name, local)
            output.write(local, arcname=name)
            local.unlink()
    if ctx.lost():
        return
    object_name = f"{task.user_id}/zips/{task.id}/{task.attempt_id}/export.zip"
    store.upload_object(RENDERS_BUCKET, object_name, archive, content_type="application/zip")
    ctx.uploaded(RENDERS_BUCKET, object_name)
    file_entry = {
        "bucket": RENDERS_BUCKET,
        "object": object_name,
        "bytes": archive.stat().st_size,
    }
    ctx.complete(
        lambda: store.complete_task(
            task.id,
            task.attempt_id,
            {
                "output_path": object_name,
                "bytes": archive.stat().st_size,
                "manifest": {
                    "attempt_id": task.attempt_id,
                    "selection": task.payload,
                    "files": {"zip": file_entry},
                },
            },
        )
    )
