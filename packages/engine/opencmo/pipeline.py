"""Điều phối toàn bộ pipeline clipping.

Thứ tự các bước không tùy tiện — nó là tối ưu quan trọng nhất của dự án.
Xem ARCHITECTURE.md §3:

    probe → phụ đề (hoặc audio → Whisper) → LLM chọn → tải ĐÚNG đoạn cần → render

Video 45 phút vì thế chỉ tốn ~90MB băng thông thay vì ~1GB.

Khi người dùng TỰ chọn đoạn (`moments=`), thứ tự đổi lại một lần nữa:

    probe → tải đúng đoạn đã chọn → transcript CỦA RIÊNG các đoạn đó → render

Hai bước đắt nhất — transcribe cả video và gọi LLM — chỉ tồn tại để trả lời câu
hỏi "cắt đoạn nào". Người dùng trả lời sẵn thì cả hai rời khỏi đường tới hạn, và
thời gian chờ rơi từ vài phút xuống vài chục giây.
"""

from __future__ import annotations

import contextlib
import logging
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .config import Config
from .editing.models import ARTIFACT_VERSION, transcript_to_dict
from .media import encoder as encoder_mod
from .media.ffmpeg import extract_audio, require_binaries
from .models import (
    Clip,
    JobResult,
    Moment,
    SourceInfo,
    Timings,
    Transcript,
    TranscriptSegment,
    Word,
)
from .quality import fallback_moments, speech_coverage, transcript_has_enough_speech
from .steps import download, local, render, select, transcribe

log = logging.getLogger(__name__)


@contextlib.contextmanager
def _workspace(cfg: Config):
    if cfg.work_dir is not None:
        cfg.work_dir.mkdir(parents=True, exist_ok=True)
        yield cfg.work_dir
    else:
        with tempfile.TemporaryDirectory(prefix="opencmo-") as tmp:
            yield Path(tmp)



def _clamp_moments(moments: list[Moment], duration: float) -> list[Moment]:
    """Kẹp các đoạn đã chọn vào độ dài THẬT của video.

    Độ dài trình duyệt thấy (player YouTube) và độ dài yt-dlp báo lệch nhau được
    vài giây. `-ss` quá đuôi file cho ra clip KHÔNG CÓ FRAME VIDEO NÀO — file
    mp4 vẫn ra, vẫn đúng dung lượng, vẫn mở được. Đúng loại lỗi im lặng mà
    CLAUDE.md cảnh báo, nên chặn ngay sau probe thay vì để bước render vấp phải.

    Đoạn bị kẹp còn dưới một giây thì bỏ hẳn: một clip rỗng tệ hơn một clip thiếu.
    """
    # Chừa nửa giây cuối như `local.download_sections` — frame cuối cùng của một
    # file hay không decode được.
    last = max(0.0, duration - 0.5)
    kept: list[Moment] = []
    for m in moments:
        start = min(max(0.0, m.start), last)
        end = min(max(start, m.end), last)
        if end - start < 1.0:
            log.warning("Bỏ đoạn %.1f–%.1fs: nằm ngoài video dài %.1fs", m.start, m.end, duration)
            continue
        kept.append(Moment(start=start, end=end, hook=m.hook, score=m.score, reason=m.reason))
    if not kept:
        # Tiếng Anh: câu này đi thẳng vào `jobs.error` rồi lên màn hình.
        raise ValueError("The moments you picked fall outside this video.")
    return kept



def _shift(segments: list[TranscriptSegment], offset: float) -> list[TranscriptSegment]:
    """Dời transcript của một đoạn về gốc thời gian của VIDEO NGUỒN.

    Mốc từng từ phải dời cùng segment, nếu không phần nhấn lệch đúng bằng
    `offset` — và lệch phụ đề là loại lỗi im lặng: file mp4 vẫn ra, vẫn mở được,
    chữ vẫn hiện, chỉ là sai nhịp.
    """
    return [
        TranscriptSegment(
            start=s.start + offset,
            end=s.end + offset,
            text=s.text,
            words=(
                [Word(start=w.start + offset, end=w.end + offset, text=w.text) for w in s.words]
                if s.words
                else None
            ),
        )
        for s in segments
    ]


def _transcript_for_moments(
    src: Any,
    url: str,
    moments: list[Moment],
    sections: list[tuple[Path, float]],
    cfg: Config,
    work_dir: Path,
) -> Transcript:
    """Transcript cho nhánh người dùng tự chọn đoạn.

    Thử phụ đề có sẵn TRƯỚC: vài KB, miễn phí, và đã theo gốc thời gian của
    video nên dùng được ngay.

    Không có thì trích audio từ ĐOẠN ĐÃ TẢI VỀ chứ không tải lại audio của cả
    video — 40 giây thay vì 45 phút, và đó là toàn bộ lý do nhánh này tồn tại.
    `lead_in` là phần đệm ở đầu file section, nên cắt từ đó ra đúng cửa sổ người
    dùng đã chọn, với cả nguồn yt-dlp lẫn nguồn local.
    """
    subs = src.fetch_subtitles(url, cfg, work_dir)
    if subs is not None:
        return subs

    segments: list[TranscriptSegment] = []
    language = "en"
    for index, (moment, (section_path, lead_in)) in enumerate(
        zip(moments, sections, strict=True)
    ):
        audio = extract_audio(
            section_path,
            work_dir / f"section_{index:02d}.m4a",
            start=lead_in,
            duration=moment.duration,
        )
        part = transcribe.transcribe_audio(audio, cfg)
        audio.unlink(missing_ok=True)
        language = part.language
        segments.extend(_shift(part.segments, moment.start))

    return Transcript(segments=segments, language=language, source="scribe")


def run_pipeline(
    url: str,
    cfg: Config,
    *,
    clip_count: int = 5,
    moments: list[Moment] | None = None,
    cached_transcript: Transcript | None = None,
    on_clip: Callable[[Clip], None] | None = None,
    skip_indices: set[int] | None = None,
    on_probe: Callable[[SourceInfo], None] | None = None,
    on_progress: Callable[[str], None] | None = None,
    on_artifact: Callable[[str, dict[str, Any]], None] | None = None,
    on_sections: Callable[
        [list[Any], list[tuple[Path, float]]], list[Any] | None
    ]
    | None = None,
) -> JobResult:
    """Chạy toàn bộ pipeline cho một URL.

    `on_probe` được gọi ngay sau bước probe, trước khi tải bất cứ thứ gì. Đây là
    chỗ duy nhất biết độ dài video mà chưa tốn băng thông — worker dùng nó để
    đối soát credit và dừng sớm nếu người dùng không đủ số dư. Callback ném
    exception thì pipeline dừng ngay tại đó.

    `on_artifact(kind, data)` nhận source/transcript/moments/render_settings
    NGAY khi có, trước khi thư mục tạm bị xoá và kể cả khi bước sau hỏng: mở
    editor hay chạy lại không phải transcribe lần nữa.

    `moments` là các đoạn NGƯỜI DÙNG đã chọn. Truyền vào thì bước LLM chọn bị bỏ
    hẳn, và transcript được lấy SAU khi tải, chỉ cho riêng các đoạn đó. Để None
    thì pipeline tự chọn khoảnh khắc như cũ.

    `on_sections` chạy sau khi các section đã tải xong. Trả về danh sách
    `FaceTrack` (một phần tử cho mỗi section, theo đúng thứ tự) thì bước render
    dùng lại luôn thay vì bám mặt lần nữa — worker web đã lấy mẫu để lưu
    artifact rồi. Trả `None` thì render tự lấy mẫu như đường CLI.
    """
    if moments is not None:
        # Số clip LÀ số đoạn đã chọn; `clip_count` không còn nghĩa ở nhánh này.
        clip_count = len(moments)
        if any(m.end <= m.start for m in moments):
            raise ValueError("Each selected moment must end after it starts.")
    if not 1 <= clip_count <= 10:
        raise ValueError("Choose between 1 and 10 clips.")
    progress = on_progress or (lambda stage: None)
    emit = on_artifact or (lambda kind, data: None)
    progress("probe")
    require_binaries()
    timings = Timings()

    enc = encoder_mod.detect(cfg.encoder)
    log.info("Encoder: %s", enc)

    # Nguồn local phơi ra đúng bốn tên hàm như `download`, nên chỉ cần chọn
    # module ở đây — thân pipeline bên dưới không phải biết mình đang đọc từ đâu.
    src = local if local.is_local_source(url) else download

    with _workspace(cfg) as work_dir:
        # 1. Metadata — vài KB, chưa tải media.
        t0 = time.monotonic()
        source = src.probe(url, cfg)
        timings.probe = time.monotonic() - t0
        log.info("Nguồn: %s (%.0fs) — %s", source.title, source.duration, source.extractor)
        emit("source", {"version": ARTIFACT_VERSION, **asdict(source)})
        if on_probe is not None:
            on_probe(source)
        if moments is not None:
            moments = _clamp_moments(moments, source.duration)

        if moments is None:
            # 2. Transcript. Thử phụ đề sẵn có trước: nhanh hơn và miễn phí.
            progress("transcribe")
            t0 = time.monotonic()
            transcript = src.fetch_subtitles(url, cfg, work_dir)
            if transcript is None:
                log.info("Không có phụ đề sẵn — tải audio để transcribe.")
                audio = src.download_audio(url, cfg, work_dir)
                transcript = transcribe.transcribe_audio(audio, cfg)
                audio.unlink(missing_ok=True)
            timings.transcript = time.monotonic() - t0

            emit("transcript", transcript_to_dict(transcript))

            # 3. LLM chọn khoảnh khắc.
            t0 = time.monotonic()
            progress("select")
            if transcript_has_enough_speech(transcript, source.duration):
                moments = select.select_moments(
                    transcript, cfg, count=clip_count, source_duration=source.duration
                )
            else:
                log.info(
                    "Video có ít hoặc không có lời nói — chọn %d cửa sổ phân bố đều.",
                    clip_count,
                )
                moments = fallback_moments(
                    source.duration,
                    clip_count,
                    cfg.clip_min_seconds,
                    cfg.clip_max_seconds,
                )
            timings.select = time.monotonic() - t0
            if not moments:
                raise RuntimeError("The model did not find any usable moments in this video.")

            # 4. Chỉ tải đúng những đoạn đã chọn.
            t0 = time.monotonic()
            progress("download")
            sections = src.download_sections(url, moments, cfg, work_dir)
            timings.download = time.monotonic() - t0
        else:
            # Người dùng đã chọn đoạn: tải trước, transcribe sau, và chỉ
            # transcribe đúng những đoạn đó. `timings.select` bằng 0 ở đây là số
            # đúng chứ không phải số thiếu — bước đó không chạy.
            t0 = time.monotonic()
            progress("download")
            sections = src.download_sections(url, moments, cfg, work_dir)
            timings.download = time.monotonic() - t0

            progress("transcribe")
            t0 = time.monotonic()
            transcript = cached_transcript if cached_transcript is not None else _transcript_for_moments(
                src, url, moments, sections, cfg, work_dir
            )
            timings.transcript = time.monotonic() - t0

            # KHÔNG ném lỗi khi đoạn ít lời nói. Ở nhánh AI, transcript thưa
            # nghĩa là LLM sắp chọn bừa nên dừng sớm là đúng; ở đây người dùng
            # đã tự chỉ vào đoạn này, từ chối cắt nó là hành vi thù địch. Clip
            # vẫn ra, chỉ là không có phụ đề.
            windows = [(m.start, m.end) for m in moments]
            coverage, considered, _ = speech_coverage(transcript, source.duration, windows)
            if considered > 0 and coverage / considered < 0.08:
                log.warning(
                    "Đoạn đã chọn gần như không có lời nói (%.0f%% độ phủ) — "
                    "clip sẽ không có phụ đề.",
                    100 * coverage / considered,
                )
            emit("transcript", transcript_to_dict(transcript))

        emit("moments", {"version": ARTIFACT_VERSION, "moments": [asdict(m) for m in moments]})
        tracks: list[Any] | None = None
        if on_sections is not None:
            progress("reframe")
            tracks = on_sections(moments, sections)

        # 5. Render.
        t0 = time.monotonic()
        progress("render")
        emit(
            "render_settings",
            {
                "version": ARTIFACT_VERSION,
                "width": cfg.clip_width,
                "height": cfg.clip_height,
                "aspect": cfg.aspect,
                # `layout` ở đây vẫn có thể là "auto": nó chỉ giải được cho
                # TỪNG clip, sau khi bám mặt chạy trên đúng cửa sổ của clip đó.
                # Ghi giá trị đã giải của một clip vào artifact chung của job là
                # nói dối về các clip còn lại.
                "layout": cfg.layout,
                "captions": cfg.captions,
                "watermark": cfg.watermark,
                "face_tracking": cfg.face_tracking,
                "encoder": enc.name,
            },
        )
        render_options: dict[str, Any] = {}
        if on_clip is not None:
            render_options["on_clip"] = on_clip
        if skip_indices:
            render_options["skip_indices"] = skip_indices
        clips = render.render_all(
            sections, moments, transcript, cfg, enc, cfg.out_dir, work_dir, tracks,
            **render_options,
        )
        timings.render = time.monotonic() - t0

    return JobResult(
        source=source,
        clips=clips,
        timings=timings,
        transcript_source=transcript.source,
    )
