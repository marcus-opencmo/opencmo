"""`publish_media` (P4 B4): a finished export streamed from Storage to Zernio's presigned upload.

The web app (the `publish_post` handler) asks Zernio for the presigned URL with its own key and queues this
task with it; the worker never holds a Zernio key. Bytes go Storage → worker → Zernio in 1 MB chunks: the
file is never in memory and never on disk, and never passes through Next.js (web rule 3).

The source is the founder's own export (`exports/<user>/<clip>/<task>.mp4`), checked against the task's
owner. It is still probed before upload with an explicit demuxer and the user-media allowlist, so a file
that is not a playable MP4 is refused here instead of by the platform after it was posted.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

import httpx

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.media.ffmpeg import USER_HTTP_INPUT, run
from opencmo.worker.task_run import TaskContext, TaskError, run_task

SOURCE_BUCKET = "exports"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# A video export, or one still of a post image (P5: `<task>-01.png` from `render_stills`).
SOURCE_OBJECT = re.compile(rf"^({UUID})/{UUID}/{UUID}(\.mp4|-[0-9]{{2}}\.png)$")
CONTENT_TYPES = {"video/mp4", "image/png"}
# Zernio takes up to 5 GB; an OpenCMO export stays far below, so anything larger is not ours.
MAX_BYTES = 2 * 1024**3
CHUNK = 1024 * 1024
# Zernio's presigned uploads go to Cloudflare R2. Tests and the local stack add hosts through the env.
UPLOAD_HOST_SUFFIXES = (".r2.cloudflarestorage.com",)
LOCAL_HOSTS = {"127.0.0.1", "localhost"}

FAILED = "Uploading the video for posting failed. Please retry."
NOT_PLAYABLE = "The video could not be read for posting. Export it again, then retry."
EXPIRED = "The upload link expired before the video was sent. Please retry."


def _extra_hosts() -> set[str]:
    return {h.strip().lower() for h in os.environ.get("OPENCMO_PUBLISH_UPLOAD_HOSTS", "").split(",") if h.strip()}


def upload_url_allowed(url: str) -> bool:
    """HTTPS to Zernio's storage only. A host named in `OPENCMO_PUBLISH_UPLOAD_HOSTS` is allowed too, and
    plain HTTP only for a local one (the fake server in tests)."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if not host or parts.username or parts.password:
        return False
    if host in _extra_hosts():
        return parts.scheme == "https" or (parts.scheme == "http" and host in LOCAL_HOSTS)
    return parts.scheme == "https" and host.endswith(UPLOAD_HOST_SUFFIXES)


def _payload(task: Task) -> tuple[str, str, str]:
    payload = task.payload or {}
    bucket = str(payload.get("bucket") or "")
    object_name = str(payload.get("object") or "")
    upload_url = str(payload.get("upload_url") or "")
    content_type = str(payload.get("content_type") or "")
    match = SOURCE_OBJECT.match(object_name)
    if bucket != SOURCE_BUCKET or not match or match.group(1) != task.user_id:
        raise TaskError(NOT_PLAYABLE)
    if content_type not in CONTENT_TYPES or not upload_url_allowed(upload_url):
        raise TaskError(FAILED)
    return object_name, upload_url, content_type


def _probe(signed: str, content_type: str = "video/mp4") -> dict[str, Any]:
    """Reads only the header through the signed URL: an MP4 with a video stream and a duration, or a PNG with a size.
    The demuxer is named, never sniffed."""
    image = content_type == "image/png"
    try:
        result = run(
            ["ffprobe", "-v", "error", *USER_HTTP_INPUT, "-f", "png_pipe" if image else "mov", "-print_format", "json",
             "-show_format", "-show_streams", signed],
            timeout=120,
        )
        info = json.loads(result.stdout or "{}")
    except Exception as error:
        raise TaskError(NOT_PLAYABLE) from error
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    try:
        duration = float(info.get("format", {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if image:
        if video is None or not video.get("width") or not video.get("height"):
            raise TaskError(NOT_PLAYABLE)
        return {"width": video.get("width"), "height": video.get("height")}
    if video is None or duration <= 0:
        raise TaskError(NOT_PLAYABLE)
    return {"duration": duration, "width": video.get("width"), "height": video.get("height")}


def _stream(ctx: TaskContext, signed: str, upload_url: str, content_type: str) -> int:
    timeout = httpx.Timeout(60.0, connect=15.0)
    sent = 0
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        try:
            with client.stream("GET", signed) as source:
                if source.status_code >= 500:
                    raise TransientError(f"Storage answered {source.status_code}")
                if source.status_code >= 400:
                    raise TaskError(NOT_PLAYABLE)
                try:
                    size = int(source.headers.get("content-length") or "")
                except ValueError as error:
                    raise TaskError(NOT_PLAYABLE) from error
                if not 0 < size <= MAX_BYTES:
                    raise TaskError(NOT_PLAYABLE)

                def chunks() -> Iterator[bytes]:
                    nonlocal sent
                    for chunk in source.iter_bytes(CHUNK):
                        if ctx.lost():
                            raise TransientError("Lease lost while uploading")
                        sent += len(chunk)
                        if sent > size:
                            raise TaskError(NOT_PLAYABLE)
                        yield chunk

                # A presigned PUT takes no chunked body: the length is sent up front.
                answer = client.put(
                    upload_url,
                    content=chunks(),
                    headers={"Content-Type": content_type, "Content-Length": str(size)},
                )
        except httpx.TransportError as error:
            raise TransientError("Upload interrupted") from error
    if answer.status_code in (401, 403):
        raise TaskError(EXPIRED)
    if answer.status_code >= 500:
        raise TransientError(f"Upload answered {answer.status_code}")
    if answer.status_code >= 300 or sent != size:
        raise TaskError(FAILED)
    return sent


def process(store: Any, task: Task) -> None:
    def body(ctx: TaskContext) -> None:
        object_name, upload_url, content_type = _payload(task)
        # Short-lived: the probe and the upload start at once; the GET keeps streaming past expiry.
        signed = store.sign_object_url(SOURCE_BUCKET, object_name, expires_in=600)
        probed = _probe(signed, content_type)
        sent = _stream(ctx, signed, upload_url, content_type)
        if ctx.lost() or not store.heartbeat_task(task.id, task.attempt_id):
            return
        output = {"bytes": sent, "content_type": content_type, **probed}
        ctx.complete(lambda: store.complete_task(task.id, task.attempt_id, output))

    run_task(store, task, name="publish-media", failed=FAILED, body=body)
