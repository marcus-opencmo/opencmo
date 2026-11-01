"""`look_check` (P6 S4): look at a finished export before its card is raised.

Contract (P6 B0; the TS side is `apps/web/lib/departments/studio/look-check.ts`, keep both in step):

Input, `tasks.payload`, written by the SQL rules when a Studio render is done:
    {"ref_kind": "editor_project" | "short_batch" | "studio_step", "ref_id": uuid, "round": 0 | 1,
     "files": [{"path": "<user>/<clip>/<task>.mp4", "clip_id": uuid}, ...]}

Output, `tasks.output`:
    {"pass": bool, "round": 0 | 1, "note": str (<= 200, English, empty on a pass),
     "files": [{"path", "clipId", "pass", "answers": [{"id", "pass": bool | None, "why", "at"?}],
                "frameTimes": [float, ...]}]}

Rules:
- Reads only the full-size export in the `exports` bucket under the task owner's folder, never
  `*.preview.mp4`, through the user-media demuxer allowlist (our own output, still never sniffed freely).
- Black, frozen and silence are found by ffmpeg filters in one streaming pass: no model, no frames in
  Python memory. At most `MAX_FRAMES` stills are drawn (`-ss` before `-i`, one ffmpeg at a time); they go
  through moderation, then the vision judge (`opencmo/ai/look_judge.py`) answers the two picture questions.
- No vision key or a judge error answers `None` (not checked), never a fail.
- Nothing is spent and nothing is uploaded: the stills live in the task's temp dir only.
"""

from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path
from typing import Any

from opencmo.ai import look_judge, moderation
from opencmo.ai.providers.base import ProviderError
from opencmo.backends.supabase import Task
from opencmo.media.ffmpeg import USER_INPUT, run
from opencmo.worker.render_document_task import EXPORTS_BUCKET, MAX_SOURCE_BYTES
from opencmo.worker.task_run import TaskContext, run_task

log = logging.getLogger(__name__)

FAILED = "The look check could not run. The card is raised without it."

#: Same cap as `look.py` `MAX_TIMES`.
MAX_FRAMES = 12
#: A shorts batch can hold up to 20 files: fewer frames each keeps the judge's cost per card flat.
BATCH_FRAMES = 4

#: (id, by) — ids shared with `LOOK_QUESTIONS` in `look-check.ts`.
QUESTIONS: tuple[tuple[str, str], ...] = (
    ("no_black_frames", "code"),
    ("no_frozen_frames", "code"),
    ("sound_present", "code"),
    ("content_allowed", "moderation"),
    ("captions_inside", "judge"),
    ("text_readable", "judge"),
)

REF_KINDS = ("editor_project", "short_batch", "studio_step")

#: A black stretch shorter than this is a cut or a fade, not a problem.
BLACK_MIN_SECONDS = 0.5
#: A picture held longer than this in a video (not a slideshow, whose slides hold on purpose).
FREEZE_MIN_SECONDS = 4.0
#: Loudest sample at or below this is silence: the export has no usable sound.
SILENT_DB = -60.0
CHECK_TIMEOUT = 600

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="look-check", failed=FAILED, body=_run)


def _input(task: Task) -> dict[str, Any]:
    payload = task.payload or {}
    ref_kind, ref_id, round_ = payload.get("ref_kind"), str(payload.get("ref_id") or ""), payload.get("round")
    files = payload.get("files")
    if ref_kind not in REF_KINDS or not re.fullmatch(_UUID, ref_id) or round_ not in (0, 1):
        raise ValueError("Invalid look_check task")
    if not isinstance(files, list) or not 1 <= len(files) <= 20:
        raise ValueError("Invalid look_check files")
    checked = []
    for entry in files:
        path, clip = str((entry or {}).get("path") or ""), str((entry or {}).get("clip_id") or "")
        # Only the owner's own full-size export: `<user>/<clip>/<task>.mp4`, never the preview file.
        if not re.fullmatch(_UUID, clip) or not re.fullmatch(rf"{re.escape(task.user_id)}/{clip}/{_UUID}\.mp4", path):
            raise ValueError("Invalid look_check file")
        checked.append({"path": path, "clip_id": clip})
    return {"ref_kind": ref_kind, "ref_id": ref_id, "round": round_, "files": checked}


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    if task.kind != "look_check":
        raise ValueError("Invalid look_check task")
    spec = _input(task)
    frames_each = BATCH_FRAMES if len(spec["files"]) > 1 else MAX_FRAMES
    results = []
    for index, entry in enumerate(spec["files"]):
        if ctx.lost():
            return
        local = ctx.root / f"export-{index}.mp4"
        store.download_object(EXPORTS_BUCKET, entry["path"], local, max_bytes=MAX_SOURCE_BYTES)
        results.append(check_file(local, ctx.root / f"frames-{index}", entry, frames_each, slideshow=spec["ref_kind"] == "studio_step"))
        local.unlink(missing_ok=True)
    output = {"pass": all(r["pass"] for r in results), "round": spec["round"], "files": results, "note": note(results)}
    if ctx.lost() or not store.heartbeat_task(task.id, task.attempt_id):
        return
    ctx.complete(lambda: store.complete_task(task.id, task.attempt_id, output))


def check_file(path: Path, workdir: Path, entry: dict[str, str], frames: int, *, slideshow: bool) -> dict[str, Any]:
    """One export: the code questions from one ffmpeg pass, then frames, moderation and the judge."""
    workdir.mkdir(parents=True, exist_ok=True)
    duration, has_audio = _probe(path)
    black, frozen, loudest = _scan(path, has_audio)
    answers: dict[str, dict[str, Any] | None] = {}

    answers["no_black_frames"] = (
        {"pass": False, "why": f"A black stretch of {black[1]:.1f} s", "at": round(black[0], 2)} if black else {"pass": True, "why": ""}
    )
    if slideshow:
        answers["no_frozen_frames"] = None  # slides hold on purpose
    else:
        answers["no_frozen_frames"] = (
            {"pass": False, "why": f"The picture freezes for {frozen[1]:.1f} s", "at": round(frozen[0], 2)} if frozen else {"pass": True, "why": ""}
        )
    if slideshow:
        answers["sound_present"] = None  # a slideshow may be silent on purpose (no music picked)
    elif not has_audio:
        answers["sound_present"] = {"pass": False, "why": "The video has no sound"}
    elif loudest is not None and loudest <= SILENT_DB:
        answers["sound_present"] = {"pass": False, "why": "The sound track is silent"}
    else:
        answers["sound_present"] = {"pass": True, "why": ""}

    times = frame_times(duration, frames)
    stills = _stills(path, workdir, times)
    answers["content_allowed"] = _moderate(stills)
    if answers["content_allowed"] and answers["content_allowed"]["pass"] is False:
        # A blocked frame is never sent on to another model.
        answers.update({q: None for q in look_judge.JUDGE_QUESTIONS})
    else:
        answers.update(look_judge.judge(stills, times[: len(stills)]))
    for still in stills:
        still.unlink(missing_ok=True)

    listed = [{"id": q, **(a if a is not None else {"pass": None, "why": ""})} for q, _ in QUESTIONS for a in [answers.get(q)]]
    return {
        "path": entry["path"],
        "clipId": entry["clip_id"],
        "pass": all(a["pass"] is not False for a in listed),
        "answers": listed,
        "frameTimes": [round(t, 2) for t in times[: len(stills)]],
    }


def frame_times(duration: float, frames: int) -> list[float]:
    """Evenly spread, each in the middle of its slice: never the very first or last frame (fades)."""
    if duration <= 0:
        return [0.0]
    n = max(1, min(frames, MAX_FRAMES, math.ceil(duration)))
    return [duration * (i + 0.5) / n for i in range(n)]


def _probe(path: Path) -> tuple[float, bool]:
    proc = run(
        ["ffprobe", "-v", "error", *USER_INPUT, "-f", "mov,mp4,m4a,3gp,3g2,mj2", "-show_entries", "format=duration:stream=codec_type",
         "-of", "json", str(path)],
        timeout=60,
    )
    info = json.loads(proc.stdout or "{}")
    duration = float((info.get("format") or {}).get("duration") or 0)
    return duration, any(s.get("codec_type") == "audio" for s in info.get("streams") or [])


_BLACK = re.compile(r"black_start:(\d+(?:\.\d+)?) black_end:(\d+(?:\.\d+)?) black_duration:(\d+(?:\.\d+)?)")
_FREEZE_START = re.compile(r"freeze_start: (\d+(?:\.\d+)?)")
_FREEZE_DURATION = re.compile(r"freeze_duration: (\d+(?:\.\d+)?)")
_MAX_VOLUME = re.compile(r"max_volume: (-?\d+(?:\.\d+)?|-inf) dB")


def _scan(path: Path, has_audio: bool) -> tuple[tuple[float, float] | None, tuple[float, float] | None, float | None]:
    """One streaming pass: the first black stretch, the first long freeze, the loudest sample (dB)."""
    args = [
        "ffmpeg", "-hide_banner", "-nostats", "-v", "info", *USER_INPUT, "-f", "mov,mp4,m4a,3gp,3g2,mj2", "-i", str(path),
        "-vf", f"blackdetect=d={BLACK_MIN_SECONDS}:pix_th=0.10,freezedetect=n=-60dB:d={FREEZE_MIN_SECONDS}",
    ]
    args += ["-af", "volumedetect"] if has_audio else ["-an"]
    args += ["-f", "null", "-"]
    err = run(args, timeout=CHECK_TIMEOUT).stderr or ""
    black = next(((float(m.group(1)), float(m.group(3))) for m in _BLACK.finditer(err)), None)
    starts, lengths = _FREEZE_START.findall(err), _FREEZE_DURATION.findall(err)
    frozen = (float(starts[0]), float(lengths[0])) if starts and lengths else None
    if starts and not lengths:
        # Frozen until the end: ffmpeg reports the start only.
        frozen = (float(starts[0]), FREEZE_MIN_SECONDS)
    volume = _MAX_VOLUME.search(err)
    loudest = None if not volume else (-math.inf if volume.group(1) == "-inf" else float(volume.group(1)))
    return black, frozen, loudest


def _stills(path: Path, workdir: Path, times: list[float]) -> list[Path]:
    out = []
    for index, at in enumerate(times):
        still = workdir / f"look-{index:02d}.jpg"
        # `-ss` BEFORE `-i` (engine rule 3): input seeking, no decode from the start.
        run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{at:.3f}", *USER_INPUT, "-f", "mov,mp4,m4a,3gp,3g2,mj2", "-i", str(path),
             "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "4", str(still)],
            timeout=60,
        )
        if still.exists():
            out.append(still)
    return out


def _moderate(stills: list[Path]) -> dict[str, Any] | None:
    """The frames through the product's content check (rule 4); `None` when the server has no checker."""
    if not stills or not moderation.ready():
        return None
    try:
        moderation.check_images(stills)
    except ProviderError as error:
        if error.retryable:
            return None
        return {"pass": False, "why": "A frame did not pass the content check"}
    return {"pass": True, "why": ""}


def _fmt(seconds: float) -> str:
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def note(results: list[dict[str, Any]]) -> str:
    """The card's note, the same words as `lookNote` in `look-check.ts`. Empty on a pass."""
    asks = dict(_ASKS)
    failed = []
    for result in results:
        for answer in result["answers"]:
            if answer["pass"] is False:
                why = answer.get("why") or asks.get(answer["id"], answer["id"])
                failed.append(f"{why} (at {_fmt(answer['at'])})" if "at" in answer else why)
    if not failed:
        return ""
    more = f" and {len(failed) - 2} more" if len(failed) > 2 else ""
    return f"Look check: {'; '.join(failed[:2])}{more}."[:200]


_ASKS = (
    ("no_black_frames", "No black stretch longer than half a second"),
    ("no_frozen_frames", "No frozen picture longer than four seconds"),
    ("sound_present", "The export has an audio track that is not silent"),
    ("content_allowed", "Every frame passes the content check"),
    ("captions_inside", "Every caption sits fully inside the frame"),
    ("text_readable", "On-screen text is readable: not garbled, cut off or too small"),
)
