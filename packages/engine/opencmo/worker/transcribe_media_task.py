"""Phụ đề cho một file thư viện bất kỳ (E4-e, học Palmier add_captions).

Tải file đã lên Storage (bucket `media`), rút audio mono 16 kHz CHỈ đoạn
sourceIn…sourceOut mà phần tử đang dùng (không transcribe phần không chiếu, không trả
tiền cho nó), Groq Whisper, rồi `complete_media_captions` ghi transcript vào
`editor_transcripts`. Mốc được dời về giây của FILE — cùng thang với `sourceIn` của lớp
`captions` — nên phụ đề khớp dù đoạn chọn không bắt đầu từ 0.

Credit đã trừ lúc tạo task; `fail_task` kích trigger hoàn credit, nên mọi lỗi ở đây chỉ
cần báo bằng câu tiếng Anh (hiện thẳng trong app).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from opencmo.backends.supabase import Task
from opencmo.config import Config
from opencmo.editing.subtitles import to_ds_transcript
from opencmo.media.ffmpeg import extract_audio
from opencmo.models import TranscriptSegment, Word
from opencmo.steps.transcribe import transcribe_audio
from opencmo.worker.render_document_task import MAX_SOURCE_BYTES
from opencmo.worker.task_run import TaskContext, TaskError, run_task

# Các câu dưới hiện thẳng trong app — tiếng Anh. Credit luôn được hoàn khi task hỏng.
FAILED = "Could not create captions. Your credits were refunded."
NO_AUDIO = "This file has no audio track to caption. Your credits were refunded."
NO_SPEECH = "No speech found in this part of the file. Your credits were refunded."
GONE = "This file is no longer stored with this project. Your credits were refunded."
TOO_LONG = "This part of the file is too long to caption at once. Trim it and try again."


class _UserError(TaskError):
    pass


def shift_segments(segments: list[TranscriptSegment], offset: float) -> list[TranscriptSegment]:
    """Mốc của Whisper tính từ đầu đoạn audio đã cắt; dời về giây của file gốc."""
    return [
        TranscriptSegment(
            start=segment.start + offset,
            end=segment.end + offset,
            text=segment.text,
            words=[Word(word.start + offset, word.end + offset, word.text) for word in segment.words]
            if segment.words
            else None,
        )
        for segment in segments
    ]


def process(store: Any, task: Task) -> None:
    run_task(store, task, name="captions", failed=FAILED, body=_run)


def _run(ctx: TaskContext) -> None:
    store, task = ctx.store, ctx.task
    if task.kind != "transcribe_media" or not task.clip_id or not task.job_id or not task.asset_id:
        raise ValueError("Invalid transcribe_media task")
    payload = task.payload or {}
    start = max(0.0, float(payload.get("source_in") or 0.0))
    end = float(payload.get("source_out") or 0.0)
    if end - start < 0.5:
        raise ValueError("Invalid caption range")

    row = store.get_media_asset(task.asset_id)
    if (
        not row
        or row.get("user_id") != task.user_id
        or row.get("job_id") != task.job_id
        or row.get("status") != "ready"
        or not str(row.get("storage_path") or "").startswith("media/")
    ):
        raise _UserError(GONE)

    path = str(row["storage_path"])
    source = ctx.root / f"source{Path(path).suffix or '.bin'}"
    store.download_object("media", path[len("media/"):], source, max_bytes=MAX_SOURCE_BYTES)
    audio = ctx.root / "audio.m4a"
    try:
        extract_audio(source, audio, start=start, duration=end - start)
    except Exception as exc:
        raise _UserError(NO_AUDIO) from exc
    try:
        transcript = transcribe_audio(audio, Config())
    except RuntimeError as exc:
        if str(exc).startswith("Audio is too large"):
            raise _UserError(TOO_LONG) from exc
        raise
    segments = shift_segments(transcript.segments, start)
    if not segments:
        raise _UserError(NO_SPEECH)
    ctx.complete(lambda: store.complete_media_captions(task.id, task.attempt_id, to_ds_transcript(segments)))
