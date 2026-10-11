"""ElevenLabsProvider — giọng đọc có mốc từng chữ (spec voiceover 2026-10-02).

Một lời gọi `POST /v1/text-to-speech/{voice_id}/with-timestamps`: response là
JSON gồm audio base64 và căn chỉnh THEO KÝ TỰ. Gom ký tự thành từ ở đây, vì phụ
đề của voiceover (preset hiện từng từ) cần mốc từ thật — không bịa theo độ dài.

Audio base64 nằm trong RAM một lúc: 5000 ký tự ≈ 5 phút mp3 128k ≈ 5 MB, không
phải frame video (luật RAM của CLAUDE.md không đụng tới). Đóng lại m4a/AAC bằng
ffmpeg như Gemini và FakeProvider, để editor và exporter chỉ gặp một định dạng.

Tên giọng → voice_id nằm ở đây, không ở catalog: catalog là tên hiển thị (SQL
kiểm), id là chi tiết của provider. `OPENCMO_ELEVENLABS_VOICES` (JSON
`{"Tên": "id"}`) ghi đè khi ElevenLabs đổi thư viện giọng.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import (
    BUSY,
    DECLINED,
    NOT_SET_UP,
    REJECTED,
    Poll,
    ProviderAdapter,
    ProviderError,
    Result,
)
from opencmo.media.ffmpeg import run

log = logging.getLogger(__name__)

API = "https://api.elevenlabs.io"

#: Hết ký tự — của tài khoản, hoặc trần riêng đặt trên khoá. Việc của người vận
#: hành chứ không của người dùng, nên câu không bảo họ sửa gì.
OUT_OF_QUOTA = "Voice generation is temporarily unavailable. Your credits were refunded."

#: Giọng có sẵn (premade) của ElevenLabs. Kiểm lại bằng `GET /v1/voices` khi có
#: khoá (VIEC-CAN-LAM) — sai id thì lỗi 404 → REJECTED, credit được hoàn.
VOICES: dict[str, str] = {
    "Aria": "9BWtsMINqrJLrRacOk9x",
    "Roger": "CwhRBWXzGAHq8TQ4Fs17",
    "Sarah": "EXAVITQu4vr4xnSDxMaL",
    "Laura": "FGY2WhTYpPnrIDTdsKH5",
    "Charlie": "IKne3meq5aSn9XLyUdCD",
    "George": "JBFqnCBsd6RMkjVDRZzb",
    "Callum": "N2lVS1w4EtoT3dr4eOWO",
    "Liam": "TX3LPaxmHKxFdv7VOQHJ",
    "Charlotte": "XB0fDUnXU5powFXDhCwa",
    "Matilda": "XrExE9yKIg1WjnnlVkGX",
    "Brian": "nPczCjzI2devNBz1zQrb",
    "Jessica": "cgSgspJ2msm6clMCkdW9",
}

#: Response JSON lớn nhất nhận: audio base64 của 5000 ký tự còn xa mức này.
MAX_RESPONSE_BYTES = 40 * 1024 * 1024


def voice_ids() -> dict[str, str]:
    override = os.environ.get("OPENCMO_ELEVENLABS_VOICES", "")
    if not override:
        return VOICES
    try:
        parsed = json.loads(override)
    except json.JSONDecodeError:
        return VOICES
    return {**VOICES, **{str(k): str(v) for k, v in parsed.items()}} if isinstance(parsed, dict) else VOICES


def words_from_alignment(alignment: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Ký tự + mốc → từ: một từ là một dãy ký tự không phải khoảng trắng.

    Mốc của từ = start của ký tự đầu, end của ký tự cuối. Căn chỉnh thiếu hay
    lệch độ dài thì trả rỗng — voiceover vẫn dùng được, chỉ không có phụ đề.
    """
    if not isinstance(alignment, dict):
        return []
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    if not (isinstance(chars, list) and len(chars) == len(starts) == len(ends)):
        return []
    words: list[dict[str, Any]] = []
    text, first, last = "", 0.0, 0.0
    for char, start, end in zip(chars, starts, ends, strict=True):
        if not isinstance(char, str) or not isinstance(start, int | float) or not isinstance(end, int | float):
            return []
        if char.isspace():
            if text:
                words.append({"text": text, "start": round(first, 3), "end": round(max(first, last), 3)})
                text = ""
            continue
        if not text:
            first = float(start)
        text += char
        last = float(end)
    if text:
        words.append({"text": text, "start": round(first, 3), "end": round(max(first, last), 3)})
    return words


class ElevenLabsProvider(ProviderAdapter):
    poll_seconds = 0.0
    timeout_seconds = 300.0

    def __init__(self, api_key: str, *, http: httpx.Client | None = None) -> None:
        self.api_key = api_key
        self.http = http
        self._results: dict[str, Result] = {}

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        if model.kind == "audio":
            return self._audio(model, spec, workdir)
        if model.kind != "voice":
            raise ProviderError(REJECTED)
        voice_id = voice_ids().get(str(spec.get("voice")))
        if not voice_id:
            raise ProviderError(NOT_SET_UP)
        body: dict[str, Any] = {"text": str(spec["prompt"]), "model_id": model.remote_id()}
        if spec.get("seed") is not None:
            body["seed"] = int(spec["seed"])
        payload = self._post(f"/v1/text-to-speech/{voice_id}/with-timestamps", body)
        try:
            audio = base64.b64decode(str(payload.get("audio_base64") or ""), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ProviderError(REJECTED) from exc
        if not audio:
            raise ProviderError(REJECTED)
        raw = workdir / "voice.mp3"
        raw.write_bytes(audio)
        out = workdir / "result.m4a"
        run([
            "ffmpeg", "-v", "error", "-y", "-i", str(raw),
            "-c:a", "aac", "-b:a", "128k", "-ac", "1", str(out),
        ], timeout=180)
        # `normalized_alignment` khớp văn bản đã chuẩn hoá (số đọc thành chữ);
        # phụ đề muốn đúng chữ người dùng viết nên ưu tiên `alignment`.
        words = words_from_alignment(payload.get("alignment")) or words_from_alignment(payload.get("normalized_alignment"))
        ref = str(out)
        self._results[ref] = Result(path=out, content_type="audio/mp4", extension="m4a", words=words or None)
        return ref

    def _audio(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        """SFX (`/v1/sound-generation`) hay nhạc (`/v1/music`) — G3. Nhạc luôn KHÔNG LỜI
        (`force_instrumental`): không giọng hát nào giống người thật (luật sản phẩm 4)."""
        seconds = int(spec["duration"])
        remote = model.remote_id()
        if remote.startswith("music"):
            path = "/v1/music"
            body: dict[str, Any] = {
                "prompt": str(spec["prompt"]), "music_length_ms": seconds * 1000,
                "model_id": remote, "force_instrumental": True,
            }
        else:
            path = "/v1/sound-generation"
            body = {"text": str(spec["prompt"]), "duration_seconds": seconds, "model_id": remote, "prompt_influence": 0.3}
        audio = self._request(path, body).content
        if not audio:
            raise ProviderError(REJECTED)
        raw = workdir / "audio.mp3"
        raw.write_bytes(audio)
        out = workdir / "result.m4a"
        # Đúng số giây đã trả tiền: model có thể trả dài hơn một chút.
        run([
            "ffmpeg", "-v", "error", "-y", "-i", str(raw), "-t", str(seconds),
            "-c:a", "aac", "-b:a", "160k", "-ac", "2", str(out),
        ], timeout=180)
        ref = str(out)
        self._results[ref] = Result(path=out, content_type="audio/mp4", extension="m4a")
        return ref

    def poll(self, ref: str) -> Poll:
        return Poll("done")

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        return self._results[ref]

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self._request(path, body)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError(REJECTED) from exc
        if not isinstance(payload, dict):
            raise ProviderError(REJECTED)
        return payload

    def _request(self, path: str, body: dict[str, Any]) -> httpx.Response:
        """POST tới ElevenLabs, đổi lỗi HTTP thành câu cho người dùng; trả response đã kiểm."""
        client = self.http or httpx.Client(timeout=httpx.Timeout(30.0, read=300.0))
        try:
            response = client.post(
                f"{API}{path}",
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": self.api_key, "content-type": "application/json"},
                json=body,
            )
        except httpx.TransportError as exc:
            raise ProviderError(BUSY, retryable=True) from exc
        finally:
            if self.http is None:
                client.close()
        status = response.status_code
        if status == 429 or status >= 500:
            raise ProviderError(BUSY, retryable=True)
        if status >= 400:
            # Câu lỗi ra người dùng cố tình chung chung; lý do thật của
            # ElevenLabs chỉ nằm ở log, không thì 401 nào cũng thành đoán mò.
            log.warning("ElevenLabs trả %s: %s", status, response.text[:500])
        if status in (401, 403):
            raise ProviderError(OUT_OF_QUOTA if _error_status(response) == "quota_exceeded" else NOT_SET_UP)
        if status >= 400:
            detail = response.text.lower()
            if any(word in detail for word in ("safety", "moderation", "policy", "blocked", "violat")):
                raise ProviderError(DECLINED)
            raise ProviderError(REJECTED)
        if len(response.content) > MAX_RESPONSE_BYTES:
            raise ProviderError(REJECTED)
        return response


def _error_status(response: httpx.Response) -> str:
    """`detail.status` trong body lỗi của ElevenLabs (vd. `quota_exceeded`), rỗng nếu không đọc được."""
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    return str(detail.get("status") or "") if isinstance(detail, dict) else ""
