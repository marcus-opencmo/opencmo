"""Chuẩn bị chế độ "Edit full video" (E2-c) cho một video UPLOAD.

Một lượt `-c copy` nguyên file upload thành master của editor (không giải mã, RAM
thấp — I/O chứ không phải CPU), transcript CẢ video từ artifact `transcript` của job
(không transcribe lại, không tốn credit), rồi `complete_full_edit` công bố revision #1
+ draft + master trong một giao dịch. Link YouTube không bao giờ tới đây: RPC
`create_full_edit` đã chặn (luật 3 — không tải nguyên video gốc).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from opencmo.backends.retry import PermanentError
from opencmo.backends.supabase import SOURCES_BUCKET, Job, Task
from opencmo.editing.models import default_settings, settings_hash, transcript_from_dict
from opencmo.editing.subtitles import to_ds_transcript
from opencmo.media.probe import probe_file
from opencmo.worker.media import make_editor_master, upload_object_name
from opencmo.worker.task_run import TaskContext, TaskError, run_task

RENDERS_BUCKET = "renders"
# Hai câu dưới hiện thẳng trong app — tiếng Anh.
FAILED = "Could not prepare the full video for editing. Please try again."
UPLOAD_GONE = "The original upload is no longer available. Upload the video again to edit it in full."


class _UserError(TaskError):
    pass


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="full", failed=FAILED, body=_run)


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    if task.kind != "prepare_full" or not task.clip_id or not task.job_id:
        raise ValueError("Invalid prepare_full task")
    clip = store.get_clip(task.clip_id)
    if not clip or clip.get("job_id") != task.job_id or clip.get("kind") != "full":
        raise ValueError("Full-video clip mismatch")
    row = store.get_job_row(task.job_id)
    if not row or row.get("user_id") != task.user_id:
        raise ValueError("Job ownership mismatch")
    job = Job.from_row(row)
    if not job.source_url.startswith("storage://"):
        raise _UserError("Full-video editing works on videos you uploaded.")

    root = ctx.root
    object_name = upload_object_name(job)
    source = root / Path(object_name).name
    try:
        store.download_object(SOURCES_BUCKET, object_name, source)
    except PermanentError as exc:
        raise _UserError(UPLOAD_GONE) from exc

    master = root / "master.mp4"
    begin = make_editor_master(source, master)
    info = probe_file(str(master))
    master_object = f"{task.user_id}/{task.clip_id}/master/{task.attempt_id}.mp4"
    store.upload_object(RENDERS_BUCKET, master_object, master, content_type="video/mp4")

    transcript_object = None
    artifacts = store.list_artifacts(job.id, "transcript")
    if artifacts:
        transcript = transcript_from_dict(artifacts[-1]["data"])
        transcript_file = root / "master.transcript.json"
        transcript_file.write_text(
            to_ds_transcript(transcript.slice(begin, begin + info.duration)), encoding="utf-8"
        )
        transcript_object = f"{task.user_id}/{task.clip_id}/master/{task.attempt_id}.transcript.json"
        store.upload_object(
            RENDERS_BUCKET, transcript_object, transcript_file, content_type="application/json"
        )

    settings = default_settings(
        0.0,
        info.duration,
        aspect=job.aspect if job.aspect != "auto" else "9:16",
        captions=job.captions,
    ).to_dict()
    ctx.complete(
        lambda: store.complete_full_edit(
            task.id,
            task.attempt_id,
            settings=settings,
            settings_hash=settings_hash(settings),
            master={
                "bucket": RENDERS_BUCKET,
                "object": master_object,
                "transcript": transcript_object,
                "bytes": master.stat().st_size,
                "width": info.width,
                "height": info.height,
                "duration": info.duration,
                "offset": begin,
            },
        )
    )
