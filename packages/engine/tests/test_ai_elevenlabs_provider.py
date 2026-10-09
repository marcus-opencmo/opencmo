"""ElevenLabsProvider bằng response thu sẵn — không gọi API thật (chưa có khoá)."""

from __future__ import annotations

import base64
import json
import subprocess

import httpx
import pytest

from opencmo.ai.catalog import get_model
from opencmo.ai.providers import adapter_for
from opencmo.ai.providers.base import ProviderError
from opencmo.ai.providers.elevenlabs import ElevenLabsProvider, words_from_alignment
from opencmo.ai.providers.fake import FakeProvider
from opencmo.worker import generate_task

TEXT = "Hi there, world"


def _alignment(text: str, step: float = 0.1) -> dict:
    return {
        "characters": list(text),
        "character_start_times_seconds": [round(i * step, 3) for i in range(len(text))],
        "character_end_times_seconds": [round((i + 1) * step, 3) for i in range(len(text))],
    }


@pytest.fixture(scope="module")
def mp3(tmp_path_factory) -> bytes:
    out = tmp_path_factory.mktemp("el") / "voice.mp3"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=1.5",
        "-c:a", "libmp3lame", "-b:a", "64k", str(out),
    ], check=True)
    return out.read_bytes()


def _provider(handler) -> ElevenLabsProvider:
    return ElevenLabsProvider("secret", http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_gom_ky_tu_thanh_tu():
    words = words_from_alignment(_alignment(TEXT))
    assert [w["text"] for w in words] == ["Hi", "there,", "world"]
    assert words[0] == {"text": "Hi", "start": 0.0, "end": 0.2}
    assert words[2]["start"] == 1.0 and words[2]["end"] == 1.5


def test_can_chinh_lech_do_dai_thi_bo():
    broken = _alignment(TEXT)
    broken["character_end_times_seconds"].pop()
    assert words_from_alignment(broken) == []
    assert words_from_alignment(None) == []


def test_giong_ra_m4a_kem_moc_chu(tmp_path, mp3):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("xi-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"audio_base64": base64.b64encode(mp3).decode(), "alignment": _alignment(TEXT)})

    result = _provider(handler).run(get_model("elevenlabs-voice"), {"prompt": TEXT, "voice": "Roger", "seed": 7}, tmp_path)
    assert "/v1/text-to-speech/CwhRBWXzGAHq8TQ4Fs17/with-timestamps" in seen["url"]
    assert seen["key"] == "secret"
    assert seen["body"] == {"text": TEXT, "model_id": "eleven_multilingual_v2", "seed": 7}
    assert result.extension == "m4a" and result.content_type == "audio/mp4"
    assert [w["text"] for w in result.words] == ["Hi", "there,", "world"]
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(result.path)],
                           capture_output=True, text=True, check=True)
    assert probe.stdout.strip() == "aac"


@pytest.mark.parametrize(("status", "body", "retryable", "message"), [
    (429, "too many", True, "busy"),
    (503, "down", True, "busy"),
    (401, "bad key", False, "not set up"),
    (400, "text violates our moderation policy", False, "declined"),
    (422, "invalid", False, "could not run"),
])
def test_loi_http_thanh_cau_tieng_anh(tmp_path, status, body, retryable, message):
    provider = _provider(lambda _r: httpx.Response(status, text=body))
    with pytest.raises(ProviderError) as info:
        provider.run(get_model("elevenlabs-voice"), {"prompt": TEXT, "voice": "Aria"}, tmp_path)
    assert info.value.retryable is retryable
    assert message in str(info.value).lower()


def test_het_quota_khong_bao_la_chua_cai_dat(tmp_path, caplog):
    # ElevenLabs trả 401 cho CẢ khoá sai lẫn hết quota (quota riêng của khoá
    # hay của tài khoản). Gộp làm "not set up" là dắt người vận hành đi kiểm
    # khoá trong khi khoá vẫn đúng — đo thật 30/09: khoá giới hạn 20 credit.
    body = {"detail": {"status": "quota_exceeded", "message": "This request exceeds your API key quota of 20."}}
    provider = _provider(lambda _r: httpx.Response(401, json=body))
    with pytest.raises(ProviderError) as info, caplog.at_level("WARNING"):
        provider.run(get_model("elevenlabs-voice"), {"prompt": TEXT, "voice": "Aria"}, tmp_path)
    assert not info.value.retryable
    assert "not set up" not in str(info.value).lower()
    assert "temporarily unavailable" in str(info.value).lower()
    assert "quota of 20" in caplog.text


def test_mat_mang_la_loi_tam(tmp_path):
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(ProviderError) as info:
        _provider(handler).run(get_model("elevenlabs-voice"), {"prompt": TEXT, "voice": "Aria"}, tmp_path)
    assert info.value.retryable


def test_giong_doi_id_bang_env(tmp_path, mp3, monkeypatch):
    monkeypatch.setenv("OPENCMO_ELEVENLABS_VOICES", json.dumps({"Aria": "new-id"}))
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"audio_base64": base64.b64encode(mp3).decode()})

    result = _provider(handler).run(get_model("elevenlabs-voice"), {"prompt": TEXT, "voice": "Aria"}, tmp_path)
    assert "/new-id/" in seen["url"]
    assert result.words is None, "không có căn chỉnh thì không bịa mốc"


def test_thieu_khoa_thi_chua_bat(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with pytest.raises(Exception, match="not set up"):
        adapter_for(get_model("elevenlabs-voice"))
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    assert isinstance(adapter_for(get_model("elevenlabs-voice")), ElevenLabsProvider)


def test_giong_gia_co_moc_chu_deu(tmp_path):
    result = FakeProvider().run(get_model("fake-voice"), {"prompt": "one two three four five", "voice": "Test B"}, tmp_path)
    assert [w["text"] for w in result.words] == ["one", "two", "three", "four", "five"]
    assert result.words[-1]["end"] <= 2.0


def test_task_chot_giong_kem_moc_chu(monkeypatch):
    from tests.test_worker_generate_task import GEN_ID, FakeStore, _task

    monkeypatch.setenv("OPENCMO_AI_FAKE", "1")
    spec = {"prompt": "hello brave new world", "voice": "Test A"}
    store = FakeStore({
        "id": GEN_ID, "task_id": "task-1", "user_id": "user-1", "job_id": "job-1",
        "model": "fake-voice", "spec": spec, "spec_hash": generate_task.spec_hash("fake-voice", spec),
    })
    generate_task.process(store, _task())
    assert store.failed == []
    assert [w["text"] for w in store.completed["words"]] == ["hello", "brave", "new", "world"]


def _long_mp3(tmp_path, seconds: float) -> bytes:
    path = tmp_path / "long.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=d={seconds}", "-c:a", "libmp3lame", str(path)], check=True)
    return path.read_bytes()


def _duration(path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout)


def test_sfx_goi_sound_generation_va_cat_dung_so_giay(tmp_path):
    audio = _long_mp3(tmp_path, 3.4)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=audio, headers={"content-type": "audio/mpeg"})

    result = _provider(handler).run(get_model("elevenlabs-sfx"), {"prompt": "a whoosh", "duration": 3}, tmp_path)
    request = seen[0]
    assert request.url.path == "/v1/sound-generation"
    assert json.loads(request.content) == {"text": "a whoosh", "duration_seconds": 3, "model_id": "eleven_text_to_sound_v2", "prompt_influence": 0.3}
    assert request.headers["xi-api-key"] == "secret"
    assert result.content_type == "audio/mp4" and abs(_duration(result.path) - 3) < 0.1, "đúng số giây đã trả tiền"


def test_nhac_luon_khong_loi(tmp_path):
    audio = _long_mp3(tmp_path, 10.5)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=audio)

    result = _provider(handler).run(get_model("elevenlabs-music"), {"prompt": "calm lo-fi, 80 bpm", "duration": 10}, tmp_path)
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/music"
    assert body == {"prompt": "calm lo-fi, 80 bpm", "music_length_ms": 10000, "model_id": "music_v1", "force_instrumental": True}
    assert abs(_duration(result.path) - 10) < 0.1


def test_am_thanh_rong_hay_bi_chan_la_loi_nguoi_dung_doc_duoc(tmp_path):
    with pytest.raises(ProviderError):
        _provider(lambda _r: httpx.Response(200, content=b"")).run(get_model("elevenlabs-sfx"), {"prompt": "x", "duration": 2}, tmp_path)
    with pytest.raises(ProviderError, match="declined|policy|blocked"):
        _provider(lambda _r: httpx.Response(400, text='{"detail":"blocked by safety policy"}')).run(
            get_model("elevenlabs-music"), {"prompt": "x", "duration": 10}, tmp_path,
        )
