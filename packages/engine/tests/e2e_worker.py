"""Worker cho E2E trên trình duyệt: giống bản thật, trừ bước gọi AI.

    SUPABASE_URL=http://127.0.0.1:54321 \\
    SUPABASE_SERVICE_ROLE_KEY=... \\
    packages/engine/.venv312/bin/python -m tests.e2e_worker

Vì sao là một file RIÊNG trong `tests/` chứ không phải một cờ trong worker:
một cờ "fake AI" nằm trong code production là thứ sẽ có mặt trên máy chủ thật,
và chỉ cần một biến môi trường đặt nhầm là job của người dùng được cắt bằng
transcript giả. Ở đây nó không thể bật nhầm — file này không nằm trong package.

Hai chốt an toàn: chỉ nhận Supabase loopback, và bắt buộc `OPENCMO_E2E=1`.
Mọi bước còn lại — publication, proxy, bám mặt, preview, export, probe B-roll,
ZIP — chạy bằng ĐÚNG code của worker thật; đó là thứ E2E cần kiểm.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from opencmo.backends.supabase import SupabaseStore
from opencmo.models import (
    Clip,
    JobResult,
    Moment,
    SourceInfo,
    Timings,
    Transcript,
    TranscriptSegment,
    Word,
)
from opencmo.worker import kinds, loop, process_job, transcribe_media_task

log = logging.getLogger("opencmo.e2e")

LOOPBACK = {"127.0.0.1", "localhost", "::1", "host.docker.internal"}


def _fixture_pipeline(source: str, cfg, **callbacks):
    """Thay bước transcribe/select bằng dữ liệu cố định, giữ nguyên phần render.

    Transcript có `words` để editor thử được nhấn từng từ và cắt câu — thiếu nó
    thì nửa số thao tác trong `clip-flow.spec.ts` không có gì để bấm vào.
    """
    duration = 30.0
    info = SourceInfo(source, "E2E fixture", duration)
    callbacks["on_probe"](info)

    words = [
        {"start": 0.4 + index * 0.4, "end": 0.8 + index * 0.4, "text": word}
        for index, word in enumerate(["we", "built", "this", "in", "a", "single", "weekend"])
    ]
    transcript = {
        "version": 1,
        "language": "en",
        "source": "subs",
        "segments": [{"start": 0.4, "end": 3.6, "text": "we built this in a single weekend",
                      "words": words}],
    }
    moment = Moment(0.0, 8.0, "We built this in a weekend", 9.0, "fixture")

    callbacks["on_progress"]("transcribe")
    callbacks["on_artifact"]("source", {"version": 1, "url": source, "title": info.title,
                                        "duration": duration})
    callbacks["on_artifact"]("transcript", transcript)
    callbacks["on_progress"]("select")
    callbacks["on_artifact"](
        "moments",
        {"version": 1, "moments": [{"start": moment.start, "end": moment.end,
                                    "hook": moment.hook, "reason": moment.reason,
                                    "score": moment.score}]},
    )
    callbacks["on_progress"]("render")
    callbacks["on_artifact"]("render_settings", {"version": 1, "width": cfg.clip_width,
                                                 "height": cfg.clip_height,
                                                 "watermark": cfg.watermark,
                                                 "encoder": "libx264"})

    tracks = callbacks["on_sections"]([moment], [(Path(source), 0.0)])

    out = Path(cfg.out_dir) / "00-we-built-this-in-a-weekend.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-ss", "0", "-i", source, "-t", "8",
            "-vf", (
                f"scale={cfg.clip_width}:{cfg.clip_height}:force_original_aspect_ratio=increase,"
                f"crop={cfg.clip_width}:{cfg.clip_height}"
            ),
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(out),
        ],
        check=True,
    )
    log.info("Fixture render xong (%d track)", len(tracks or []))
    clip = Clip(0, moment, str(out))
    if 0 not in callbacks.get("skip_indices", set()):
        callbacks["on_clip"](clip)
    return JobResult(info, [clip], Timings())


def _fixture_transcribe(audio: Path, cfg) -> Transcript:
    """Thay Groq cho phụ đề file thư viện: audio vẫn phải rút được bằng ffmpeg thật."""
    assert audio.stat().st_size > 0
    words = [Word(0.2 + index * 0.4, 0.55 + index * 0.4, word) for index, word in enumerate(["b-roll", "has", "its", "own", "voice"])]
    return Transcript(segments=[TranscriptSegment(0.2, 2.15, "b-roll has its own voice", words)], language="en", source="whisper")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if os.environ.get("OPENCMO_E2E") != "1":
        print("Cần OPENCMO_E2E=1. File này chỉ dành cho stack test.", file=sys.stderr)
        return 2

    url = os.environ.get("SUPABASE_URL", "")
    host = urlparse(url).hostname or ""
    if host not in LOOPBACK:
        print(
            f"SUPABASE_URL trỏ tới {host or '(trống)'} — runner fixture chỉ chạy với "
            "Supabase loopback, không bao giờ với dữ liệu thật.",
            file=sys.stderr,
        )
        return 2
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not service_role_key:
        print("Thiếu SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 2

    process_job.run_pipeline = _fixture_pipeline  # type: ignore[assignment]
    transcribe_media_task.transcribe_audio = _fixture_transcribe  # type: ignore[assignment]

    loop.run_forever(
        lambda: SupabaseStore(url, service_role_key),
        # Cùng bảng với worker thật (task-kinds.json): thiếu handler thì nút Export
        # chờ mãi mà không có lỗi nào. Generate chạy FakeProvider khi run.ts đặt
        # OPENCMO_AI_FAKE=1; transcript cố định qua `_fixture_transcribe`.
        {"job": process_job.process, **kinds.handlers()},
        poll_seconds=1,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
