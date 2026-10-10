"""Provider fal.ai: một API hàng đợi cho nhiều lab (Seedance, Kling, Hailuo, Nano Banana,
Seedream…) — plan Palmier P1. Model chỉ là một dòng catalog: id endpoint nằm ở
`providerModel` / `providerModels` của `ai-models.json`, đổi được không cần sửa code.

Hàng đợi: POST `queue.fal.run/<endpoint>` → `status_url` + `response_url`; hỏi
`status_url` tới COMPLETED rồi đọc `response_url` lấy link file và tải THEO STREAM.

Ảnh của người dùng (frame đầu/cuối, tham chiếu) đến đây là FILE ĐÃ TẢI về và đã kiểm
duyệt (`generate_task`); gửi đi dạng data URI — bucket không phải mở ra ngoài.

Voice and audio go through fal too (ElevenLabs and Gemini TTS endpoints), so one key covers
every generated medium. ElevenLabs on fal returns the same per-character alignment as the
direct API, so voiceover captions keep real word timings.
"""

from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path
from typing import Any

import httpx

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import Poll, ProviderAdapter, ProviderError, Result
from opencmo.ai.providers.elevenlabs import words_from_alignment
from opencmo.media.ffmpeg import run

QUEUE = "https://queue.fal.run"
FAILED = "Generation failed. Your credits were refunded."
BUSY = "The generator is busy. Please try again in a minute."
MAX_BYTES = 1024 * 1024 * 1024

#: Model dùng `image_size` thay cho `aspect_ratio` (catalog `limits.sizeParam`).
IMAGE_SIZES = {
    "1:1": "square_hd",
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
    "4:3": "landscape_4_3",
    "3:4": "portrait_4_3",
}


def data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def endpoint_for(model: AiModel, spec: dict[str, Any]) -> str:
    """Ảnh→video khi có frame đầu; ảnh có tham chiếu thì endpoint `edit`; còn lại là chính."""
    extra = model.provider_models or {}
    if model.kind == "video" and spec.get("startImage") and extra.get("image"):
        return extra["image"]
    if model.kind == "image" and spec.get("references") and extra.get("edit"):
        return extra["edit"]
    return model.remote_id()


def speech_payload(model: AiModel, spec: dict[str, Any]) -> dict[str, Any]:
    """Voice and audio endpoints name their fields differently from the image/video ones."""
    remote = model.remote_id()
    if model.kind == "voice":
        if "gemini-tts" in remote:
            return {"prompt": str(spec["prompt"]), "voice": str(spec["voice"]), "output_format": "mp3"}
        # Premade voices only, by name (product rule: no cloning); timestamps feed the captions.
        return {"text": str(spec["prompt"]), "voice": str(spec["voice"]), "timestamps": True}
    seconds = int(spec["duration"])
    if "music" in remote:
        # Always instrumental: no sung voice that could sound like a real person.
        return {"prompt": str(spec["prompt"]), "music_length_ms": seconds * 1000, "force_instrumental": True}
    return {"text": str(spec["prompt"]), "duration_seconds": seconds, "prompt_influence": 0.3}


def build_payload(model: AiModel, spec: dict[str, Any]) -> dict[str, Any]:
    """Tham số chung của các endpoint fal; chỉ gửi thứ spec có (catalog đã kiểm khả năng)."""
    if model.kind in ("voice", "audio"):
        return speech_payload(model, spec)
    if model.limits.get("upscale"):
        # Upscale (G4, SeedVR2): chỉ video + độ phân giải đích; prompt không có nghĩa với model này.
        return {
            "video_url": data_url(Path(spec["sourceVideo"])),
            "upscale_mode": "target",
            "target_resolution": spec.get("resolution") or "1080p",
        }
    if model.limits.get("sourceVideo"):
        # Sửa video (Kling O1 Edit): chỉ prompt + video + ảnh tham chiếu; khung hình và độ dài
        # theo chính video nguồn, giữ tiếng gốc (người dùng sửa hình, không sửa lời nói).
        edit: dict[str, Any] = {"prompt": spec["prompt"], "video_url": data_url(Path(spec["sourceVideo"])), "keep_audio": True}
        if spec.get("references"):
            edit["image_urls"] = [data_url(Path(ref)) for ref in spec["references"]]
        return edit
    payload: dict[str, Any] = {"prompt": spec["prompt"]}
    aspect = spec.get("aspectRatio")
    if aspect:
        if model.limits.get("sizeParam") == "image_size":
            payload["image_size"] = IMAGE_SIZES.get(aspect, "square_hd")
        else:
            payload["aspect_ratio"] = aspect
    if model.kind == "video" and spec.get("duration") is not None:
        # Endpoint video của fal nhận thời lượng dạng chuỗi enum ("5", "10"); Veo wants "8s".
        payload["duration"] = f"{spec['duration']}s" if "veo" in model.remote_id() else str(spec["duration"])
    if spec.get("resolution"):
        payload["resolution"] = spec["resolution"]
    if spec.get("seed") is not None:
        payload["seed"] = spec["seed"]
    if "audio" in spec:
        payload["generate_audio"] = bool(spec["audio"])
    if model.kind == "image":
        payload["num_images"] = 1
    if spec.get("startImage"):
        payload["image_url"] = data_url(Path(spec["startImage"]))
    if spec.get("endImage"):
        payload["end_image_url"] = data_url(Path(spec["endImage"]))
    if spec.get("references"):
        payload["image_urls"] = [data_url(Path(ref)) for ref in spec["references"]]
    return payload


def result_url(body: dict[str, Any]) -> str:
    """Link file trong kết quả: `images[0]`, `image`, `video` hay `audio` tuỳ endpoint."""
    items = body.get("images")
    if isinstance(items, list) and items and isinstance(items[0], dict) and items[0].get("url"):
        return str(items[0]["url"])
    for key in ("video", "image", "audio", "audio_file"):
        item = body.get(key)
        if isinstance(item, dict) and item.get("url"):
            return str(item["url"])
    raise ProviderError(FAILED)


class FalProvider(ProviderAdapter):
    poll_seconds = 5.0
    timeout_seconds = 900.0

    def __init__(self, key: str, *, client: httpx.Client | None = None, download: httpx.Client | None = None) -> None:
        self._client = client or httpx.Client(timeout=60, headers={"Authorization": f"Key {key}"})
        # Client tải file KHÔNG mang khoá: link kết quả là host CDN, khoá chỉ đi tới API hàng đợi.
        self._download = download or httpx.Client(timeout=300, follow_redirects=True)

    def _check(self, response: httpx.Response) -> dict[str, Any]:
        if response.status_code == 429 or response.status_code >= 500:
            raise ProviderError(BUSY, retryable=True)
        if response.status_code >= 400:
            # 4xx: yêu cầu bị từ chối (nội dung, tham số) — gọi lại là trả tiền lại.
            raise ProviderError(FAILED)
        return response.json()

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        try:
            body = self._check(self._client.post(f"{QUEUE}/{endpoint_for(model, spec)}", json=build_payload(model, spec)))
        except httpx.HTTPError as exc:
            raise ProviderError(BUSY, retryable=True) from exc
        if not body.get("status_url") or not body.get("response_url"):
            raise ProviderError(FAILED)
        ref: dict[str, Any] = {"status_url": body["status_url"], "response_url": body["response_url"]}
        if model.kind == "audio":
            # The model can return a little more than was paid for; fetch trims to this.
            ref["seconds"] = int(spec["duration"])
        return json.dumps(ref)

    def poll(self, ref: str) -> Poll:
        urls = json.loads(ref)
        try:
            body = self._check(self._client.get(urls["status_url"]))
        except httpx.HTTPError:
            return Poll("running")
        status = str(body.get("status") or "")
        if status == "COMPLETED":
            return Poll("done")
        if status in ("IN_QUEUE", "IN_PROGRESS"):
            return Poll("running")
        return Poll("failed", FAILED)

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        urls = json.loads(ref)
        body = self._check(self._client.get(urls["response_url"]))
        url = result_url(body)
        raw = dest_dir / "fal-result"
        written = 0
        with self._download.stream("GET", url) as resp:
            if resp.status_code >= 400:
                raise ProviderError(FAILED)
            content_type = resp.headers.get("content-type", "").split(";")[0].strip()
            with raw.open("wb") as fh:
                for chunk in resp.iter_bytes(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise ProviderError(FAILED)
                    fh.write(chunk)
        result = _normalize(raw, content_type, dest_dir, seconds=urls.get("seconds"))
        words = speech_words(body)
        return Result(result.path, result.content_type, result.extension, words=words) if words else result


def speech_words(body: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Word timings from ElevenLabs on fal: `timestamps` is a list of alignment chunks."""
    chunks = body.get("timestamps")
    if not isinstance(chunks, list):
        return None
    words: list[dict[str, Any]] = []
    for chunk in chunks:
        words.extend(words_from_alignment(chunk))
    return words or None


def _normalize(raw: Path, content_type: str, dest_dir: Path, *, seconds: int | None = None) -> Result:
    """Đổi về đúng định dạng editor đọc được: PNG cho ảnh, MP4 cho video, M4A cho tiếng."""
    if content_type.startswith("video/"):
        out = raw.rename(dest_dir / "result.mp4")
        return Result(out, "video/mp4", "mp4")
    if content_type.startswith("audio/"):
        out = dest_dir / "result.m4a"
        trim = ["-t", str(seconds)] if seconds else []
        run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), *trim, "-c:a", "aac", "-b:a", "192k", str(out)], timeout=300)
        return Result(out, "audio/mp4", "m4a")
    if content_type in ("image/png", "image/jpeg", "image/webp") or content_type.startswith("image/"):
        out = dest_dir / "result.png"
        # WebP/JPEG → PNG: renderer và OPFS editor đọc PNG, và tên file luôn `.png` như Gemini.
        run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-frames:v", "1", str(out)], timeout=120)
        return Result(out, "image/png", "png")
    raise ProviderError(FAILED)
