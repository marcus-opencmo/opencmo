"""Provider fal (plan Palmier P1): endpoint theo chế độ, tham số, vòng hàng đợi, giá theo
độ phân giải — không mạng (httpx.MockTransport)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx
import pytest

from opencmo.ai.catalog import SpecError, get_model, price_of, validate_spec
from opencmo.ai.providers.fal import FalProvider, build_payload, endpoint_for

UID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def _png(path: Path) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1", str(path)], check=True)
    return path


def test_gia_nhan_he_so_do_phan_giai_lam_tron_len():
    seedance = get_model("fal-seedance")
    assert price_of(seedance, {"prompt": "x", "aspectRatio": "9:16", "duration": 5, "resolution": "720p"}) == 10
    assert price_of(seedance, {"prompt": "x", "aspectRatio": "9:16", "duration": 10, "resolution": "480p"}) == 10
    assert price_of(seedance, {"prompt": "x", "aspectRatio": "9:16", "duration": 5}) == 5, "thiếu độ phân giải = hệ số 1"
    assert price_of(get_model("fal-kling"), {"prompt": "x", "aspectRatio": "9:16", "duration": 5}) == 30


@pytest.mark.parametrize(
    ("model", "spec", "message"),
    [
        ("fal-kling", {"prompt": "x", "aspectRatio": "9:16", "duration": 5, "endImage": f"{UID}/a.png"}, "settings the model does not take"),
        ("fal-seedance", {"prompt": "x", "aspectRatio": "9:16", "duration": 5, "resolution": "1080p"}, "does not support that resolution"),
        ("fal-seedance", {"prompt": "x", "aspectRatio": "9:16", "duration": 5, "startImage": "../etc/passwd"}, "not found in your library"),
        ("fal-nano-banana", {"prompt": "x", "aspectRatio": "1:1", "references": [f"{UID}/{i}.png" for i in range(5)]}, "up to 4 reference images"),
    ],
)
def test_spec_sai_theo_kha_nang_model(model, spec, message):
    with pytest.raises(SpecError, match=message):
        validate_spec(get_model(model), spec)


def test_endpoint_va_tham_so_theo_che_do(tmp_path):
    image = str(_png(tmp_path / "a.png"))
    seedance = get_model("fal-seedance")
    spec = {"prompt": "a fox", "aspectRatio": "9:16", "duration": 5, "resolution": "720p", "startImage": image, "endImage": image, "seed": 7}
    assert endpoint_for(seedance, spec).endswith("/image-to-video")
    payload = build_payload(seedance, spec)
    assert payload["duration"] == "5" and payload["resolution"] == "720p" and payload["aspect_ratio"] == "9:16"
    assert payload["image_url"].startswith("data:image/png;base64,") and payload["end_image_url"].startswith("data:")
    assert endpoint_for(seedance, {"prompt": "a fox", "aspectRatio": "9:16", "duration": 5}).endswith("/text-to-video")

    seedream = build_payload(get_model("fal-seedream"), {"prompt": "x", "aspectRatio": "9:16"})
    assert seedream["image_size"] == "portrait_16_9" and "aspect_ratio" not in seedream
    banana = get_model("fal-nano-banana")
    assert endpoint_for(banana, {"prompt": "x", "aspectRatio": "1:1", "references": [image]}).endswith("/edit")
    assert len(build_payload(banana, {"prompt": "x", "aspectRatio": "1:1", "references": [image, image]})["image_urls"]) == 2


def test_vong_hang_doi_tai_ket_qua_ve_png(tmp_path):
    png = _png(tmp_path / "out.png").read_bytes()
    seen: list[str] = []

    def api(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url}")
        if request.method == "POST":
            assert request.headers["Authorization"] == "Key k"
            assert json.loads(request.content)["prompt"] == "a fox"
            return httpx.Response(200, json={"request_id": "r1", "status_url": "https://queue.fal.run/x/requests/r1/status", "response_url": "https://queue.fal.run/x/requests/r1"})
        if request.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        return httpx.Response(200, json={"images": [{"url": "https://v3.fal.media/files/out.png"}]})

    def cdn(request: httpx.Request) -> httpx.Response:
        assert "Authorization" not in request.headers, "khoá không được đi tới host CDN"
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    provider = FalProvider(
        "k",
        client=httpx.Client(transport=httpx.MockTransport(api), headers={"Authorization": "Key k"}),
        download=httpx.Client(transport=httpx.MockTransport(cdn)),
    )
    result = provider.run(get_model("fal-nano-banana"), {"prompt": "a fox", "aspectRatio": "1:1"}, tmp_path, sleep=lambda _s: None)
    assert result is not None and result.extension == "png" and result.path.exists()
    assert seen[0].startswith("POST https://queue.fal.run/fal-ai/nano-banana")


def test_bi_tu_choi_4xx_khong_retry_429_thi_retry(tmp_path):
    from opencmo.ai.providers.base import ProviderError

    for status, retryable in ((422, False), (429, True)):
        provider = FalProvider("k", client=httpx.Client(transport=httpx.MockTransport(lambda _r, s=status: httpx.Response(s, json={}))))
        with pytest.raises(ProviderError) as info:
            provider.submit(get_model("fal-hailuo"), {"prompt": "x", "aspectRatio": "9:16", "duration": 6}, tmp_path)
        assert info.value.retryable is retryable
