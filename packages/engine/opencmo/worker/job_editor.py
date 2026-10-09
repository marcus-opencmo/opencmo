"""Nguyên liệu editor của một job clip: track bám mặt, section, proxy, master, revision #1.

Hai nhịp, cùng một đối tượng vì nhịp sau đọc thứ nhịp trước ghi:
  1. `on_sections` — pipeline gọi khi các đoạn nguồn đã tải xong, TRƯỚC render.
  2. `prepare` — sau khi mọi clip đã công bố, dựng proxy/master để mở editor.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from opencmo.backends.supabase import SOURCES_BUCKET
from opencmo.config import Config
from opencmo.editing.models import default_settings, settings_hash
from opencmo.editing.subtitles import to_ds_transcript
from opencmo.media.frame import ASPECT_SIZES
from opencmo.media.probe import probe_file
from opencmo.models import Transcript
from opencmo.steps.download import SECTION_PAD
from opencmo.steps.reframe import FaceTrack, editor_focus, face_track
from opencmo.worker.job_context import JobRun
from opencmo.worker.job_uploads import RENDERS_BUCKET
from opencmo.worker.media import make_editor_master, make_editor_proxy


@dataclass
class EditorManifest:
    """Thứ `complete_job_publication` ghi cùng clip, trong một giao dịch."""

    sections: list[dict[str, Any]] = field(default_factory=list)
    proxies: dict[str, dict[str, Any]] = field(default_factory=dict)
    masters: dict[str, dict[str, Any]] = field(default_factory=dict)
    revisions: list[dict[str, Any]] = field(default_factory=list)


class EditorPrep:
    def __init__(self, run: JobRun, cfg: Config, previous: dict[int, dict[str, Any]]) -> None:
        self.run = run
        self.cfg = cfg
        self.previous = previous
        # Id clip theo thứ tự moment: giữ id cũ khi retry để link đã công bố còn sống.
        self.clip_ids: list[str] = []
        self.tracks: dict[str, list[list[float]]] = {}
        # Khung thật của từng clip, do `render_clip` báo lại: `layout="auto"`
        # chỉ giải được sau khi bám mặt chạy trên đúng cửa sổ của clip đó.
        self.framing: dict[int, tuple[str, float]] = {}
        self._sections: list[tuple[Any, Path, float, Any, float, float]] = []

    def on_sections(
        self, moments: list[Any], sections: list[tuple[Path, float]]
    ) -> list[FaceTrack | None]:
        # Track trả về cho pipeline để bước render dùng lại. Không trả
        # thì MediaPipe chạy lần hai trên đúng section, đúng cửa sổ —
        # phần đắt nhất của render, trong ngân sách 3 phút không dư.
        previous = self.previous
        sampled_tracks: list[FaceTrack | None] = []
        for index, (moment, (section_path, lead_in)) in enumerate(
            zip(moments, sections, strict=True)
        ):
            self.run.check_lease()
            if index in previous and (
                float(previous[index]["start_seconds"]) != moment.start
                or float(previous[index]["end_seconds"]) != moment.end
            ):
                raise RuntimeError("The source changed since these clips were created.")
            clip_id = previous[index]["id"] if index in previous else str(uuid.uuid4())
            self.clip_ids.append(clip_id)
            offset = max(0.0, float(moment.start) - float(lead_in))
            info = probe_file(str(section_path))

            sample_start = max(0.0, float(lead_in) - SECTION_PAD)
            sample_duration = min(
                info.duration - sample_start,
                float(moment.end) - float(moment.start) + 2 * SECTION_PAD,
            )
            sampled = (
                face_track(
                    section_path,
                    sample_fps=self.cfg.face_sample_fps,
                    start=sample_start,
                    duration=sample_duration,
                )
                if self.cfg.face_tracking
                else FaceTrack([])
            )
            sampled_tracks.append(sampled)
            self.tracks[clip_id] = [
                [float(timestamp) + offset, float(x), float(area)]
                for timestamp, x, area in sampled
            ]

            self._sections.append(
                (moment, section_path, offset, info, sample_start, sample_duration)
            )

        return sampled_tracks

    def prepare(self, transcript_full: Transcript | None) -> EditorManifest:
        """`transcript_full` là transcript của CẢ video, thang thời gian gốc; mỗi
        master nhận đúng lát của nó."""
        run, job, root = self.run, self.run.job, self.run.root
        assert root is not None
        out = EditorManifest()
        run.set_stage("prepare_editor")
        for index, (moment, section_path, offset, info, sample_start, sample_duration) in enumerate(self._sections):
            run.check_lease()
            clip_id = self.clip_ids[index]
            if job.source_url.startswith(("http://", "https://")):
                section_object = (
                    f"{job.user_id}/{job.id}/sections/{job.attempt_id}/"
                    f"{round(offset * 1000)}-{round((offset + info.duration) * 1000)}.mp4"
                )
                run.uploads.put(SOURCES_BUCKET, section_object, section_path, content_type="video/mp4")
                out.sections.append(
                    {
                        "bucket": SOURCES_BUCKET,
                        "object": section_object,
                        "bytes": section_path.stat().st_size,
                        "start": offset,
                        "end": offset + info.duration,
                        "offset": offset,
                        "duration": info.duration,
                        "attempt_id": job.attempt_id,
                    }
                )

            proxy_file = root / f"proxy-{index}.mp4"
            make_editor_proxy(
                section_path,
                proxy_file,
                start=sample_start,
                duration=sample_duration,
            )
            proxy_object = (
                f"{job.user_id}/{job.id}/proxy/{job.attempt_id}/{clip_id}.mp4"
            )
            run.uploads.put(SOURCES_BUCKET, proxy_object, proxy_file, content_type="video/mp4")
            proxy_info = probe_file(str(proxy_file))
            out.proxies[clip_id] = {
                "bucket": SOURCES_BUCKET,
                "object": proxy_object,
                "bytes": proxy_file.stat().st_size,
                # Canvas cần CẢ hai chiều để đặt khung crop: thiếu width
                # thì client phải đoán tỉ lệ nguồn, và đoán sai với
                # video 4:3 hay video đã dọc.
                "width": proxy_info.width,
                "height": proxy_info.height,
                "duration": proxy_info.duration,
                "offset": offset + sample_start,
            }

            # ---------------------------------------- master cho editor
            #
            # Cùng cửa sổ với proxy, nhưng ở độ phân giải NGUỒN và bằng
            # một lượt `-c copy`: editor mới render trong trình duyệt,
            # nên nó cần pixel thật chứ không phải bản 540p để tua.
            # Proxy ở lại cho clip cũ và cho editor cũ (Phase 5 gỡ).
            master_file = root / f"master-{index}.mp4"
            begin = make_editor_master(
                section_path,
                master_file,
                start=sample_start,
                duration=sample_duration,
            )
            master_info = probe_file(str(master_file))
            # Giây 0 của master trên thang VIDEO GỐC. `begin` là mép
            # keyframe thật, không phải `sample_start` — chênh lệch đó
            # là thứ `sourceIn` trong TSX bù lại.
            master_offset = offset + begin
            master_object = (
                f"{job.user_id}/{clip_id}/master/{job.attempt_id}.mp4"
            )
            run.uploads.put(RENDERS_BUCKET, master_object, master_file, content_type="video/mp4")

            # Transcript ở hình dạng native của DS, cùng gốc 0 với
            # master. Ghi thành FILE chứ không dựng lại từ artifact mỗi
            # lần mở: `<captions>` đọc nó qua thư viện asset của editor,
            # và một file bất biến là thứ duy nhất có hash ổn định.
            transcript_object = None
            if transcript_full is not None:
                transcript_file = root / f"master-{index}.transcript.json"
                transcript_file.write_text(
                    to_ds_transcript(
                        transcript_full.slice(
                            master_offset, master_offset + master_info.duration
                        )
                    ),
                    encoding="utf-8",
                )
                transcript_object = (
                    f"{job.user_id}/{clip_id}/master/{job.attempt_id}.transcript.json"
                )
                run.uploads.put(
                    RENDERS_BUCKET,
                    transcript_object,
                    transcript_file,
                    content_type="application/json",
                )

            out.masters[clip_id] = {
                "bucket": RENDERS_BUCKET,
                "object": master_object,
                "transcript": transcript_object,
                "bytes": master_file.stat().st_size,
                "width": master_info.width,
                "height": master_info.height,
                "duration": master_info.duration,
                "offset": master_offset,
                # Tâm khung động cho editor (R4): tính MỘT lần ở đây bằng
                # thuật toán của pipeline; bộ sinh project chỉ đọc.
                "focus": editor_focus(
                    self.tracks.get(clip_id, []),
                    source_width=master_info.width,
                    source_height=master_info.height,
                    frame_width=ASPECT_SIZES.get(job.aspect, ASPECT_SIZES["9:16"])[0],
                    frame_height=ASPECT_SIZES.get(job.aspect, ASPECT_SIZES["9:16"])[1],
                    offset=master_offset,
                    duration=master_info.duration,
                    source_start=float(moment.start),
                    source_end=float(moment.end),
                ),
            }

            layout, focus_x = self.framing.get(index, ("fill", 0.5))
            settings = default_settings(
                moment.start,
                moment.end,
                aspect=job.aspect,
                layout=layout,
                focus_x=focus_x,
                captions=job.captions,
                # Cùng hook mà `render_clip` vừa burn vào file giao
                # khách. Thiếu dòng này là revision đầu tiên mô tả một
                # clip KHÁC clip người dùng vừa tải về.
                hook=moment.hook,
            ).to_dict()
            out.revisions.append(
                {
                    "clip_id": clip_id,
                    "settings": settings,
                    "settings_hash": settings_hash(settings),
                }
            )
        return out
