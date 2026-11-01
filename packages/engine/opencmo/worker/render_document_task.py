"""Export trên server: vẽ document của một editor revision ra MP4.

Worker chỉ lo phần "lấy đúng file về đĩa": đọc revision bất biến, hỏi exporter
Node (`packages/clip-export`) document cần những nguồn nào, tải từng nguồn theo
đúng luật mà editor dùng để mở chúng, rồi giao cho exporter vẽ. Vẽ, trộn tiếng,
mã hoá nằm trọn bên Node — cùng mã renderer với preview trong trình duyệt.

Luật tìm nguồn (giống `apps/web/components/editor/media.ts`):

- `assets/master.mp4`, `assets/transcript.json`: master của clip và transcript
  đi kèm nó (`media_manifest.masters[clip]`).
- `assets/transcripts/<sha256>.json`: transcript người dùng đã sửa.
- Đường dẫn khác: record trong manifest thư viện (chụp vào payload lúc bấm
  Export) có `source` trùng, bytes ở `media_assets` qua `cloud.mediaId`.
- Khai báo `generate.*`: record thư viện mà khoá generation khớp khai báo.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from opencmo.backends.supabase import Task
from opencmo.media.probe import probe_file
from opencmo.steps.render import _watermark_filter
from opencmo.worker.task_run import TaskContext, TaskError, run_task

log = logging.getLogger(__name__)

EXPORTS_BUCKET = "exports"
WATERMARK = os.environ.get("OPENCMO_WATERMARK", "opencmo.io")

RENDER_FAILED = "Exporting failed. Please try again."
MAX_SOURCE_BYTES = 2 * 1024**3
EXPORT_TIMEOUT = 1800


def _canonical(task: Task) -> tuple[str, str]:
    """Nơi DUY NHẤT ghi bản xuất: `exports/<user>/<clip>/<task>.mp4` — đích do RPC đặt."""
    payload = task.payload or {}
    bucket = str(payload.get("bucket") or "")
    object_name = str(payload.get("object") or "")
    expected = f"{task.user_id}/{task.clip_id}/{task.id}.mp4"
    if bucket != EXPORTS_BUCKET or object_name != expected:
        raise ValueError("Invalid export destination")
    return bucket, object_name

_REPO = Path(__file__).resolve().parents[4]
CLIP_EXPORT = Path(os.environ.get("OPENCMO_CLIP_EXPORT", _REPO / "packages/clip-export/src/cli.ts"))
# The clip fonts live in `packages/clip-media` (R7c); Modal sets this variable.
EDITOR_FONTS = Path(os.environ.get("OPENCMO_EDITOR_FONTS", _REPO / "packages/clip-media/fonts"))

MASTER = "assets/master.mp4"
TRANSCRIPT = "assets/transcript.json"
EDITED = re.compile(r"^assets/transcripts/([0-9a-f]{64})\.json$")
# Khai báo ghi thẳng giá trị nào thì generation phải mang đúng giá trị đó; thứ
# không ghi là mặc định mà editor tự chọn lúc sinh, không so.
_SPEC_FIELDS = (
    "aspectRatio", "duration", "seed", "voice", "scene", "resolution", "audio", "startFrame", "endFrame", "refs",
    "sourceVideo", "sourceStart", "after",
)
# Logo Brand Kit: bucket `brand`, cùng dạng đường dẫn với policy Storage + RPC.
BRAND_PREFIX = "brand:"
BRAND_OBJECT = re.compile(r"^[0-9a-f-]{36}/logo-[0-9a-f-]{36}\.png$")
MAX_LOGO_BYTES = 2 * 1024 * 1024
# Proof B-roll (`add_proof`): `capture:<id>` is the screenshot of a page capture of the job's owner.
CAPTURE_PREFIX = "capture:"
CAPTURE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_CAPTURE_BYTES = 25 * 1024 * 1024
CAPTURE_GONE = "A page capture in this clip is no longer available. Remove the proof card, then export."


class SourceError(TaskError):
    """Nguồn không lấy được. Message đi thẳng lên màn hình: viết tiếng Anh."""


def _node(*args: str, timeout: int) -> str:
    proc = subprocess.run(
        ["node", str(CLIP_EXPORT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"clip-export {args[0]} failed ({proc.returncode}): {proc.stderr[-4000:]}")
    return proc.stdout


PROGRESS_LINE = re.compile(r"^progress (\d+)/(\d+)\s*$")
# Phần của thanh Export cho từng chặng: tải nguồn trước, vẽ chiếm gần hết.
SOURCES_DONE = 0.08
RENDER_SPAN = 0.85
MUXED = 0.95


class ExportCancelled(Exception):
    """Người dùng huỷ export (`cancel_export`): heartbeat trả false, exporter bị dừng."""


def _node_run(
    job: Path,
    *,
    timeout: int,
    on_render: Callable[[float], None],
    stop: threading.Event | None = None,
) -> str:
    """`clip-export run` nhưng đọc stderr từng dòng: `progress đã/tổng` → `on_render(0–1)`.

    Đọc stderr ở luồng riêng — đợi tiến trình xong mới đọc thì pipe đầy và
    exporter treo. stdout chỉ có một dòng JSON kết quả, đọc sau khi xong.
    """
    proc = subprocess.Popen(
        ["node", str(CLIP_EXPORT), "run", str(job)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    tail: deque[str] = deque(maxlen=200)

    def read() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            match = PROGRESS_LINE.match(line)
            if not match:
                tail.append(line)
                continue
            done, total = int(match.group(1)), int(match.group(2))
            if total > 0:
                try:
                    on_render(min(1.0, done / total))
                except Exception:  # tiến độ chỉ để xem, không được làm hỏng export
                    log.debug("Không ghi được tiến độ", exc_info=True)

    reader = threading.Thread(target=read, name="clip-export-stderr", daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    try:
        # Chờ từng nhịp ngắn để thấy `stop` (task bị huỷ) mà không đợi exporter vẽ xong.
        while proc.poll() is None:
            if stop is not None and stop.is_set():
                proc.kill()
                proc.wait()
                raise ExportCancelled()
            if time.monotonic() > deadline:
                proc.kill()
                proc.wait()
                raise subprocess.TimeoutExpired(proc.args, timeout)
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                continue
    finally:
        reader.join(timeout=5)
    assert proc.stdout is not None
    out = proc.stdout.read()
    if proc.returncode != 0:
        raise RuntimeError(f"clip-export run failed ({proc.returncode}): {''.join(tail)[-4000:]}")
    return out


class _Progress:
    """Ghi tiến độ task, thưa (≥ 1,5 s hay chặng mới): mỗi lần là một RPC."""

    MIN_SECONDS = 1.5

    def __init__(self, store: Any, task: Task) -> None:
        self.store = store
        self.task = task
        self.last = 0.0
        self.value = -1.0

    def __call__(self, value: float, *, force: bool = False) -> None:
        now = time.monotonic()
        if value <= self.value or (not force and now - self.last < self.MIN_SECONDS):
            return
        self.last = now
        self.value = value
        report = getattr(self.store, "task_progress", None)
        if report is None:
            return
        try:
            report(self.task.id, self.task.attempt_id, value)
        except Exception:  # thanh tiến độ hỏng không được làm hỏng export
            log.warning("Không ghi được tiến độ task %s", self.task.id, exc_info=True)


def _generation_matches(declaration: dict[str, Any], record: dict[str, Any]) -> bool:
    try:
        key = json.loads(str((record.get("generation") or {}).get("key") or ""))
    except ValueError:
        return False
    if not isinstance(key, dict):
        return False
    spec = key.get("spec") or {}
    if key.get("type") != declaration.get("generate") or spec.get("prompt") != declaration.get("prompt"):
        return False
    if "model" in declaration and key.get("model") != declaration["model"]:
        return False
    return all(spec.get(name) == declaration[name] for name in _SPEC_FIELDS if name in declaration)


# A long-take shot declares its keyframe as a nested `generate` declaration; its `generations` row
# stores the keyframe the server resolved it to, as a storage path under these keys.
_RESOLVED_FRAMES = {"startFrame": "startImage", "endFrame": "endImage"}


def _bare_path(path: Any) -> str:
    return str(path).removeprefix("media/")


def _generation_row_matches(
    declaration: dict[str, Any],
    row: dict[str, Any],
    frame_path: Callable[[dict[str, Any]], str | None] | None = None,
) -> bool:
    """A finished `generations` row for this declaration: same prompt, same model when the
    declaration names one, and every spec field the declaration wrote. A nested keyframe
    declaration matches only when `frame_path` finds its own finished generation and it is the
    exact image the row was made from."""
    spec = row.get("spec") or {}
    if not isinstance(spec, dict) or spec.get("prompt") != declaration.get("prompt"):
        return False
    if "model" in declaration and row.get("model") != declaration["model"]:
        return False
    for name in _SPEC_FIELDS:
        if name not in declaration:
            continue
        wanted = declaration[name]
        resolved = _RESOLVED_FRAMES.get(name)
        if resolved and isinstance(wanted, dict) and "generate" in wanted and name not in spec and resolved in spec:
            path = frame_path(wanted) if frame_path else None
            if path is None or _bare_path(path) != _bare_path(spec[resolved]):
                return False
        elif spec.get(name) != wanted:
            return False
    return True


def _library_record(manifest: dict[str, Any], src: Any) -> dict[str, Any] | None:
    for record in manifest.get("assets") or []:
        if not isinstance(record, dict) or record.get("state") in ("pending", "error"):
            continue
        # `src` của element là ĐƯỜNG DẪN THƯ VIỆN (`path`: "broll.mp4",
        # "folder/broll.mp4") — fork viết `asset.path` khi chèn, và đổi tên trong
        # thư viện chỉ đổi `path`. `source` ("assets/broll.mp4") là chỗ bytes nằm;
        # document cũ hơn có thể trỏ thẳng vào nó.
        if isinstance(src, str) and (record.get("path") == src or record.get("source") == src):
            return record
        if isinstance(src, dict) and "generate" in src and _generation_matches(src, record):
            return record
    return None


class _Sources:
    """Tải từng nguồn về `root`, mỗi nguồn một lần."""

    def __init__(self, store: Any, task: Task, job: dict[str, Any], root: Path) -> None:
        self.store = store
        self.task = task
        self.root = root
        self.manifest = (task.payload or {}).get("manifest") or {}
        masters = (job.get("media_manifest") or {}).get("masters") or {}
        self.master = masters.get(task.clip_id) or {}
        self.count = 0
        # Finished generations of this project, read once and only when a declaration needs one.
        self.generations: list[dict[str, Any]] | None = None
        # A keyframe is shared by the shots on either side of it: look each one up once per export.
        self.frame_paths: dict[str, str | None] = {}

    def _path(self, suffix: str) -> Path:
        self.count += 1
        return self.root / f"src-{self.count}{suffix}"

    def media(self, src: Any) -> Path:
        stored = self._stored(src)
        if isinstance(stored, Path):
            return stored
        bucket, object_name = stored
        dest = self._path(Path(object_name).suffix or ".bin")
        self.store.download_object(bucket, object_name, dest, max_bytes=MAX_SOURCE_BYTES)
        return dest

    def media_url(self, src: Any, expires_in: int = 600) -> str | Path:
        """A signed URL for a stored video or audio source, so a reader that seeks (a look at a
        few frames) does not download the whole file. Brand logos and captures stay downloads."""
        stored = self._stored(src)
        if isinstance(stored, Path):
            return stored
        return self.store.sign_object_url(stored[0], stored[1], expires_in)

    def _stored(self, src: Any) -> tuple[str, str] | Path:
        """Where `src` lives in Storage as `(bucket, object)`, under the export's ownership rules,
        or the downloaded file for sources that are fetched another way."""
        if src == MASTER:
            if not self.master.get("object"):
                raise SourceError(
                    "This clip was processed before server export was available. "
                    "Process the video again to export it here."
                )
            return self.master.get("bucket") or "renders", self.master["object"]
        if isinstance(src, str) and src.startswith(BRAND_PREFIX):
            return self._brand(src[len(BRAND_PREFIX):])
        if isinstance(src, str) and src.startswith(CAPTURE_PREFIX):
            return self._capture(src[len(CAPTURE_PREFIX):])
        if isinstance(src, dict) and "transform" in src:
            raise SourceError("Editing an existing file with AI is not available yet.")
        record = _library_record(self.manifest, src)
        name = (record or {}).get("path") or (src if isinstance(src, str) else "A generated file")
        if record is None and isinstance(src, dict) and "generate" in src:
            # Only the editor tab writes a finished generation into the library. When no tab was
            # open (closed after Approve, MCP), the paid file is still in the project: find it.
            done = self._finished_generation(src)
            if done:
                return self._media_object(done, name)
        if record is None:
            raise SourceError(f"{name} is not in this project's library. Add it again, then export.")
        cloud = record.get("cloud") or {}
        media_id = cloud.get("mediaId") if cloud.get("state") == "synced" else None
        if not media_id:
            # Export chạy trên server: file chưa lên Storage thì mở project ở máy
            # kia cũng không giúp được. Ảnh/âm thanh người dùng nhập luôn rơi vào
            # đây vì bucket `media` chỉ nhận video.
            raise SourceError(
                f"{name} was only saved on the device that added it, so Export can't use it. "
                "Remove it from the clip, then export."
            )
        return self._media_object(media_id, name)

    def _finished_generation(self, declaration: dict[str, Any]) -> str | None:
        if self.generations is None:
            self.generations = self.store.done_generations(self.task.job_id)
        for row in self.generations:
            if _generation_row_matches(declaration, row, self._finished_frame_path):
                return str(row["media_asset_id"])
        return None

    def _finished_frame_path(self, declaration: dict[str, Any]) -> str | None:
        """Storage path of a nested keyframe's finished generation, owned by this task's project."""
        key = json.dumps(declaration, sort_keys=True)
        if key not in self.frame_paths:
            self.frame_paths[key] = self._lookup_frame_path(declaration)
        return self.frame_paths[key]

    def _lookup_frame_path(self, declaration: dict[str, Any]) -> str | None:
        media_id = self._finished_generation(declaration)
        row = self.store.get_media_asset(media_id) if media_id else None
        if not row or row.get("user_id") != self.task.user_id or row.get("job_id") != self.task.job_id or row.get("status") != "ready":
            return None
        return str(row.get("storage_path") or "") or None

    def _media_object(self, media_id: str, name: str) -> tuple[str, str]:
        row = self.store.get_media_asset(media_id)
        if (
            not row
            or row.get("user_id") != self.task.user_id
            or row.get("job_id") != self.task.job_id
            or row.get("status") != "ready"
            or not str(row.get("storage_path") or "").startswith("media/")
        ):
            raise SourceError(f"{name} is no longer stored with this project.")
        return "media", str(row["storage_path"])[len("media/"):]

    def _brand(self, object_name: str) -> Path:
        """Logo Brand Kit (`brand:<uid>/logo-<uuid>.png`). Document do người dùng
        ghi, nên chỉ tải đúng dạng đường dẫn và trong thư mục của CHÍNH chủ job —
        service role đọc được mọi thư mục, lớp chặn phải nằm ở đây."""
        if not BRAND_OBJECT.match(object_name) or not object_name.startswith(f"{self.task.user_id}/"):
            raise SourceError("The brand logo is not available. Apply your brand kit again, then export.")
        dest = self._path(".png")
        try:
            self.store.download_object("brand", object_name, dest, max_bytes=MAX_LOGO_BYTES)
        except Exception as exc:
            raise SourceError("The brand logo is not available. Apply your brand kit again, then export.") from exc
        return dest

    def _capture(self, capture_id: str) -> Path:
        """A page capture's screenshot. The id comes from the document, so the row must be this
        job owner's own ready capture; the path is the one the completion RPC fixed."""
        row = self.store.get_page_capture(capture_id) if CAPTURE_ID.match(capture_id) else None
        expected = f"{self.task.user_id}/{capture_id}/page.png"
        if not row or row.get("user_id") != self.task.user_id or row.get("status") != "ready" \
                or row.get("image_path") != expected:
            raise SourceError(CAPTURE_GONE)
        dest = self._path(".png")
        try:
            self.store.download_object("captures", expected, dest, max_bytes=MAX_CAPTURE_BYTES)
        except Exception as exc:
            raise SourceError(CAPTURE_GONE) from exc
        return dest

    def transcript(self, src: str) -> Path:
        dest = self._path(".json")
        if src == TRANSCRIPT:
            if not self.master.get("transcript"):
                raise SourceError(
                    "This clip was processed before server export was available. "
                    "Process the video again to export it here."
                )
            self.store.download_object(
                self.master.get("bucket") or "renders", self.master["transcript"], dest, max_bytes=MAX_SOURCE_BYTES
            )
            return dest
        edited = EDITED.match(src)
        body = self.store.get_editor_transcript(self.task.clip_id, edited.group(1)) if edited else None
        if body is None:
            raise SourceError("These captions are no longer available. Edit them again, then export.")
        dest.write_text(body, encoding="utf-8")
        return dest


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="document", failed=RENDER_FAILED, body=_run, quiet=(ExportCancelled,))


def owned_revision(store: Any, task: Task) -> tuple[dict[str, Any], dict[str, Any]]:
    """The task's job and the document of its immutable revision, after every ownership check."""
    payload = task.payload or {}
    clip = store.get_clip(task.clip_id)
    if not clip or clip.get("job_id") != task.job_id:
        raise ValueError("Clip ownership mismatch")
    job = store.get_job_row(task.job_id)
    if not job or job.get("user_id") != task.user_id:
        raise ValueError("Job ownership mismatch")
    revision = store.get_editor_revision(str(payload.get("editor_revision_id") or ""))
    if not revision or revision.get("clip_id") != task.clip_id:
        raise ValueError("Editor revision mismatch")
    document = revision.get("document")
    if not isinstance(document, dict):
        raise TypeError("Editor revision has no document")
    # The task points at the snapshot it was made from: its `source_hash` is the document's fingerprint when
    # Export was pressed (C3: the column kept its name, not its meaning), and a revision never changes.
    if payload.get("source_hash") != revision.get("source_hash"):
        raise ValueError("Editor revision hash mismatch")
    return job, document


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    if task.kind != "render_document" or not task.clip_id or not task.job_id:
        raise ValueError("Invalid render_document task")
    bucket, object_name = _canonical(task)
    payload = task.payload or {}
    resolution = int(payload.get("resolution") or 1080)
    if resolution not in (720, 1080):
        raise ValueError("Invalid resolution")
    job, document = owned_revision(store, task)

    root = ctx.root
    planned = root / "document.json"
    planned.write_text(json.dumps(document), encoding="utf-8")
    plan = json.loads(_node("plan", str(planned), str(resolution), timeout=120))
    progress = _Progress(store, task)
    progress(0.03, force=True)

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

    progress(SOURCES_DONE, force=True)
    final = root / "final.mp4"
    job_file = root / "job.json"
    spec: dict[str, Any] = {
        "document": document,
        "media": media,
        "transcripts": transcripts,
        "fonts": str(EDITOR_FONTS),
        "out": str(final),
        "resolution": resolution,
    }
    if bool(job.get("watermark", True)):
        mark = _watermark_filter(WATERMARK, int(plan["height"]))
        if mark:
            spec["videoFilter"] = mark
    job_file.write_text(json.dumps(spec), encoding="utf-8")
    _node_run(
        job_file,
        timeout=EXPORT_TIMEOUT,
        on_render=lambda part: progress(SOURCES_DONE + RENDER_SPAN * part),
        stop=ctx.lost_event,
    )
    progress(MUXED, force=True)

    produced = probe_file(str(final))
    if ctx.lost() or not store.heartbeat_task(task.id, task.attempt_id):
        return
    store.replace_object(bucket, object_name, final, content_type="video/mp4")
    output = {
        "output_path": object_name,
        "bytes": final.stat().st_size,
        "width": produced.width,
        "height": produced.height,
        "duration": produced.duration,
        "manifest": {
            "attempt_id": task.attempt_id,
            "editor_revision_id": payload.get("editor_revision_id"),
            "files": {
                "mp4": {
                    "bucket": bucket,
                    "object": object_name,
                    "bytes": final.stat().st_size,
                }
            },
        },
    }
    ctx.complete(lambda: store.complete_task(task.id, task.attempt_id, output))
