"""Catalog model sinh media — đọc `packages/contracts/ai-models.json`.

Worker là lớp kiểm THỨ BA (sau zod ở route và `create_generation` trong SQL):
lớp nào cũng có thể là lớp duy nhất còn sống sau một lần refactor, nên spec
được kiểm lại ở đây trước khi gọi provider — gọi provider là tốn tiền thật.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

# Máy dev: packages/engine/opencmo/ai/catalog.py → packages/contracts.
# Modal: modal_app.py chép file vào /root/contracts.
_CANDIDATES = (
    Path(__file__).resolve().parents[3] / "contracts" / "ai-models.json",
    Path("/root/contracts/ai-models.json"),
)


class SpecError(ValueError):
    """Spec không hợp lệ với model; câu chữ là tiếng Anh, lên thẳng màn hình."""


@dataclass(frozen=True)
class AiModel:
    id: str
    kind: str
    provider: str
    name: str
    price: dict[str, Any]
    limits: dict[str, Any]
    provider_model: str = ""
    #: Endpoint phụ theo chế độ (aggregator): `image` = ảnh→video, `edit` = ảnh có tham chiếu.
    provider_models: dict[str, str] | None = None

    def remote_id(self) -> str:
        """Id model phía provider. `OPENCMO_AI_MODEL_<ID>` ghi đè: provider đổi
        tên model (preview → GA) thì chốt lại bằng env, không phải sửa catalog."""
        key = "OPENCMO_AI_MODEL_" + self.id.upper().replace("-", "_")
        return os.environ.get(key) or self.provider_model or self.id


def catalog_path() -> Path:
    override = os.environ.get("OPENCMO_AI_MODELS")
    if override:
        return Path(override)
    for candidate in _CANDIDATES:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("packages/contracts/ai-models.json not found")


@lru_cache(maxsize=1)
def load_models() -> dict[str, AiModel]:
    data = json.loads(catalog_path().read_text(encoding="utf-8"))
    return {
        row["id"]: AiModel(
            id=row["id"], kind=row["kind"], provider=row["provider"],
            name=row["name"], price=row["price"], limits=row["limits"],
            provider_model=row.get("providerModel", ""),
            provider_models=row.get("providerModels"),
        )
        for row in data["models"]
    }


def with_row(model: AiModel, row: dict[str, Any] | None) -> AiModel:
    """Catalog trong DB (G5) đè giá + giới hạn của JSON; hàng tắt = model không dùng được.

    JSON giữ phần chỉ code cần (`providerModel`, endpoint phụ); giá và giới hạn đổi được trong DB
    mà không deploy — và phải khớp `ai_check_spec`/`ai_price` (SQL đọc đúng hàng này)."""
    if row is None:
        return model
    if row.get("enabled") is False:
        raise SpecError("This model is not available.")
    return replace(
        model,
        price=row["price"] if isinstance(row.get("price"), dict) else model.price,
        limits=row["limits"] if isinstance(row.get("limits"), dict) else model.limits,
    )


def get_model(model_id: str) -> AiModel:
    model = load_models().get(model_id)
    if model is None:
        raise SpecError("This model is not available.")
    return model


_ALLOWED = {
    "image": {"prompt", "aspectRatio", "seed"},
    "video": {"prompt", "aspectRatio", "duration", "seed"},
    "voice": {"prompt", "voice", "seed"},
    "audio": {"prompt", "duration", "seed"},
}


#: Cùng câu với `ai_check_spec` (SQL): code_ref thiếu, sai dạng, hay không phải của người gọi.
CODE_NOT_FOUND = "This 3D scene code was not found. Preview it again."

#: Trần cỡ `scene` (JSON) của model 3D Studio — cùng số với `ai_check_spec`.
SCENE_MAX_BYTES = 4000


def _check_scene(scene: Any) -> None:
    """Chỉ kiểm hình dạng: luật đầy đủ là zod `SceneContentSchema` (lớp 1, route)
    và chính renderer `clip-three` (parse lại, mã thoát 3 = spec hỏng)."""
    if not isinstance(scene, dict) or not isinstance(scene.get("template"), str):
        raise SpecError("Describe the 3D scene first.")
    if len(json.dumps(scene, separators=(",", ":"), ensure_ascii=False).encode()) > SCENE_MAX_BYTES:
        raise SpecError("This 3D scene has too much data.")
    # Cảnh code (spec code-scenes): code nằm ở scene_codes, scene chỉ mang sha256 của nó.
    if scene["template"] == "code" and not (
        isinstance(scene.get("code_ref"), str) and re.fullmatch(r"[0-9a-f]{64}", scene["code_ref"])
    ):
        raise SpecError(CODE_NOT_FOUND)


MEDIA_NOT_FOUND = "That image was not found in your library."
VIDEO_NOT_FOUND = "Choose a video from your library to edit."
_MEDIA_REF = re.compile(r"[0-9a-f-]{36}/.+")


def media_ref_ok(ref: Any) -> bool:
    """Hình dạng tên object media (`<uid>/…`); chủ sở hữu kiểm ở SQL và ở worker theo chủ task."""
    return isinstance(ref, str) and len(ref) <= 500 and bool(_MEDIA_REF.fullmatch(ref)) and ".." not in ref


def capability_keys(model: AiModel) -> set[str]:
    """Trường spec theo khả năng model — cùng bộ với `ai_check_spec` (SQL)."""
    keys: set[str] = set()
    limits = model.limits
    if model.kind in ("image", "video"):
        if limits.get("resolutions"):
            keys.add("resolution")
        if int(limits.get("maxReferences") or 0) > 0:
            keys.add("references")
    if model.kind == "video":
        if limits.get("firstFrame"):
            keys.add("startImage")
        if limits.get("lastFrame"):
            keys.add("endImage")
        if limits.get("audio"):
            keys.add("audio")
        if limits.get("sourceVideo"):
            keys |= {"sourceVideo", "sourceStart"}
    return keys


def validate_spec(model: AiModel, spec: dict[str, Any]) -> None:
    """Cùng luật với `specSchema` (TS) và `ai_check_spec` (SQL)."""
    allowed = _ALLOWED[model.kind] | ({"scene"} if model.limits.get("scene") else set()) | capability_keys(model)
    extra = set(spec) - allowed
    if extra:
        raise SpecError("This request has settings the model does not take.")
    prompt = spec.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise SpecError("Write a prompt first.")
    if len(prompt) > int(model.limits["maxPromptChars"]):
        raise SpecError(f"Keep the prompt under {model.limits['maxPromptChars']} characters.")
    seed = spec.get("seed")
    if seed is not None and (not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647):
        raise SpecError("Invalid seed.")
    if model.kind in ("image", "video") and spec.get("aspectRatio") not in model.limits.get(
        "aspectRatios", []
    ):
        raise SpecError(f"{model.name} does not support that aspect ratio.")
    if model.kind == "video" and spec.get("duration") not in model.limits.get("durations", []):
        raise SpecError(f"{model.name} does not support that duration.")
    if "resolution" in spec and spec["resolution"] not in model.limits.get("resolutions", []):
        raise SpecError(f"{model.name} does not support that resolution.")
    if "audio" in spec and not isinstance(spec["audio"], bool):
        raise SpecError("Invalid generation request.")
    for key in ("startImage", "endImage"):
        if key in spec and not media_ref_ok(spec[key]):
            raise SpecError(MEDIA_NOT_FOUND)
    if model.limits.get("sourceVideo"):
        if not media_ref_ok(spec.get("sourceVideo")):
            raise SpecError(VIDEO_NOT_FOUND)
        start = spec.get("sourceStart")
        if isinstance(start, bool) or not isinstance(start, (int, float)) or start < 0:
            raise SpecError("Invalid generation request.")
    if "references" in spec:
        refs, cap = spec["references"], int(model.limits.get("maxReferences") or 0)
        if not isinstance(refs, list) or not 1 <= len(refs) <= cap:
            raise SpecError(f"{model.name} takes up to {cap} reference images.")
        if not all(media_ref_ok(ref) for ref in refs):
            raise SpecError(MEDIA_NOT_FOUND)
    if model.limits.get("scene"):
        _check_scene(spec.get("scene"))
    if model.kind == "voice" and spec.get("voice") not in model.limits.get("voices", []):
        raise SpecError("Choose one of the listed voices.")
    if model.kind == "audio":
        duration = spec.get("duration")
        low, high = model.limits.get("minSeconds", 1), model.limits.get("maxSeconds", 22)
        if not isinstance(duration, int) or not low <= duration <= high:
            raise SpecError(f"Sounds are {low} to {high} seconds long.")


def price_of(model: AiModel, spec: dict[str, Any]) -> int:
    """Cùng công thức với `priceOf` (TS) và `ai_price` (SQL): giá gốc × hệ số độ phân giải, làm tròn lên."""
    unit, credits = model.price["unit"], int(model.price["credits"])
    if unit == "generation":
        base = credits
    elif unit == "second":
        base = credits * math.ceil(float(spec.get("duration") or 1))
    elif unit == "kchars":
        base = credits * max(1, math.ceil(len(str(spec["prompt"]).strip()) / 1000))
    else:
        raise SpecError("This model is not available.")
    factor = (model.price.get("resolution") or {}).get(spec.get("resolution") or "", 1)
    return math.ceil(base * factor)
