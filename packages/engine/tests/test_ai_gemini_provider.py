"""GeminiProvider trên response GHI SẴN — không mạng, không khoá.

Response dựng bằng đúng hình dạng JSON REST của Gemini (camelCase, base64) qua
`model_validate` của SDK, nên SDK đổi cách đọc thì test này đỏ trước khi
production gặp. Thử thật (tốn tiền) nằm ở session có GEMINI_API_KEY.
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors, types

from opencmo.ai.catalog import get_model
from opencmo.ai.providers.base import ProviderError
from opencmo.ai.providers.gemini import BUSY, DECLINED, NOT_SET_UP, REJECTED, GeminiProvider


def _png() -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1",
         "-f", "image2pipe", "-vcodec", "png", "-"],
        capture_output=True, check=True,
    ).stdout


def _mp4(tmp: Path) -> bytes:
    out = tmp / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=72x128:r=10:d=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True,
    )
    return out.read_bytes()


def _response(parts=None, finish="STOP", block=None):
    body: dict = {"candidates": [{"content": {"role": "model", "parts": parts or []}, "finishReason": finish}]}
    if block:
        body = {"promptFeedback": {"blockReason": block}}
    return types.GenerateContentResponse.model_validate(body)


def _inline(mime: str, data: bytes) -> dict:
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}}


class FakeModels:
    def __init__(self, response=None, error=None, operation=None):
        self.response, self.error, self.operation = response, error, operation
        self.calls: list[dict] = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response

    def generate_videos(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.operation


class FakeOperations:
    def __init__(self, states):
        self.states = list(states)

    def get(self, _operation):
        return self.states.pop(0)


def _client(models, operations=None):
    return SimpleNamespace(models=models, operations=operations or FakeOperations([]))


def _probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


# ------------------------------------------------------------------ ảnh

def test_anh_gui_dung_ti_le_va_ghi_file_png(tmp_path):
    models = FakeModels(_response([_inline("image/png", _png())]))
    provider = GeminiProvider("k", client=_client(models))
    result = provider.run(get_model("gemini-image"), {"prompt": "a fox", "aspectRatio": "9:16", "seed": 4}, tmp_path)

    call = models.calls[0]
    assert call["model"] == "gemini-2.5-flash-image"
    assert call["config"].response_modalities == ["IMAGE"]
    assert call["config"].image_config.aspect_ratio == "9:16"
    assert call["config"].seed == 4
    assert result.content_type == "image/png" and result.path.read_bytes().startswith(b"\x89PNG")


def test_id_model_ghi_de_bang_env(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCMO_AI_MODEL_GEMINI_IMAGE", "gemini-3-flash-image")
    models = FakeModels(_response([_inline("image/jpeg", b"\xff\xd8jpeg")]))
    result = GeminiProvider("k", client=_client(models)).run(
        get_model("gemini-image"), {"prompt": "x", "aspectRatio": "1:1"}, tmp_path
    )
    assert models.calls[0]["model"] == "gemini-3-flash-image"
    assert (result.extension, result.content_type) == ("jpg", "image/jpeg")


@pytest.mark.parametrize("response", [
    _response(finish="IMAGE_SAFETY"),
    _response(finish="PROHIBITED_CONTENT"),
    _response(block="SAFETY"),
])
def test_bi_chan_vi_noi_dung_thi_khong_thu_lai(tmp_path, response):
    provider = GeminiProvider("k", client=_client(FakeModels(response)))
    with pytest.raises(ProviderError) as info:
        provider.run(get_model("gemini-image"), {"prompt": "x", "aspectRatio": "1:1"}, tmp_path)
    assert str(info.value) == DECLINED and info.value.retryable is False


@pytest.mark.parametrize(("error", "message", "retryable"), [
    (errors.ClientError(429, {"error": {"code": 429, "message": "Resource exhausted"}}), BUSY, True),
    (errors.ServerError(503, {"error": {"code": 503, "message": "Unavailable"}}), BUSY, True),
    (errors.ClientError(403, {"error": {"code": 403, "message": "API key not valid"}}), NOT_SET_UP, False),
    (errors.ClientError(400, {"error": {"code": 400, "message": "Blocked by safety policy"}}), DECLINED, False),
    (errors.ClientError(400, {"error": {"code": 400, "message": "Invalid argument"}}), REJECTED, False),
])
def test_loi_api_thanh_cau_tieng_anh(tmp_path, error, message, retryable):
    provider = GeminiProvider("k", client=_client(FakeModels(error=error)))
    with pytest.raises(ProviderError) as info:
        provider.run(get_model("gemini-image"), {"prompt": "x", "aspectRatio": "1:1"}, tmp_path)
    assert (str(info.value), info.value.retryable) == (message, retryable)


# ------------------------------------------------------------------ giọng

def test_giong_pcm_thanh_m4a_dung_thoi_luong(tmp_path):
    pcm = b"\x00\x00" * 24000 * 2  # 2 giây im lặng, 24 kHz mono
    models = FakeModels(_response([_inline("audio/L16;codec=pcm;rate=24000", pcm)]))
    result = GeminiProvider("k", client=_client(models)).run(
        get_model("gemini-voice"), {"prompt": "Welcome back", "voice": "Kore"}, tmp_path
    )
    config = models.calls[0]["config"]
    assert config.response_modalities == ["AUDIO"]
    assert config.speech_config.voice_config.prebuilt_voice_config.voice_name == "Kore"
    info = _probe(result.path)
    assert result.content_type == "audio/mp4"
    assert [s["codec_type"] for s in info["streams"]] == ["audio"]
    assert abs(float(info["format"]["duration"]) - 2) < 0.1


# ------------------------------------------------------------------ Veo

def _operation(done, videos=None, error=None):
    body: dict = {"name": "models/veo/operations/op1", "done": done}
    if videos is not None:
        body["response"] = {"generatedVideos": videos}
    if error:
        body["error"] = error
    return types.GenerateVideosOperation.model_validate(body)


def test_veo_hoi_lai_toi_khi_xong_roi_tai_theo_stream(tmp_path):
    video = _mp4(tmp_path)
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-goog-api-key", ""))
        return httpx.Response(200, content=video)

    models = FakeModels(operation=_operation(False))
    operations = FakeOperations([
        _operation(False),
        _operation(True, [{"video": {"uri": "https://generativelanguage.googleapis.com/v1beta/files/v:download?alt=media"}}]),
    ])
    provider = GeminiProvider("secret", client=_client(models, operations), http=httpx.Client(transport=httpx.MockTransport(handler)))
    sleeps: list[float] = []
    result = provider.run(
        get_model("gemini-video"), {"prompt": "waves", "aspectRatio": "9:16", "duration": 8}, tmp_path,
        sleep=sleeps.append,
    )
    config = models.calls[0]["config"]
    assert (config.aspect_ratio, config.duration_seconds, config.number_of_videos) == ("9:16", 8, 1)
    assert sleeps == [provider.poll_seconds], "hỏi lại một lần rồi mới xong"
    assert seen == ["secret"], "khoá đi trong header, không trong URL"
    assert result.content_type == "video/mp4" and _probe(result.path)["streams"][0]["width"] == 72


def test_veo_khong_gui_seed_qua_developer_api(tmp_path):
    # Production 29/09: SDK ném "seed parameter is only supported in … Agent
    # Platform mode" khi dựng request, nên MỌI lượt Veo hỏng. Client giả không
    # kiểm gì — chạy config vừa gửi qua đúng hàm map của SDK ở chế độ API key.
    from google import genai
    from google.genai.models import _GenerateVideosParameters_to_mldev

    models = FakeModels(operation=_operation(False))
    operations = FakeOperations([_operation(True, [])])
    provider = GeminiProvider("k", client=_client(models, operations))
    with pytest.raises(ProviderError):
        provider.run(
            get_model("gemini-video"), {"prompt": "x", "aspectRatio": "9:16", "duration": 4, "seed": 7},
            tmp_path, sleep=lambda _s: None,
        )
    call = models.calls[0]
    assert call["config"].seed is None
    real = genai.Client(api_key="k")
    _GenerateVideosParameters_to_mldev(
        real._api_client, {"model": call["model"], "prompt": call["prompt"], "config": call["config"]}
    )


def test_veo_nhan_anh_dau_va_cho_phep_nguoi_lon(tmp_path):
    # G2: image-to-video. Ảnh đi dưới dạng bytes + mime; request phải dựng được qua
    # đúng hàm map của SDK ở chế độ API key (cùng cách bắt lỗi seed 29/09).
    from google import genai
    from google.genai.models import _GenerateVideosParameters_to_mldev

    still = tmp_path / "start.png"
    still.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    models = FakeModels(operation=_operation(False))
    provider = GeminiProvider("k", client=_client(models, FakeOperations([_operation(True, [])])))
    with pytest.raises(ProviderError):
        provider.run(
            get_model("gemini-video"), {"prompt": "x", "aspectRatio": "9:16", "duration": 4, "startImage": str(still)},
            tmp_path, sleep=lambda _s: None,
        )
    call = models.calls[0]
    assert call["image"].mime_type == "image/png" and call["image"].image_bytes == still.read_bytes()
    assert call["config"].person_generation == "allow_adult"
    real = genai.Client(api_key="k")
    _GenerateVideosParameters_to_mldev(
        real._api_client, {"model": call["model"], "prompt": call["prompt"], "image": call["image"], "config": call["config"]}
    )


def test_veo_khong_anh_thi_khong_gui_image(tmp_path):
    models = FakeModels(operation=_operation(False))
    provider = GeminiProvider("k", client=_client(models, FakeOperations([_operation(True, [])])))
    with pytest.raises(ProviderError):
        provider.run(get_model("gemini-video"), {"prompt": "x", "aspectRatio": "9:16", "duration": 4}, tmp_path, sleep=lambda _s: None)
    assert "image" not in models.calls[0] and models.calls[0]["config"].person_generation is None


def test_veo_xong_ma_khong_co_video_la_bi_loc(tmp_path):
    provider = GeminiProvider("k", client=_client(FakeModels(operation=_operation(False)), FakeOperations([_operation(True, [])])))
    with pytest.raises(ProviderError, match="declined"):
        provider.run(get_model("gemini-video"), {"prompt": "x", "aspectRatio": "16:9", "duration": 4}, tmp_path, sleep=lambda _s: None)


def test_veo_bi_huy_giua_chung_thi_dung_hoi(tmp_path):
    provider = GeminiProvider("k", client=_client(FakeModels(operation=_operation(False)), FakeOperations([])))
    result = provider.run(
        get_model("gemini-video"), {"prompt": "x", "aspectRatio": "16:9", "duration": 4}, tmp_path,
        alive=lambda: False,
    )
    assert result is None


def test_thieu_khoa_thi_hong_ngay_voi_cau_ro_rang(monkeypatch):
    from opencmo.ai.catalog import SpecError
    from opencmo.ai.providers import adapter_for

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(SpecError, match="not set up"):
        adapter_for(get_model("gemini-voice"))
