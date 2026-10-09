"""Chuyển pipeline lõi thành publication nguyên tử cho web editor.

`process()` chỉ điều phối; trạng thái lượt chạy ở `job_context`, upload + dọn ở
`job_uploads`, tính tiền ở `job_billing`, nguyên liệu editor ở `job_editor`.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import (
    BUCKET,
    SOURCES_BUCKET,
    InsufficientCreditsError,
    Job,
    StaleAttemptError,
    storage_path,
)
from opencmo.config import Config
from opencmo.editing.models import transcript_from_dict
from opencmo.media.probe import probe_file
from opencmo.models import Clip, Moment, Transcript
from opencmo.pipeline import run_pipeline
from opencmo.steps.download import download_full
from opencmo.steps.download import probe as probe_source
from opencmo.steps.render import _safe_name, preview_head
from opencmo.worker.errors import UserMessageError, processing_error
from opencmo.worker.heartbeat import Heartbeat
from opencmo.worker.job_billing import settle_on_probe
from opencmo.worker.job_context import STALE_ATTEMPT, JobRun
from opencmo.worker.job_editor import EditorPrep
from opencmo.worker.job_uploads import RENDERS_BUCKET, Uploads
from opencmo.worker.media import (
    UPLOAD_UNAVAILABLE,
    UnsafeSourceError,
    UploadUnavailableError,
    resolve_web_source,
    upload_object_name,
    validate_public_url,
)

log = logging.getLogger(__name__)

__all__ = ["RENDERS_BUCKET", "chosen_moments", "process"]

PROCESSING_FAILED = "Processing failed. Please try again."
WATERMARK = os.environ.get("OPENCMO_WATERMARK", "opencmo.io")

# Cùng bảng với lựa chọn "Clip length" của web.
CLIP_LENGTHS = {
    "auto": (10.0, 60.0),
    "short": (15.0, 30.0),
    "medium": (30.0, 60.0),
    "long": (60.0, 90.0),
}


# Trần độ dài một đoạn người dùng tự chọn. Trùng số của `create_job()` và của
# route `POST /jobs` — ba chốt chặn cùng một luật, và SQL là chốt thật.
MAX_SEGMENT_SECONDS = 180.0


def chosen_moments(segments: list[dict[str, Any]]) -> list[Moment]:
    """Đoạn người dùng kéo trên thanh bar → `Moment` cho pipeline.

    KHÔNG kẹp theo độ dài video ở đây: chỗ duy nhất biết độ dài thật mà chưa tải
    một byte media nào là bước probe, và nó nằm bên trong `run_pipeline`. Hàm
    này chỉ dựng đúng hình dạng; `run_pipeline` kẹp ngay sau probe.
    """
    moments: list[Moment] = []
    for raw in sorted(segments, key=lambda s: float(s.get("start") or 0.0)):
        start = max(0.0, float(raw.get("start") or 0.0))
        end = min(max(start, float(raw.get("end") or 0.0)), start + MAX_SEGMENT_SECONDS)
        moments.append(
            Moment(
                start=start,
                end=end,
                hook=f"Clip {len(moments) + 1}",
                score=0.0,
                # Hiện trên card kết quả nên phải là tiếng Anh.
                reason="You chose this moment.",
            )
        )
    return moments


def _attempt_is_published(store: Any, job: Job) -> bool:
    row = store.get_job_row(job.id) or {}
    return row.get("status") == "done" and row.get("attempt_id") == job.attempt_id


# Trần dung lượng một video tải nguyên bản. Gói Supabase Free kẹp mỗi object ở
# 50 MB dù bucket khai 2 GB (COSTS.md), nên con số này là biến môi trường: nâng
# gói xong chỉ cần đổi nó, không phải deploy lại worker.
MAX_FULL_BYTES = int(os.environ.get("OPENCMO_MAX_FULL_BYTES") or 2 * 1024**3)

# Vài giây đầu là đủ cho một thumbnail phát được. Encode lại nguyên một video 45
# phút xuống 640p chỉ để làm hình xem trước là đổi một giờ CPU lấy một khung hình.
FULL_PREVIEW_SECONDS = 15.0

# Đủ lâu cho một lượt probe cộng một lượt cắt 15 giây qua HTTP, không lâu hơn.
SIGNED_URL_SECONDS = 1800


def _size_label(size: float) -> str:
    """Câu lỗi phải nói con số người dùng nhận ra. "0.0 GB" thì không."""
    if size >= 1024**3:
        return f"{size / 1024**3:.1f} GB"
    return f"{size / 1024**2:.0f} MB"




def _process_full(run: JobRun, output_dir: Path, *, previous: dict[str, Any] | None) -> None:
    """Chế độ "Don't clip": giao nguyên video, không cắt và không encode lại.

    Không transcript, không revision — nên trang kết quả sẽ không hiện nút
    "Edit clip" (nó đã gate theo `revision`). Đó là hành vi đúng: không có
    transcript thì editor không dựng lại được phụ đề.

    Hai đường nguồn tốn khác hẳn nhau, nên chúng KHÔNG dùng chung một đường:

      * **Link** — phải tải về đĩa worker rồi đẩy lên Storage. Không tránh được:
        byte đang nằm ở YouTube chứ không ở chỗ ta.
      * **File đã upload** — byte ĐÃ nằm trong Storage rồi. Tải về rồi đẩy lên
        lại là trả tiền egress cộng ingress cho đúng khối dữ liệu đó, và kết
        quả là lưu nó hai lần trong bảy ngày. Ở đây ta đọc metadata và cắt 15
        giây đầu qua URL có chữ ký (vài MB), rồi nhân bản object ngay trong
        Storage (không byte nào qua worker).

    Ngân sách RAM/thời gian ở ARCHITECTURE.md §2 nói về pipeline cắt clip. Nhánh
    này không decode video gốc lần nào — chỉ tải, cộng một lượt encode 15 giây
    cho hình xem trước.
    """
    store, job, root = run.store, run.job, run.root
    assert root is not None
    cfg = Config(out_dir=output_dir, work_dir=root / "work")
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    upload_source = job.source_url.startswith("storage://")

    # `video` là file trên đĩa (nguồn link); `readable` là thứ ffmpeg/ffprobe
    # đọc được — cùng một file đó, hoặc một URL có chữ ký với nguồn upload.
    video: Path | None = None
    source_object: str | None = None

    run.set_stage("probe")
    if upload_source:
        source_object = upload_object_name(job)
        readable = store.sign_object_url(SOURCES_BUCKET, source_object, SIGNED_URL_SECONDS)
        info = store.object_info(SOURCES_BUCKET, source_object)
        if info is None:
            raise UploadUnavailableError(UPLOAD_UNAVAILABLE)
        size = int(info.get("size") or 0)
        # ffprobe qua HTTP chỉ đọc phần header, không kéo cả file.
        title = Path(source_object).name
        duration = probe_file(readable).duration
    else:
        validate_public_url(job.source_url)
        meta = probe_source(job.source_url, cfg)
        title, duration = meta.title, meta.duration
        size = 0
        readable = ""
    run.check_lease()

    # Tính tiền theo phút nguồn như mọi job khác: người dùng trả cho độ dài
    # video họ đưa vào, không phải cho số clip nhận về.
    store.settle(job.id, duration, attempt_id=job.attempt_id)

    if not upload_source:
        run.set_stage("download")
        video = download_full(job.source_url, cfg, work)
        readable = str(video)
        size = video.stat().st_size
    run.check_lease()

    if size > MAX_FULL_BYTES:
        raise UserMessageError(
            f"This video is {_size_label(size)}, which is over the "
            f"{_size_label(MAX_FULL_BYTES)} download limit. Clip it instead, "
            "or use a shorter video."
        )

    run.set_stage("render")
    # Giữ hình xem trước 640px dù nó tốn thêm ~1MB: thiếu nó thì trang kết quả
    # nhúng thẳng file gốc vào thẻ <video>, và một lần bấm play là vài trăm MB
    # egress cho một thứ người dùng chỉ liếc qua.
    preview_file = preview_head(
        readable, work / "full.preview.mp4", cfg, seconds=min(FULL_PREVIEW_SECONDS, duration)
    )
    run.check_lease()

    # Retry giữ nguyên ID clip đã công bố: đổi ID là trang kết quả mất link cũ
    # và `publish_job_clip` từ chối vì vị trí 0 đã có chủ.
    clip_id = previous["id"] if previous else str(uuid.uuid4())
    name = _safe_name(0, title)

    clip_object = storage_path(job.user_id, job.id, f"{job.attempt}/{name}.mp4")
    if source_object is not None:
        store.copy_object(SOURCES_BUCKET, source_object, BUCKET, clip_object)
        run.uploads.record(BUCKET, clip_object)
    else:
        assert video is not None
        run.uploads.put(BUCKET, clip_object, video, content_type="video/mp4")

    preview_object = storage_path(job.user_id, job.id, f"{job.attempt}/{name}.preview.mp4")
    run.uploads.put(BUCKET, preview_object, preview_file, content_type="video/mp4")

    row = {
        "id": clip_id,
        "idx": 0,
        "hook": title[:120],
        "start_seconds": 0.0,
        "end_seconds": duration,
        # Không có bước chọn nên không có điểm. Bịa một con số ở đây là nói dối
        # về một thứ chưa bao giờ được chấm.
        "score": 0,
        "reason": "Delivered at its original length.",
        "storage_path": clip_object,
        "preview_path": preview_object,
    }
    if not store.publish_job_clip(job.id, job.attempt_id, row):
        raise StaleAttemptError(STALE_ATTEMPT)

    run.mark_publication_sent()
    published = store.complete_job_publication(
        job.id,
        job.attempt_id,
        title=title,
        duration=duration,
        clips=[row],
        # Không transcript thì không dựng lại được phụ đề, nên không có revision
        # nào để mở editor. Gửi danh sách rỗng chứ không gửi một revision giả.
        revisions=[],
        manifest={"attempt_id": job.attempt_id, "sections": [], "proxies": {}},
    )
    if not published:
        raise StaleAttemptError(STALE_ATTEMPT)

    # Bản sao đã công bố xong thì file nguồn không còn ai cần: nhánh này không có
    # editor để render lại, và job `done` thì không retry được. Giữ nó lại là
    # lưu cùng một video hai lần cho tới khi hết hạn.
    #
    # Xoá SAU khi publish đã commit, và nuốt lỗi: mất bản sao là mất thứ người
    # dùng vừa được giao, còn sót một file nguồn thì cron `sweepOrphanSources`
    # sẽ dọn.
    if source_object is not None:
        try:
            store.remove_objects(SOURCES_BUCKET, [source_object])
        except Exception:
            log.warning("Không xoá được nguồn %s sau khi giao", source_object, exc_info=True)


def process(store: Any, job: Job) -> None:
    """Xử lý một job đã claim; mọi ghi cuối đều được fence bằng attempt id."""
    run = JobRun(store=store, job=job, uploads=Uploads(store))

    try:
        with (
            Heartbeat(lambda: store.heartbeat(job.id, job.attempt_id), f"job-{job.id}") as heartbeat,
            tempfile.TemporaryDirectory(prefix="opencmo-job-") as tmp,
        ):
            run.heartbeat = heartbeat
            root = run.root = Path(tmp)
            output_dir = root / "clips"
            media_dir = root / "media"
            output_dir.mkdir()
            media_dir.mkdir()

            previous = {int(row["idx"]): row for row in store.list_clips(job.id)}

            # "Don't clip": không transcribe, không chọn khoảnh khắc, không
            # render lại.
            #
            # Rẽ TRƯỚC bước phân giải nguồn bên dưới, vì hai lý do. Một: nhánh
            # này không tạo artifact `moments`, nên chạy qua khối kiểm phía sau
            # là job retry chết vì thiếu một thứ nó chưa bao giờ có. Hai:
            # `resolve_web_source` TẢI NGUYÊN file upload về đĩa worker, mà
            # nhánh này không cần — nó đọc thẳng qua URL có chữ ký và nhân bản
            # object ngay trong Storage.
            if job.mode == "full":
                _process_full(run, output_dir, previous=previous.get(0))
                log.info(
                    "Job %s giao nguyên video xong sau %.2fs",
                    job.id, time.monotonic() - run.started,
                )
                return

            source_url = job.source_url
            if source_url.startswith("storage://"):
                source_url = str(
                    resolve_web_source(store, job, 0.0, 0.001, media_dir, Config()).path
                )
            else:
                validate_public_url(source_url)

            cached_transcript = None
            selected = chosen_moments(job.segments) if job.segments else None
            if previous:
                artifacts = store.list_artifacts(job.id, "moments")
                if not artifacts:
                    raise RuntimeError("The saved clip selection is unavailable.")
                transcripts = store.list_artifacts(job.id, "transcript")
                if transcripts:
                    cached_transcript = transcript_from_dict(transcripts[-1]["data"])
                selected = [Moment(**item) for item in artifacts[-1]["data"]["moments"]]
                for index, row in previous.items():
                    if index >= len(selected) or (
                        float(row["start_seconds"]) != selected[index].start
                        or float(row["end_seconds"]) != selected[index].end
                    ):
                        raise RuntimeError("The saved clip selection has changed.")
            rows_by_index = dict(previous)
            # Transcript của CẢ video, thang thời gian gốc. `EditorPrep.prepare`
            # cắt lại nó theo từng master. Khởi tạo bằng bản cache vì nhánh
            # retry không transcribe lại, nên không emit artifact lần nữa.
            transcript_full: Transcript | None = cached_transcript

            clip_min, clip_max = CLIP_LENGTHS.get(job.clip_length, CLIP_LENGTHS["auto"])
            cfg = Config(
                out_dir=output_dir,
                work_dir=root / "work",
                watermark=WATERMARK if job.watermark else None,
                aspect=job.aspect,
                layout=job.layout,
                captions=job.captions,
                clip_min_seconds=clip_min,
                clip_max_seconds=clip_max,
            )
            editor = EditorPrep(run, cfg, previous)

            def on_artifact(kind: str, data: dict[str, Any]) -> None:
                nonlocal transcript_full
                if kind == "transcript":
                    transcript_full = transcript_from_dict(data)
                store.put_artifact(job.id, job.attempt_id, kind, data)

            def on_clip(clip: Clip) -> None:
                run.check_lease()
                editor.framing[clip.index] = (clip.layout, clip.focus_x)
                if clip.index in rows_by_index:
                    return
                clip_file = Path(clip.path)
                clip_object = run.uploads.put(
                    BUCKET,
                    storage_path(job.user_id, job.id, f"{job.attempt}/{clip_file.name}"),
                    clip_file,
                    content_type="video/mp4",
                )
                preview_object = None
                if clip.preview_path:
                    preview_file = Path(clip.preview_path)
                    preview_object = run.uploads.put(
                        BUCKET,
                        storage_path(job.user_id, job.id, f"{job.attempt}/{preview_file.name}"),
                        preview_file,
                        content_type="video/mp4",
                    )
                row = {
                    "id": editor.clip_ids[clip.index], "idx": clip.index,
                    "hook": clip.moment.hook, "start_seconds": clip.moment.start,
                    "end_seconds": clip.moment.end, "score": clip.moment.score,
                    "reason": clip.moment.reason, "storage_path": clip_object,
                    "preview_path": preview_object,
                }
                if not store.publish_job_clip(job.id, job.attempt_id, row):
                    raise StaleAttemptError(STALE_ATTEMPT)
                rows_by_index[clip.index] = row
                log.info("Job %s clip %d tải được sau %.2fs", job.id, clip.index, time.monotonic() - run.started)

            result = run_pipeline(
                source_url,
                cfg,
                clip_count=job.clips_requested,
                moments=selected,
                cached_transcript=cached_transcript,
                on_clip=on_clip,
                skip_indices=set(previous),
                on_probe=lambda source: settle_on_probe(run, source),
                on_progress=run.set_stage,
                on_artifact=on_artifact,
                on_sections=editor.on_sections,
            )
            # Callback là đường chính; vòng này giữ tương thích adapter pipeline.
            for clip in result.clips:
                on_clip(clip)
            if len(rows_by_index) != len(editor.clip_ids):
                raise RuntimeError("Pipeline returned a different number of clips and sections.")

            store.put_artifact(
                job.id,
                job.attempt_id,
                "face_track",
                {"version": 1, "clips": editor.tracks},
            )
            manifest = editor.prepare(transcript_full)
            rows = [rows_by_index[index] for index in sorted(rows_by_index)]

            run.mark_publication_sent()
            published = store.complete_job_publication(
                job.id,
                job.attempt_id,
                title=result.source.title,
                duration=result.source.duration,
                clips=rows,
                revisions=manifest.revisions,
                manifest={
                    "attempt_id": job.attempt_id,
                    "sections": manifest.sections,
                    "proxies": manifest.proxies,
                    "masters": manifest.masters,
                },
            )
            if not published:
                raise StaleAttemptError(STALE_ATTEMPT)
            log.info("Job %s xong: %d clip sau %.2fs", job.id, len(rows), time.monotonic() - run.started)

    except StaleAttemptError:
        log.warning("Job %s attempt %s đã mất lease", job.id, job.attempt_id)
        run.uploads.cleanup(job.id)
    except InsufficientCreditsError as exc:
        store.fail(job.id, job.attempt_id, str(exc))
        run.uploads.cleanup(job.id)
    except UploadUnavailableError:
        store.fail(job.id, job.attempt_id, UPLOAD_UNAVAILABLE)
        run.uploads.cleanup(job.id)
    except UnsafeSourceError as exc:
        store.fail(job.id, job.attempt_id, str(exc))
        run.uploads.cleanup(job.id)
    except TransientError:
        # Sau timeout của publication, chỉ DB mới biết giao dịch đã commit hay
        # chưa. Không fail/xoá khi chưa đọc lại được trạng thái canonical.
        if run.publication_sent:
            row = store.get_job_row(job.id)
            if row and row.get("status") == "done" and row.get("attempt_id") == job.attempt_id:
                return
            if not row or row.get("attempt_id") != job.attempt_id or row.get("status") != "running":
                run.uploads.cleanup(job.id)
        raise
    except Exception as exc:
        log.exception("Job %s lỗi", job.id)
        if run.publication_sent and _attempt_is_published(store, job):
            return
        store.fail(job.id, job.attempt_id, processing_error(exc, run.stage))
        run.uploads.cleanup(job.id)
