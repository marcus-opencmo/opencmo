"""FakeProvider — kết quả tất định bằng ffmpeg, không tốn đồng nào (spec §7.4).

Nhờ nó cả luồng Generate chạy thật được trong dev/CI: đặt trước credit, hàng
đợi, Storage, thư viện editor, timeline, huỷ, hoàn. Kết quả phải NHÌN được là
của prompt nào — chữ prompt in lên khung — để khi mở ảnh ra kiểm biết ngay có
lẫn lượt này với lượt khác không.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import Poll, ProviderAdapter, Result
from opencmo.media.ffmpeg import run

# Nhỏ hơn 1080p của provider thật: đây là dữ liệu thử, sinh cho nhanh.
SIZES = {
    "16:9": (1280, 720),
    "9:16": (720, 1280),
    "1:1": (1024, 1024),
    "4:5": (864, 1080),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
}


def _color(spec: dict[str, Any]) -> str:
    digest = hashlib.sha256(f"{spec.get('prompt')}|{spec.get('seed')}".encode()).hexdigest()
    # Tối vừa phải để chữ trắng luôn đọc được.
    r, g, b = (int(digest[i : i + 2], 16) // 2 + 20 for i in (0, 2, 4))
    return f"0x{r:02x}{g:02x}{b:02x}"


def _text_filter(textfile: Path, size: int) -> str:
    # `textfile` + `expansion=none`: chữ người dùng KHÔNG đi qua parser của
    # filtergraph lẫn bộ mở rộng %{...} của drawtext — không cần escape gì.
    return (
        f"drawtext=font='DejaVu Sans':textfile='{textfile}':expansion=none"
        f":fontsize={size}:fontcolor=white:borderw=2:bordercolor=black@0.6"
        f":x=(w-text_w)/2:y=(h-text_h)/2"
    )


def _font_size(width: int, height: int) -> int:
    # Theo cạnh NGẮN: khung dọc 720px mà cỡ chữ theo chiều cao 1280 thì dòng 28
    # ký tự tràn ra hai mép (đã thấy khi mở ảnh ra xem).
    return min(width, height) // 20


def _wrap(prompt: str, width: int = 28, lines: int = 6) -> str:
    words, out, line = prompt.split(), [], ""
    for word in words:
        if len(line) + len(word) + 1 > width and line:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = out[-1][: width - 1] + "…"
    return "\n".join(out)


def _cover(width: int, height: int) -> str:
    """Phủ kín khung (cắt phần thừa) — ảnh đầu vào có tỉ lệ bất kỳ."""
    return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"


def _video_inputs(spec: dict[str, Any], width: int, height: int, seconds: int) -> list[str]:
    """Frame đầu/cuối (ảnh đã tải + kiểm duyệt ở `generate_task`) làm hình; không có thì testsrc."""
    start, end = spec.get("startImage"), spec.get("endImage")
    if not start and not end:
        return ["-f", "lavfi", "-i", f"testsrc2=s={width}x{height}:r=30:d={seconds}"]
    images = [image for image in (start, end) if image]
    return [arg for image in images for arg in ("-loop", "1", "-t", str(seconds), "-i", str(image))]


def _video_filter(spec: dict[str, Any], width: int, height: int, seconds: int, textfile: Path) -> str:
    text = _text_filter(textfile, _font_size(width, height))
    if spec.get("startImage") and spec.get("endImage"):
        # Hoà dần từ frame đầu sang frame cuối: frame cuối của video đúng là ảnh cuối.
        half = max(0.5, seconds / 2)
        return (
            f"[0:v]{_cover(width, height)},fps=30[a];[1:v]{_cover(width, height)},fps=30[b];"
            f"[a][b]xfade=transition=fade:duration={half}:offset={max(0.0, seconds - half - 0.2)},{text}[out]"
        )
    if spec.get("startImage") or spec.get("endImage"):
        return f"[0:v]{_cover(width, height)},fps=30,{text}[out]"
    return f"[0:v]{text}[out]"


def even_words(prompt: str, duration: float) -> list[dict[str, Any]]:
    """Mốc chữ chia đều theo thời lượng — đủ để thử phụ đề của voiceover mà
    không cần provider thật."""
    words = prompt.split()
    step = duration / max(1, len(words))
    return [
        {"text": word, "start": round(i * step, 3), "end": round((i + 1) * step - 0.02, 3)}
        for i, word in enumerate(words)
    ]


class FakeProvider(ProviderAdapter):
    poll_seconds = 0.0

    def __init__(self) -> None:
        self._words: dict[str, list[dict[str, Any]]] = {}

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        kind = model.kind
        textfile = workdir / "prompt.txt"
        textfile.write_text(_wrap(str(spec["prompt"])), encoding="utf-8")
        seconds = int(spec.get("duration") or 0)

        if kind == "image":
            width, height = SIZES[spec["aspectRatio"]]
            out = workdir / "result.png"
            refs = spec.get("references") or []
            # Có tham chiếu: lấy ảnh đầu làm nền — mở ra xem là biết tham chiếu tới được provider.
            source = (
                ["-i", str(refs[0])] if refs else ["-f", "lavfi", "-i", f"color=c={_color(spec)}:s={width}x{height}"]
            )
            run([
                "ffmpeg", "-v", "error", "-y", *source,
                "-vf", f"{_cover(width, height)},{_text_filter(textfile, _font_size(width, height))}",
                "-frames:v", "1", str(out),
            ], timeout=60)
        elif kind == "video" and spec.get("sourceVideo") and model.limits.get("upscale"):
            # Upscale giả: phóng cạnh ngắn lên đích (1080/2160), giữ tỉ lệ và độ dài nguồn.
            target = 2160 if spec.get("resolution") == "2160p" else 1080
            out = workdir / "result.mp4"
            run([
                "ffmpeg", "-v", "error", "-y", "-i", str(spec["sourceVideo"]),
                "-vf", f"scale='if(lte(iw,ih),{target},-2)':'if(lte(iw,ih),-2,{target})':flags=lanczos",
                "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-movflags", "+faststart", str(out),
            ], timeout=180)
        elif kind == "video" and spec.get("sourceVideo"):
            # Sửa video giả: đổi màu nguồn + chữ prompt, giữ khung và độ dài của nguồn —
            # mở ra là thấy video nguồn đã tới được provider.
            out = workdir / "result.mp4"
            run([
                "ffmpeg", "-v", "error", "-y", "-i", str(spec["sourceVideo"]),
                "-vf", f"hue=h=120:s=1.4,{_text_filter(textfile, 36)}",
                "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-movflags", "+faststart", str(out),
            ], timeout=120)
        elif kind == "video":
            width, height = SIZES[spec["aspectRatio"]]
            out = workdir / "result.mp4"
            run([
                "ffmpeg", "-v", "error", "-y", *_video_inputs(spec, width, height, seconds),
                "-filter_complex", _video_filter(spec, width, height, seconds, textfile),
                "-map", "[out]", "-t", str(seconds), "-r", "30",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(out),
            ], timeout=120)
        elif kind == "voice":
            # Dài bằng thời gian đọc thật (~2.5 từ/giây) để thử được timeline.
            words = max(1, len(str(spec["prompt"]).split()))
            duration = max(1.0, round(words / 2.5, 2))
            tone = 180 + int(hashlib.sha256(str(spec.get("voice")).encode()).hexdigest()[:2], 16)
            out = workdir / "result.m4a"
            run([
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", f"sine=frequency={tone}:duration={duration}",
                "-af", "volume=0.3", "-c:a", "aac", "-b:a", "96k", str(out),
            ], timeout=60)
            self._words[str(out)] = even_words(str(spec["prompt"]), duration)
        else:  # audio (SFX)
            out = workdir / "result.m4a"
            run([
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", f"anoisesrc=d={seconds}:c=pink:a=0.3",
                "-af", f"lowpass=f=1200,afade=t=out:st={max(0, seconds - 0.5)}:d=0.5",
                "-c:a", "aac", "-b:a", "96k", str(out),
            ], timeout=60)
        return str(out)

    def poll(self, ref: str) -> Poll:
        return Poll("done")

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        path = Path(ref)
        extension = path.suffix.lstrip(".")
        content_type = {"png": "image/png", "mp4": "video/mp4", "m4a": "audio/mp4"}[extension]
        return Result(path=path, content_type=content_type, extension=extension, words=self._words.get(ref))
