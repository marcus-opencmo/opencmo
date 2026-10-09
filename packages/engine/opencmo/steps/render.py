"""Cắt, reframe theo tỉ lệ đã chọn, burn phụ đề và xuất clip.

Toàn bộ công việc do ffmpeg làm dưới dạng subprocess streaming. Engine không
bao giờ chạm vào pixel. Xem ARCHITECTURE.md §2.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from ..config import Config
from ..editing.models import clip_headline
from ..media.encoder import Encoder
from ..media.ffmpeg import run
from ..media.frame import CAPTION_STYLE, frame_filters, resolve_layout
from ..media.probe import probe_file
from ..models import Clip, Moment, Transcript
from .captions import TextLayer, build_ass
from .reframe import CropPlan, FaceTrack, plan_crop

log = logging.getLogger(__name__)

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _escape_filter_path(path: Path) -> str:
    r"""Escape đường dẫn để nhét vào chuỗi filter của ffmpeg.

    Filter graph coi ':' là dấu phân tách tham số và '\' là ký tự thoát, nên
    đường dẫn phải được escape hai lần cho đúng.
    """
    text = str(path)
    text = text.replace("\\", "\\\\")
    text = text.replace(":", "\\:")
    text = text.replace("'", "\\'")
    return text


def _clean_watermark(text: str) -> str:
    r"""Lọc chữ watermark xuống tập ký tự an toàn cho drawtext.

    Lọc chứ không escape, vì escape ở đây không làm được: chuỗi đi qua HAI lớp
    parser (filtergraph rồi drawtext), và dấu nháy đơn thì KHÔNG escape được khi
    nằm trong cặp nháy đơn của filtergraph — phải đóng chuỗi rồi mở lại. Chữ này
    là tên thương hiệu của ta, không phải nội dung người dùng nhập, nên bỏ ký tự
    lạ đi rẻ hơn nhiều so với dựng một bộ escape đúng cho cả hai lớp.
    """
    kept = [c for c in text if c.isalnum() or c in " .@_-/|+&"]
    return "".join(kept).strip()[:48]


def _watermark_filter(text: str, height: int) -> str:
    """Chữ mờ ở đáy khung, phía DƯỚI vùng phụ đề.

    Vị trí không tuỳ tiện: phụ đề nằm ở 18% chiều cao tính từ đáy (xem
    captions.py), nên watermark đặt ở 8% để không đè lên chữ. Cột phải là vùng
    nút tương tác của TikTok/Reels, cột trái là tên tài khoản — nên canh giữa.
    """
    label = _clean_watermark(text)
    if not label:
        return ""
    size = max(16, int(height * 0.022))
    return (
        f"drawtext=font='DejaVu Sans'"
        f":text='{label}'"
        f":fontsize={size}"
        f":fontcolor=white@0.75"
        # Viền đen mỏng: nền video sáng thì chữ trắng trơn biến mất.
        f":borderw={max(1, size // 16)}:bordercolor=black@0.5"
        f":x=(w-text_w)/2:y=h-{int(height * 0.08)}"
    )


def _safe_name(index: int, hook: str) -> str:
    """Tên file an toàn từ hook.

    Bỏ dấu trước khi lọc ký tự. Nếu lọc thẳng, mỗi chữ có dấu thành một dấu gạch
    và hook tiếng Việt biến thành rác: "Bí quyết vượt qua sự trì trệ" →
    "b-quy-t-v-t-qua-s-tr-tr". Bỏ dấu trước thì ra "bi-quyet-vuot-qua-su-tri-tre".
    """
    folded = unicodedata.normalize("NFKD", hook)
    # NFKD tách được dấu của hầu hết nguyên âm, nhưng KHÔNG tách 'đ' — nó là một
    # ký tự riêng chứ không phải 'd' cộng dấu.
    folded = folded.replace("đ", "d").replace("Đ", "D")
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")

    slug = _UNSAFE.sub("-", ascii_only).strip("-").lower()[:48].strip("-") or "clip"
    return f"{index:02d}-{slug}"


def render_clip(
    *,
    section_path: Path,
    lead_in: float,
    moment: Moment,
    index: int,
    transcript: Transcript,
    cfg: Config,
    encoder: Encoder,
    out_dir: Path,
    work_dir: Path,
    track: FaceTrack | None = None,
) -> Clip:
    info = probe_file(str(section_path))
    duration = moment.duration

    # Lấy mẫu mặt ĐÚNG cửa sổ sắp cắt, không phải cả file: nguồn file local dùng
    # chung một file làm section cho mọi clip, nên không khoanh vùng là lấy trung
    # vị của toàn video.
    crop: CropPlan = plan_crop(
        section_path,
        sample_fps=cfg.face_sample_fps,
        enabled=cfg.face_tracking,
        start=lead_in,
        duration=duration,
        # Worker web lấy mẫu section này một lần rồi lưu thành artifact; dùng
        # lại để MediaPipe không phải chạy lần hai cho cùng một cửa sổ.
        track=track,
        # Tỉ lệ nguồn quyết định khung cắt rộng bao nhiêu, nên nó cũng quyết
        # định mặt lệch bao nhiêu thì rơi ra ngoài. Bám mặt phải biết con số
        # đó mới chọn được tâm cắt; đoán 16:9 là sai với nguồn 4:3 hay dọc.
        source_aspect=info.width / info.height if info.height else 16 / 9,
        target_aspect=cfg.clip_width / cfg.clip_height,
    )

    layout = resolve_layout(cfg.layout, tracked=crop.tracked)
    filters = frame_filters(
        src_w=info.width,
        src_h=info.height,
        layout=layout,
        out_w=cfg.clip_width,
        out_h=cfg.clip_height,
        x_center=crop.x_center,
    )

    name = _safe_name(index, moment.hook)
    out_path = out_dir / f"{name}.mp4"

    # Hook do LLM viết thành lớp chữ ở đầu clip. Cùng hàm `clip_headline` mà
    # `default_settings` dùng, nên revision đầu tiên mô tả ĐÚNG file này — mở
    # editor ra không thấy khung khác clip vừa tải về.
    headline = (
        [
            TextLayer(t["text"], t["start"], t["end"], t["style"])
            for t in clip_headline(moment.hook, duration=moment.end - moment.start)
        ]
        if cfg.headline
        else []
    )
    if cfg.captions or headline:
        preset = CAPTION_STYLE
        ass_path = build_ass(
            # Phụ đề: lấy các đoạn transcript nằm trong khoảnh khắc, dời về gốc 0.
            transcript.slice(moment.start, moment.end) if cfg.captions else [],
            work_dir / f"clip_{index:02d}.ass",
            width=cfg.clip_width,
            height=cfg.clip_height,
            highlight=preset.highlight,
            font_ratio=preset.font_ratio,
            bold=preset.bold,
            outline_ratio=preset.outline_ratio,
            boxed=preset.boxed,
            margin_v_ratio=preset.margin_v_ratio,
            texts=headline,
        )
        filters.append(f"subtitles='{_escape_filter_path(ass_path)}'")
    if cfg.watermark:
        mark = _watermark_filter(cfg.watermark, cfg.clip_height)
        if mark:
            filters.append(mark)
    if encoder.filter_suffix:
        filters.append(encoder.filter_suffix)

    run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            *encoder.input_args,
            # -ss TRƯỚC -i: input seeking. Đặt sau -i sẽ khiến ffmpeg decode
            # từ đầu file tới điểm cắt. Xem ARCHITECTURE.md §4.
            "-ss", f"{lead_in:.3f}",
            "-i", str(section_path),
            "-t", f"{duration:.3f}",
            "-vf", ",".join(filters),
            "-c:v", encoder.name,
            *encoder.quality_args,
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(out_path),
        ]
    )

    preview_path: Path | None = None
    if cfg.make_preview:
        preview_path = out_dir / f"{name}.preview.mp4"
        # Preview luôn dùng libx264: nó chỉ là clip 500kbps, encode không đáng
        # kể, và tránh hẳn phần filter phức tạp của encoder phần cứng.
        # Xem ARCHITECTURE.md §7 — preview nhẹ cắt egress 5–10 lần.
        run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(out_path),
                "-vf", f"scale=-2:{cfg.preview_height}",
                "-c:v", "libx264", "-preset", "veryfast",
                "-b:v", cfg.preview_bitrate,
                "-c:a", "aac", "-b:a", "64k",
                "-movflags", "+faststart",
                str(preview_path),
            ]
        )

    log.info("Xong clip %d: %s (%.1fs)", index, out_path.name, duration)
    return Clip(
        index=index,
        moment=moment,
        path=str(out_path),
        preview_path=str(preview_path) if preview_path else None,
        width=cfg.clip_width,
        height=cfg.clip_height,
        layout=layout,
        focus_x=crop.x_center,
    )


def render_all(
    sections: list[tuple[Path, float]],
    moments: list[Moment],
    transcript: Transcript,
    cfg: Config,
    encoder: Encoder,
    out_dir: Path,
    work_dir: Path,
    tracks: list[FaceTrack | None] | None = None,
    *,
    on_clip: Callable[[Clip], None] | None = None,
    skip_indices: set[int] | None = None,
) -> list[Clip]:
    """Render các clip song song, có giới hạn.

    Giới hạn song song là cái chốt giữ RAM: mỗi tiến trình ffmpeg khoảng 400MB,
    nên `max_parallel` quyết định trực tiếp đỉnh RAM. Xem ARCHITECTURE.md §2.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    workers = max(1, min(2, cfg.max_parallel, len(sections)))
    log.info("Render %d clip, %d luồng song song", len(sections), workers)

    def task(args: tuple[int, tuple[Path, float], Moment]) -> Clip:
        index, (path, lead_in), moment = args
        return render_clip(
            section_path=path,
            lead_in=lead_in,
            moment=moment,
            index=index,
            transcript=transcript,
            cfg=cfg,
            encoder=encoder,
            out_dir=out_dir,
            work_dir=work_dir,
            track=tracks[index] if tracks else None,
        )

    jobs = [(i, sections[i], moments[i]) for i in range(len(sections))
            if i not in (skip_indices or set())]
    clips: list[Clip] = []
    failure: Exception | None = None
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(task, job) for job in jobs]
        for future in as_completed(futures):
            try:
                clip = future.result()
            except Exception as exc:
                log.exception("Một clip render lỗi; giữ các clip còn lại")
                # Clip khác vẫn có thể thành công. Công bố chúng trước khi báo
                # lỗi chung, để retry chỉ phải render các vị trí còn thiếu.
                failure = failure or exc
                continue
            if on_clip is not None:
                try:
                    on_clip(clip)
                except Exception:
                    # Mất lease/lỗi publication: không gửi callback trễ nữa.
                    for pending in futures:
                        pending.cancel()
                    raise
            clips.append(clip)
    if failure is not None:
        raise failure

    return sorted(clips, key=lambda c: c.index)


def preview_head(source: Path, out_path: Path, cfg: Config, *, seconds: float) -> Path:
    """Preview nhẹ của mấy giây ĐẦU một video, không encode lại cả file.

    Dùng cho chế độ "Don't clip": trang kết quả cần một thứ phát được, nhưng
    encode lại một video 45 phút xuống 640p chỉ để làm thumbnail là đổi một giờ
    CPU lấy một khung hình.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source),
            "-t", f"{seconds:.3f}",
            "-vf", f"scale=-2:{cfg.preview_height}",
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", cfg.preview_bitrate,
            "-c:a", "aac", "-b:a", "64k",
            "-movflags", "+faststart",
            str(out_path),
        ]
    )
    return out_path
