"""`render_stills` (P5 B2): one PNG per slide of a slideshow and a zip of the set.

Same ownership checks, sources and renderer as `render_document`; the Node side draws the stills
(`clip-export stills`), writing each to disk so none stays in memory. The free plan's watermark is burned in
here with the export's filter: without it the PNG set would be a way round the watermark. The zip is stored,
not compressed (PNG is already compressed), and streamed by `zipfile`, so no image enters Python memory.
"""

from __future__ import annotations

import json
import subprocess
import time
import zipfile
from pathlib import Path
from typing import Any

from opencmo.backends.supabase import Task
from opencmo.steps.render import _watermark_filter
from opencmo.worker.render_document_task import (
    EDITOR_FONTS,
    EXPORTS_BUCKET,
    WATERMARK,
    _node,
    _Sources,
    owned_revision,
)
from opencmo.worker.task_run import TaskContext, TaskError, run_task

FAILED = "Exporting the slides as images failed. Please try again."
STILLS_TIMEOUT = 600
MARK_TIMEOUT = 60
#: All the stills together: a stuck ffmpeg must not hold the worker for 35 × MARK_TIMEOUT.
MARK_BUDGET = 300
#: The hook is the first slide: what TikTok photo mode shows first.
COVER_INDEX = 0


def _canonical(task: Task) -> tuple[str, str]:
    """The zip's place, set by the RPC; each still sits next to it as `<task>-01.png`."""
    payload = task.payload or {}
    bucket = str(payload.get("bucket") or "")
    object_name = str(payload.get("object") or "")
    if bucket != EXPORTS_BUCKET or object_name != f"{task.user_id}/{task.clip_id}/{task.id}.zip":
        raise ValueError("Invalid stills destination")
    return bucket, object_name


def _burn_watermark(still: Path, mark: str) -> None:
    """In place. The PNG is our own output, so its format is stated, not sniffed."""
    out = still.with_suffix(".marked.png")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-protocol_whitelist", "file", "-f", "image2", "-c:v", "png", "-i", str(still),
         "-vf", mark, "-frames:v", "1", "-f", "image2", "-c:v", "png", str(out)],
        check=True, capture_output=True, timeout=MARK_TIMEOUT,
    )
    out.replace(still)


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="render-stills", failed=FAILED, body=_run)


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    if task.kind != "render_stills" or not task.clip_id or not task.job_id:
        raise ValueError("Invalid render_stills task")
    bucket, zip_object = _canonical(task)
    job, document = owned_revision(store, task)

    root = ctx.root
    planned = root / "document.json"
    planned.write_text(json.dumps(document), encoding="utf-8")
    plan = json.loads(_node("plan", str(planned), "1080", timeout=120))

    sources = _Sources(store, task, job, root)
    media: list[dict[str, Any]] = []
    transcripts: list[dict[str, Any]] = []
    for entry in plan["sources"]:
        if ctx.lost():
            return
        if entry["kind"] == "transcript":
            transcripts.append({"src": entry["src"], "file": str(sources.transcript(entry["src"]))})
        else:
            media.append({"src": entry["src"], "file": str(sources.media(entry["src"]))})

    out_dir = root / "stills"
    job_file = root / "stills.json"
    job_file.write_text(
        json.dumps({"document": document, "media": media, "transcripts": transcripts, "fonts": str(EDITOR_FONTS), "out_dir": str(out_dir)}),
        encoding="utf-8",
    )
    result = json.loads(_node("stills", str(job_file), timeout=STILLS_TIMEOUT).strip().splitlines()[-1])
    if "error" in result:
        raise TaskError(str(result["error"]))
    stills = [Path(file) for file in result["files"]]

    if bool(job.get("watermark", True)):
        mark = _watermark_filter(WATERMARK, int(result["height"]))
        if mark:
            deadline = time.monotonic() + MARK_BUDGET
            for still in stills:
                if ctx.lost():
                    return
                if time.monotonic() > deadline:
                    raise TaskError(FAILED)
                _burn_watermark(still, mark)

    archive = root / "slides.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
        for still in stills:
            bundle.write(still, still.name)

    if ctx.lost() or not store.heartbeat_task(task.id, task.attempt_id):
        return
    base = str((task.payload or {}).get("still_prefix") or "")
    if base != zip_object.removesuffix(".zip"):
        raise ValueError("Invalid stills destination")
    listed: list[dict[str, Any]] = []
    # `manifest.files` is what job deletion and retention walk: every object this task wrote is named in it.
    files: dict[str, dict[str, Any]] = {}
    for index, still in enumerate(stills):
        object_name = f"{base}-{index + 1:02d}.png"
        store.replace_object(bucket, object_name, still, content_type="image/png")
        ctx.uploaded(bucket, object_name)
        listed.append({"index": index, "object": object_name, "bytes": still.stat().st_size})
        files[f"still_{index + 1:02d}"] = {"bucket": bucket, "object": object_name, "bytes": still.stat().st_size}
    store.replace_object(bucket, zip_object, archive, content_type="application/zip")
    ctx.uploaded(bucket, zip_object)
    size = archive.stat().st_size
    files["zip"] = {"bucket": bucket, "object": zip_object, "bytes": size}
    output = {
        "output_path": zip_object,
        "stills": listed,
        "zip": {"object": zip_object, "bytes": size},
        "cover_index": COVER_INDEX,
        "width": result["width"],
        "height": result["height"],
        "count": len(stills),
        "manifest": {"attempt_id": task.attempt_id, "editor_revision_id": (task.payload or {}).get("editor_revision_id"), "files": files},
    }
    ctx.complete(lambda: store.complete_task(task.id, task.attempt_id, output))
