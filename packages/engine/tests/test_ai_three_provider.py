"""Provider `opencmo-3d` (3D Studio): chọn adapter theo env, kiểm spec `scene`,
và đường Modal (spawn → hỏi lại → ghi bytes) bằng SDK giả — không cần GPU."""

from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from opencmo.ai import catalog
from opencmo.ai.catalog import SpecError, get_model, validate_spec
from opencmo.ai.providers import adapter_for, three
from opencmo.ai.providers.base import Poll, ProviderError
from opencmo.ai.providers.fake import FakeProvider
from opencmo.ai.providers.three import ThreeLocalProvider, ThreeModalProvider, render_payload

SPEC = {
    "prompt": "Revenue $2.4M",
    "aspectRatio": "9:16",
    "duration": 5,
    "scene": {"template": "number", "value": 2400000, "prefix": "$"},
}


def test_scene_chi_hop_le_voi_model_3d() -> None:
    validate_spec(get_model("studio-3d"), SPEC)
    with pytest.raises(SpecError, match="does not take"):
        validate_spec(get_model("fake-video"), {**SPEC, "aspectRatio": "9:16", "duration": 4})


@pytest.mark.parametrize(
    ("scene", "message"),
    [
        (None, "Describe the 3D scene"),
        ({"value": 1}, "Describe the 3D scene"),
        ({"template": "bars", "title": "x" * 4100}, "too much data"),
    ],
)
def test_scene_hong_bi_chan(scene: object, message: str) -> None:
    spec = {**SPEC, "scene": scene} if scene is not None else {k: v for k, v in SPEC.items() if k != "scene"}
    with pytest.raises(SpecError, match=message):
        validate_spec(get_model("studio-3d"), spec)


def test_gia_mot_credit_moi_luot() -> None:
    assert catalog.price_of(get_model("studio-3d"), SPEC) == 1


def test_adapter_theo_env(monkeypatch: pytest.MonkeyPatch) -> None:
    model = get_model("studio-3d")
    monkeypatch.delenv("OPENCMO_3D", raising=False)
    monkeypatch.delenv("OPENCMO_AI_FAKE", raising=False)
    with pytest.raises(SpecError, match="not set up"):
        adapter_for(model)
    monkeypatch.setenv("OPENCMO_AI_FAKE", "1")
    assert isinstance(adapter_for(model), FakeProvider)
    monkeypatch.setenv("OPENCMO_3D", "local")
    assert isinstance(adapter_for(model), ThreeLocalProvider)


def test_payload_chi_mang_phan_cli_doc() -> None:
    assert render_payload({**SPEC, "seed": 7}) == {
        "scene": SPEC["scene"], "aspectRatio": "9:16", "duration": 5, "seed": 7,
    }
    assert "seed" not in render_payload(SPEC)


def test_local_ma_3_la_spec_hong_khong_retry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: subprocess.CompletedProcess(a[0], 3, "", "spec không hợp lệ"),
    )
    with pytest.raises(ProviderError) as info:
        three.render_local(render_payload(SPEC), tmp_path)
    assert str(info.value) == three.INVALID
    assert not info.value.retryable


class _Call:
    def __init__(self, results: list[object]) -> None:
        self.object_id = "fc-1"
        self._results = results

    def get(self, timeout: float = 0) -> object:
        value = self._results.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


def _modal(call: _Call, spawned: list[dict]) -> SimpleNamespace:
    def spawn(payload: dict) -> _Call:
        spawned.append(payload)
        return call

    return SimpleNamespace(
        Function=SimpleNamespace(from_name=lambda app, name: SimpleNamespace(spawn=spawn)),
        FunctionCall=SimpleNamespace(from_id=lambda ref: call),
    )


def test_modal_spawn_hoi_lai_roi_ghi_file(tmp_path: Path) -> None:
    spawned: list[dict] = []
    call = _Call([TimeoutError(), b"\x00\x00\x00\x18ftypmp42"])
    adapter = ThreeModalProvider(_modal(call, spawned))
    result = adapter.run(get_model("studio-3d"), SPEC, tmp_path, sleep=lambda _: None)
    assert result is not None
    assert result.path.read_bytes().startswith(b"\x00\x00\x00\x18ftyp")
    assert result.content_type == "video/mp4"
    assert spawned == [render_payload(SPEC)]


def test_modal_loi_trong_ham_gpu_la_hong(tmp_path: Path) -> None:
    call = _Call([RuntimeError("Vulkan exploded")])
    adapter = ThreeModalProvider(_modal(call, []))
    with pytest.raises(ProviderError, match="3D render failed"):
        adapter.run(get_model("studio-3d"), SPEC, tmp_path, sleep=lambda _: None)


def test_modal_giu_cau_loi_spec(tmp_path: Path) -> None:
    call = _Call([ProviderError(three.INVALID)])
    adapter = ThreeModalProvider(_modal(call, []))
    with pytest.raises(ProviderError) as info:
        adapter.run(get_model("studio-3d"), SPEC, tmp_path, sleep=lambda _: None)
    assert str(info.value) == three.INVALID


# ---------------------------------------------------------------- cảnh code

CODE_SPEC = {**SPEC, "scene": {"template": "code", "code_ref": "a" * 64, "title": "Staircase"}}


def test_canh_code_can_code_ref_hex() -> None:
    validate_spec(get_model("studio-3d"), CODE_SPEC)
    for bad in ({"template": "code"}, {"template": "code", "code_ref": "XYZ"}):
        with pytest.raises(SpecError, match="code was not found"):
            validate_spec(get_model("studio-3d"), {**SPEC, "scene": bad})


def test_payload_mang_code_khi_worker_gan_vao() -> None:
    assert render_payload({**CODE_SPEC, "code": "return (t) => {};"})["code"] == "return (t) => {};"
    assert "code" not in render_payload(CODE_SPEC)


def test_local_ma_4_la_code_hong_khong_retry_va_noi_ly_do(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # CLI in câu lỗi của code ở dòng cuối stderr (spec code-scenes): agent cần nó để sửa.
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: subprocess.CompletedProcess(a[0], 4, "", "3d: …\nnope is not defined"),
    )
    with pytest.raises(ProviderError) as info:
        three.render_local(render_payload(CODE_SPEC), tmp_path)
    assert str(info.value) == "The 3D scene code failed: nope is not defined. Your credits were refunded."
    assert not info.value.retryable


def test_modal_giu_cau_loi_code(tmp_path: Path) -> None:
    message = "The 3D scene code failed: nope is not defined. Your credits were refunded."
    call = _Call([ProviderError(message)])
    provider = ThreeModalProvider(_modal(call, []))
    ref = provider.submit(get_model("studio-3d"), CODE_SPEC, tmp_path)
    assert provider.poll(ref) == Poll("failed", message)
