"""Kiểm duyệt ĐẦU RA của ảnh/video AI trước khi giao (luật sản phẩm 4 mới, P0).

Prompt đã được web kiểm trước khi đặt credit (`apps/web/lib/generate/moderation.ts`);
ở đây kiểm thứ model thật sự vẽ ra — một prompt sạch vẫn có thể ra ảnh bẩn.
Creem đòi Moderation cho text-to-image/video; không kiểm thì không bật trên
production (web gác cửa bằng cùng `OPENAI_API_KEY`).

Bị chặn → `ProviderError` không retry: worker chốt hỏng, trigger hoàn credit,
file không bao giờ lên bucket.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
from pathlib import Path

import httpx

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import ProviderError
from opencmo.media.ffmpeg import run

log = logging.getLogger(__name__)

BLOCKED = "This result was blocked by our content policy. Your credits were refunded."
ENDPOINT = "https://api.openai.com/v1/moderations"
MODEL = "omni-moderation-latest"
# Bản giả: prompt chứa dấu này thì "ảnh" bị chặn — để test đường hoàn credit không cần mạng.
FAKE_MARK = "[[flag-output]]"

# Model tự render (3D của mình) không sinh hình từ prompt: lời đi vào đã kiểm ở web.
SKIP_PROVIDERS = {"opencmo-3d"}


def needs_check(model: AiModel) -> bool:
    return model.kind in ("image", "video") and model.provider not in SKIP_PROVIDERS


def _frames(path: Path, workdir: Path) -> list[Path]:
    """Ba frame (10% / 50% / 90%) của video, cạnh dài 512 px: đủ để kiểm, rẻ để gửi."""
    proc = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], timeout=60)
    duration = float(json.loads(proc.stdout).get("format", {}).get("duration") or 0) or 1.0
    out: list[Path] = []
    for index, ratio in enumerate((0.1, 0.5, 0.9)):
        frame = workdir / f"moderate-{index}.jpg"
        # `-ss` TRƯỚC `-i` (luật engine 4): seek theo input, không decode từ đầu.
        run([
            "ffmpeg", "-v", "error", "-y", "-ss", f"{duration * ratio:.3f}", "-i", str(path),
            "-frames:v", "1", "-vf", "scale='min(512,iw)':-2", str(frame),
        ], timeout=60)
        if frame.exists():
            out.append(frame)
    return out


def _data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def check_input(model: AiModel, path: Path) -> None:
    """Ảnh người dùng đưa vào (frame đầu/cuối, tham chiếu) cũng phải qua kiểm duyệt:
    model biến đổi ảnh đầu vào, nên ảnh bẩn vào là kết quả bẩn ra."""
    if model.provider in ("fake", *SKIP_PROVIDERS):
        return
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        _check_image(key, path)


def check_input_video(model: AiModel, path: Path, workdir: Path) -> None:
    """Video người dùng đưa cho model sửa video (G2): ba khung, như kiểm duyệt đầu ra."""
    if model.provider in ("fake", *SKIP_PROVIDERS):
        return
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return
    frames = _frames(path, workdir)
    if not frames:
        raise ProviderError(BLOCKED)
    for frame in frames:
        _check_image(key, frame)


def check_output(model: AiModel, spec: dict, path: Path) -> None:
    """Ném `ProviderError(BLOCKED)` khi ảnh/frame bị gắn cờ. Không có khoá thì bỏ qua
    (dev); production không bật model ảnh/video khi thiếu khoá (web gác cửa)."""
    if not needs_check(model):
        return
    if model.provider == "fake":
        if FAKE_MARK in str(spec.get("prompt") or ""):
            raise ProviderError(BLOCKED)
        return
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        log.warning("Không có OPENAI_API_KEY: bỏ qua kiểm duyệt đầu ra của %s", model.id)
        return
    with tempfile.TemporaryDirectory(prefix="opencmo-moderate-") as tmp:
        images = [path] if model.kind == "image" else _frames(path, Path(tmp))
        if not images:
            raise ProviderError(BLOCKED)
        # Một ảnh mỗi request: API kiểm duyệt nhận tối đa một ảnh trong một input.
        for image in images:
            _check_image(key, image)


def _check_image(key: str, image: Path) -> None:
    try:
        response = httpx.post(
            ENDPOINT,
            headers={"Authorization": f"Bearer {key}"},
            json={"model": MODEL, "input": [{"type": "image_url", "image_url": {"url": _data_url(image)}}]},
            timeout=60,
        )
    except httpx.HTTPError as exc:
        raise ProviderError("Could not check the result. Please try again.", retryable=True) from exc
    if response.status_code >= 500 or response.status_code == 429:
        raise ProviderError("Could not check the result. Please try again.", retryable=True)
    if response.status_code >= 400:
        # Không kiểm được thì KHÔNG giao: an toàn hơn giao một thứ chưa kiểm.
        log.error("Moderation trả %s: %s", response.status_code, response.text[:300])
        raise ProviderError(BLOCKED)
    if any(result.get("flagged") for result in response.json().get("results") or []):
        raise ProviderError(BLOCKED)
