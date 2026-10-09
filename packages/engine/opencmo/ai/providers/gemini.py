"""GeminiProvider — giọng đọc (TTS), ảnh và Veo qua MỘT khoá GEMINI_API_KEY.

Ảnh và giọng trả về ngay trong response (inline data); Veo trả một operation
phải hỏi lại. File video tải THEO STREAM xuống đĩa (luật RAM của CLAUDE.md);
ảnh và PCM của giọng nhỏ, SDK đã giữ sẵn trong response.

Mọi lỗi của provider đi ra thành `ProviderError` với câu tiếng Anh: quá tải và
lỗi máy chủ thì thử lại (task về hàng), từ chối vì nội dung thì KHÔNG — gọi lại
là trả tiền lại cho cùng một lời từ chối.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import Poll, ProviderAdapter, ProviderError, Result
from opencmo.media.ffmpeg import run

DECLINED = "The provider declined this prompt. Try rewording it. Your credits were refunded."
BUSY = "The generation service is busy. We will try again shortly."
REJECTED = "The provider could not run this request. Your credits were refunded."
NOT_SET_UP = "Generation is not set up on the server yet. Your credits were refunded."

#: Trần file video tải về — Veo trả vài MB; lớn hơn nhiều là có gì sai.
MAX_VIDEO_BYTES = 500 * 1024 * 1024

_BLOCK_REASONS = ("SAFETY", "PROHIBITED", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "RECITATION", "OTHER")
_IMAGE_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def _api_error(exc: Exception) -> ProviderError:
    code = int(getattr(exc, "code", 0) or 0)
    message = str(getattr(exc, "message", "") or exc).lower()
    if code in (429, 500, 502, 503, 504):
        return ProviderError(BUSY, retryable=True)
    if code in (401, 403):
        return ProviderError(NOT_SET_UP)
    if any(word in message for word in ("safety", "blocked", "policy", "prohibited", "responsible ai")):
        return ProviderError(DECLINED)
    return ProviderError(REJECTED)


def _inline(response: Any) -> Any:
    """Part `inline_data` đầu tiên; không có thì là bị chặn hoặc hỏng."""
    feedback = getattr(response, "prompt_feedback", None)
    if feedback is not None and getattr(feedback, "block_reason", None):
        raise ProviderError(DECLINED)
    for candidate in getattr(response, "candidates", None) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", None) or []:
            data = getattr(part, "inline_data", None)
            if data is not None and getattr(data, "data", None):
                return data
        reason = str(getattr(candidate, "finish_reason", "") or "")
        if any(block in reason.upper() for block in _BLOCK_REASONS):
            raise ProviderError(DECLINED)
    raise ProviderError(REJECTED)


def _pcm_rate(mime: str) -> int:
    match = re.search(r"rate=(\d+)", mime or "")
    return int(match.group(1)) if match else 24000


class GeminiProvider(ProviderAdapter):
    poll_seconds = 10.0
    timeout_seconds = 600.0

    def __init__(self, api_key: str, *, client: Any = None, http: httpx.Client | None = None) -> None:
        if client is None:
            from google import genai

            client = genai.Client(api_key=api_key)
        self.api_key = api_key
        self.client = client
        self.http = http
        self._operations: dict[str, Any] = {}

    # ------------------------------------------------------------------ submit

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        from google.genai import errors

        try:
            if model.kind == "image":
                return self._image(model, spec, workdir)
            if model.kind == "voice":
                return self._voice(model, spec, workdir)
            if model.kind == "video":
                return self._video(model, spec)
        except errors.APIError as exc:
            raise _api_error(exc) from exc
        raise ProviderError(REJECTED)

    def _image(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        from google.genai import types

        response = self.client.models.generate_content(
            model=model.remote_id(),
            contents=str(spec["prompt"]),
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                image_config=types.ImageConfig(aspect_ratio=spec["aspectRatio"]),
                **({"seed": spec["seed"]} if spec.get("seed") is not None else {}),
            ),
        )
        data = _inline(response)
        extension = _IMAGE_EXT.get(str(data.mime_type), "png")
        out = workdir / f"result.{extension}"
        out.write_bytes(data.data)
        return f"file:{out}"

    def _voice(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        from google.genai import types

        response = self.client.models.generate_content(
            model=model.remote_id(),
            contents=str(spec["prompt"]),
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=spec["voice"])
                    )
                ),
                **({"seed": spec["seed"]} if spec.get("seed") is not None else {}),
            ),
        )
        data = _inline(response)
        raw = workdir / "voice.pcm"
        raw.write_bytes(data.data)
        out = workdir / "result.m4a"
        # Gemini trả PCM 16-bit mono thô; editor và trình duyệt cần một file
        # có container — đóng AAC/m4a như FakeProvider.
        run([
            "ffmpeg", "-v", "error", "-y",
            "-f", "s16le", "-ar", str(_pcm_rate(str(data.mime_type))), "-ac", "1", "-i", str(raw),
            "-c:a", "aac", "-b:a", "128k", str(out),
        ], timeout=120)
        return f"file:{out}"

    def _video(self, model: AiModel, spec: dict[str, Any]) -> str:
        from google.genai import types

        # Ảnh đầu (G2): worker đã tải `startImage` về file cục bộ và kiểm duyệt nó. Veo nhận
        # ảnh đầu ở mọi độ dài 4/6/8 s; ảnh có người thì chỉ `allow_adult` được phép.
        start = spec.get("startImage")
        image = None
        if start:
            path = Path(str(start))
            mime = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
            image = types.Image(image_bytes=path.read_bytes(), mime_type=mime)
        operation = self.client.models.generate_videos(
            model=model.remote_id(),
            prompt=str(spec["prompt"]),
            **({"image": image} if image is not None else {}),
            config=types.GenerateVideosConfig(
                number_of_videos=1,
                aspect_ratio=spec["aspectRatio"],
                duration_seconds=int(spec["duration"]),
                **({"person_generation": "allow_adult"} if image is not None else {}),
                # Veo qua Gemini Developer API (khoá `GEMINI_API_KEY`) ném
                # "seed parameter is only supported in … Agent Platform mode" TRƯỚC
                # khi gửi request: mọi lượt sinh video trên production hỏng (UAT
                # 29/09). `seed` vẫn nằm trong spec và hash để khử trùng.
                **(
                    {"seed": spec["seed"]}
                    if spec.get("seed") is not None and getattr(self.client, "vertexai", False)
                    else {}
                ),
            ),
        )
        name = str(operation.name)
        self._operations[name] = operation
        return f"op:{name}"

    # ------------------------------------------------------------------ poll / fetch

    def poll(self, ref: str) -> Poll:
        if ref.startswith("file:"):
            return Poll("done")
        from google.genai import errors, types

        name = ref.removeprefix("op:")
        try:
            operation = self.client.operations.get(self._operations.get(name) or types.GenerateVideosOperation(name=name))
        except errors.APIError as exc:
            raise _api_error(exc) from exc
        self._operations[name] = operation
        if not operation.done:
            return Poll("running")
        if operation.error:
            error = _api_error(RuntimeError(str(operation.error)))
            return Poll("failed", str(error))
        videos = getattr(operation.response or operation.result, "generated_videos", None) or []
        if not videos or videos[0].video is None:
            # Veo lọc kết quả vì an toàn: operation xong mà không có video.
            return Poll("failed", DECLINED)
        return Poll("done")

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        if ref.startswith("file:"):
            path = Path(ref.removeprefix("file:"))
            extension = path.suffix.lstrip(".")
            content_type = {"m4a": "audio/mp4", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[extension]
            return Result(path=path, content_type=content_type, extension=extension)

        operation = self._operations[ref.removeprefix("op:")]
        video = (operation.response or operation.result).generated_videos[0].video
        out = dest_dir / "result.mp4"
        if video.video_bytes:
            out.write_bytes(video.video_bytes)
        elif video.uri:
            self._download(str(video.uri), out)
        else:
            raise ProviderError(REJECTED)
        return Result(path=out, content_type="video/mp4", extension="mp4")

    def _download(self, url: str, out: Path) -> None:
        client = self.http or httpx.Client(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=True)
        try:
            with client.stream("GET", url, headers={"x-goog-api-key": self.api_key}) as response:
                if response.status_code >= 500 or response.status_code == 429:
                    raise ProviderError(BUSY, retryable=True)
                if response.status_code >= 400:
                    raise ProviderError(REJECTED)
                size = 0
                with out.open("wb") as handle:
                    for chunk in response.iter_bytes(1 << 20):
                        size += len(chunk)
                        if size > MAX_VIDEO_BYTES:
                            raise ProviderError(REJECTED)
                        handle.write(chunk)
        except httpx.TransportError as exc:
            raise ProviderError(BUSY, retryable=True) from exc
        finally:
            if self.http is None:
                client.close()
