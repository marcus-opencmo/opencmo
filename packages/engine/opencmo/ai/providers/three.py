"""Provider `opencmo-3d` — 3D Studio (spec 2026-09-30-studio-3d).

Không có bên thứ ba: cảnh three.js của `packages/clip-three` render trong
Chromium headless rồi ghép MP4 bằng ffmpeg. Hai chỗ chạy:

- `OPENCMO_3D=modal`: hàm `render_three` trên GPU L4 của Modal (image riêng có
  Chromium + ANGLE/EGL). Worker chỉ spawn rồi hỏi lại — container GPU tách khỏi
  job nên không ăn vào trần RAM 2GB của worker.
- `OPENCMO_3D=local`: chạy thẳng CLI `clip-three` trên máy này (SwiftShader,
  ~3 s/khung ở 720² — chỉ để dev; `OPENCMO_3D_SCALE` thu nhỏ khung cho kịp).

Spec hỏng (CLI thoát mã 3) không bao giờ retry: gọi lại là cùng một lời từ chối.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from opencmo.ai.catalog import AiModel
from opencmo.ai.providers.base import Poll, ProviderAdapter, ProviderError, Result

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[5]
CLIP_THREE = Path(os.environ.get("OPENCMO_CLIP_THREE", _REPO / "packages/clip-three/src/cli.ts"))

INVALID = "This 3D scene is not valid. Your credits were refunded."
FAILED = "The 3D render failed. Your credits were refunded."
BUSY = "The 3D renderer is busy. We will try again shortly."
#: Code của cảnh hỏng khi render (mã thoát 4): lỗi của code agent viết, không
#: retry. Kèm câu của JS engine để agent biết sửa gì.
CODE_FAILED = "The 3D scene code failed"


def code_failed(detail: str) -> str:
    detail = " ".join(detail.split())[:200].rstrip(".") or "unknown error"
    return f"{CODE_FAILED}: {detail}. Your credits were refunded."

#: Trần một lượt render: 10 giây × 30 khung trên GPU cỡ vài chục giây; CPU
#: (dev) ở khung đầy đủ có thể tới hàng chục phút — đặt OPENCMO_3D_SCALE.
RENDER_TIMEOUT = int(os.environ.get("OPENCMO_3D_TIMEOUT", "1500"))
#: MP4 10 giây 1080×1920 crf 16 cỡ 10–30MB; lớn hơn nhiều là có gì sai.
MAX_BYTES = 200 * 1024 * 1024

MODAL_APP = "opencmo"
MODAL_FUNCTION = "render_three"


def render_payload(spec: dict[str, Any]) -> dict[str, Any]:
    """Đúng phần spec Generate mà CLI đọc (`fromGeneration`)."""
    # `code`: chỉ có ở cảnh code, worker gắn vào sau khi tải theo `scene.code_ref`.
    payload = {key: spec[key] for key in ("scene", "aspectRatio", "duration", "code") if key in spec}
    if spec.get("seed") is not None:
        payload["seed"] = spec["seed"]
    return payload


def render_local(payload: dict[str, Any], workdir: Path, *, gpu: bool = False) -> Path:
    """Chạy CLI `clip-three`, trả đường dẫn MP4. Ném ProviderError tiếng Anh."""
    spec_file = workdir / "scene.json"
    spec_file.write_text(json.dumps(payload), encoding="utf-8")
    out = workdir / "result.mp4"
    env = {**os.environ, "OPENCMO_3D_GPU": "1" if gpu else os.environ.get("OPENCMO_3D_GPU", "0")}
    try:
        proc = subprocess.run(
            ["node", str(CLIP_THREE), str(spec_file), str(out)],
            capture_output=True, text=True, timeout=RENDER_TIMEOUT, env=env, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ProviderError(FAILED) from exc
    if proc.returncode == 4:
        lines = proc.stderr.strip().splitlines()
        log.warning("code cảnh hỏng: %s", proc.stderr.strip()[-400:])
        raise ProviderError(code_failed(lines[-1] if lines else ""))
    if proc.returncode == 3:
        log.warning("clip-three từ chối spec: %s", proc.stderr.strip()[-400:])
        raise ProviderError(INVALID)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        log.error("clip-three hỏng (mã %s): %s", proc.returncode, proc.stderr.strip()[-1500:])
        raise ProviderError(FAILED)
    # Dòng cuối stderr là số đo (ms/khung, renderer) — giữ trong log để so GPU/CPU.
    log.info("clip-three: %s", proc.stdout.strip() or proc.stderr.strip().splitlines()[-1:])
    return out


def _result(path: Path) -> Result:
    return Result(path=path, content_type="video/mp4", extension="mp4")


class ThreeLocalProvider(ProviderAdapter):
    poll_seconds = 0.0
    timeout_seconds = float(RENDER_TIMEOUT)

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        return str(render_local(render_payload(spec), workdir))

    def poll(self, ref: str) -> Poll:
        return Poll("done")

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        return _result(Path(ref))


class ThreeModalProvider(ProviderAdapter):
    """Spawn `render_three` trên GPU, hỏi lại theo call id, ghi bytes ra đĩa."""

    poll_seconds = 3.0
    timeout_seconds = 600.0

    def __init__(self, functions: Any = None) -> None:
        # `functions` để test thay Modal bằng đồ giả; mặc định là SDK thật.
        if functions is None:
            import modal

            functions = modal
        self._modal = functions
        self._workdir: Path | None = None
        self._done: dict[str, Path] = {}

    def submit(self, model: AiModel, spec: dict[str, Any], workdir: Path) -> str:
        self._workdir = workdir
        try:
            function = self._modal.Function.from_name(MODAL_APP, MODAL_FUNCTION)
            call = function.spawn(render_payload(spec))
        except Exception as exc:
            log.warning("Không spawn được %s: %s", MODAL_FUNCTION, exc)
            raise ProviderError(BUSY, retryable=True) from exc
        return str(call.object_id)

    def poll(self, ref: str) -> Poll:
        if ref in self._done:
            return Poll("done")
        call = self._modal.FunctionCall.from_id(ref)
        try:
            data = call.get(timeout=0)
        except TimeoutError:
            return Poll("running")
        except Exception as exc:  # noqa: BLE001 — mọi lỗi của hàm GPU về đây
            # Lỗi trong hàm GPU về đây dạng exception của chính nó: ProviderError
            # được pickle qua Modal giữ nguyên message; lỗi khác là hỏng.
            text = str(exc)
            message = text if text in (INVALID, FAILED, BUSY) or text.startswith(f"{CODE_FAILED}: ") else FAILED
            return Poll("failed", message)
        if not isinstance(data, (bytes, bytearray)) or not data or len(data) > MAX_BYTES:
            return Poll("failed", FAILED)
        assert self._workdir is not None
        path = self._workdir / "result.mp4"
        path.write_bytes(data)
        self._done[ref] = path
        return Poll("done")

    def fetch(self, ref: str, dest_dir: Path) -> Result:
        return _result(self._done[ref])
