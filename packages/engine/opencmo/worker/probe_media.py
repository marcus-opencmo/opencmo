"""Kiểm media upload (video B-roll, ảnh) trước khi cho phép đưa vào revision.

Ảnh (plan Palmier P2-b/P4): frame chụp từ clip cho AI transition và ảnh tham chiếu
của người dùng. Không có thời lượng; đọc được một frame là đủ. Ảnh chỉ đi tới model
sinh sau khi `generate_task` kiểm duyệt lại.
"""

from __future__ import annotations

import json
import logging
import math
import tempfile
from pathlib import Path
from typing import Any

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.media.ffmpeg import USER_INPUT, run
from opencmo.media.probe import probe_file
from opencmo.worker.task_run import task_workspace

log = logging.getLogger(__name__)

MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 30 * 1024 * 1024
# LUT 65³ dạng chữ ~8 MB; trần 12 MB đủ mọi LUT thật mà không cho file rác lớn.
MAX_LUT_BYTES = 12 * 1024 * 1024
# Lottie: JSON có ảnh nhúng base64 có thể vài MB; trần 8 MB đủ mọi hoạt hình thật.
MAX_LOTTIE_BYTES = 8 * 1024 * 1024
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
BAD_MEDIA = "Choose a playable video, a PNG, JPEG or WebP image, a Lottie .json animation, or a 3D .cube LUT."


def cube_size(text: str) -> int:
    """Kích thước của LUT 3D `.cube` hợp lệ (cùng luật `parseCube` của clip-render), ném
    ValueError khi không dùng được. Worker kiểm trước để export không gặp file hỏng."""
    size = 0
    count = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head = line.split()
        keyword = head[0].upper()
        if keyword == "LUT_1D_SIZE":
            raise ValueError("1D LUTs are not supported")
        if keyword == "LUT_3D_SIZE":
            size = int(head[1])
            if not 2 <= size <= 65:
                raise ValueError("Unsupported LUT size")
            continue
        if keyword in {"TITLE", "DOMAIN_MIN", "DOMAIN_MAX"} or keyword.replace("_", "").isalpha():
            continue
        values = [float(value) for value in head]
        if len(values) != 3 or not all(math.isfinite(value) for value in values):
            raise ValueError("Damaged LUT line")
        count += 1
    if not size or count != size**3:
        raise ValueError("LUT row count does not match its size")
    return size


def process(store: Any, task: Task) -> None:
    if not task.asset_id:
        # `complete_media_probe` tra theo asset_id; không có id thì không hàng
        # nào khớp, RPC trả false và task nằm `running` tới hết lease rồi mới
        # failed sau đủ số lần thử. Chốt hỏng ngay tại đây.
        store.fail_task(task.id, task.attempt_id, BAD_MEDIA)
        return

    asset = store.get_media_asset(task.asset_id)
    if not asset or asset.get("user_id") != task.user_id:
        store.complete_media_probe(
            task.asset_id, task.attempt_id,
            duration=None, width=None, height=None, ok=False, error=BAD_MEDIA,
        )
        return

    storage_path = str(asset.get("storage_path") or "")
    prefix = f"media/{task.user_id}/{asset.get('job_id')}/"
    if not storage_path.startswith(prefix):
        store.complete_media_probe(
            task.asset_id, task.attempt_id,
            duration=None, width=None, height=None, ok=False, error=BAD_MEDIA,
        )
        return
    object_name = storage_path.removeprefix("media/")
    extension = object_name.rsplit(".", 1)[-1].lower()
    image = extension in IMAGE_EXTENSIONS
    if extension == "cube":
        _probe_lut(store, task, object_name)
        return
    if extension == "json":
        _probe_lottie(store, task, object_name)
        return

    with task_workspace(store, task, "probe") as (heartbeat, root):
        local = root / "media"
        try:
            store.download_object(
                "media", object_name, local, max_bytes=MAX_IMAGE_BYTES if image else MAX_MEDIA_BYTES
            )
            info = probe_file(str(local), local_only=True)
            if info.width <= 0 or info.height <= 0 or (not image and info.duration <= 0):
                raise ValueError("invalid media dimensions")
            run(
                [
                    "ffmpeg", "-v", "error", *USER_INPUT, "-i", str(local),
                    "-frames:v", "1", "-f", "null", "-",
                ],
                timeout=60,
            )
            if heartbeat.lost.is_set():
                return
            store.complete_media_probe(
                task.asset_id, task.attempt_id,
                duration=None if image else info.duration, width=info.width, height=info.height,
                ok=True, error=None,
            )
        except TransientError:
            raise
        except Exception:
            log.info("Media asset %s không đọc được", task.asset_id, exc_info=True)
            won = store.complete_media_probe(
                task.asset_id, task.attempt_id,
                duration=None, width=None, height=None, ok=False, error=BAD_MEDIA,
            )
            if won:
                store.remove_objects("media", [object_name])


def lottie_info(text: str) -> tuple[int, int, float]:
    """(rộng, cao, giây) của một Lottie đọc được — cùng luật `lottieInfo` (clip-assets), ném
    ValueError/TypeError khi không phải Lottie. Worker kiểm trước để export không gặp file hỏng."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise TypeError("not a Lottie object")
    fr, w, h = data.get("fr"), data.get("w"), data.get("h")
    if not isinstance(data.get("v"), str) or not isinstance(data.get("layers"), list):
        raise TypeError("missing Lottie fields")
    if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 for value in (fr, w, h)):
        raise ValueError("bad Lottie size or frame rate")
    # Skottie (native) vẽ file này trên worker export: tài nguyên NGOÀI (`u` + `p` là đường dẫn)
    # có thể trỏ tới file khác trên máy rồi lên video xuất ra. Chỉ nhận ảnh nhúng `data:`.
    assets = data.get("assets") or []
    if not isinstance(assets, list):
        raise TypeError("bad Lottie assets")
    for asset in assets:
        if not isinstance(asset, dict):
            raise TypeError("bad Lottie asset")
        if "p" in asset and not (asset.get("e") == 1 and str(asset.get("p", "")).startswith("data:")):
            raise ValueError("Lottie references an external file")
    ip = data.get("ip") if isinstance(data.get("ip"), (int, float)) else 0
    op = data.get("op") if isinstance(data.get("op"), (int, float)) else 0
    return int(w), int(h), max(0.0, round((op - ip) / fr, 3))


def _probe_lottie(store: Any, task: Task, object_name: str) -> None:
    """Lottie `.json` (G4): lên Storage để export trên server vẽ được bằng Skottie. Chỉ đọc
    JSON — không chạy gì, không ffmpeg; width/height/duration để thư viện hiện như mọi media."""
    with tempfile.TemporaryDirectory(prefix="opencmo-probe-") as tmp:
        local = Path(tmp) / "animation.json"
        try:
            store.download_object("media", object_name, local, max_bytes=MAX_LOTTIE_BYTES)
            width, height, duration = lottie_info(local.read_text(encoding="utf-8", errors="strict"))
        except TransientError:
            raise
        except Exception:
            log.info("Lottie %s không đọc được", task.asset_id, exc_info=True)
            won = store.complete_media_probe(
                task.asset_id, task.attempt_id,
                duration=None, width=None, height=None, ok=False, error=BAD_MEDIA,
            )
            if won:
                store.remove_objects("media", [object_name])
            return
        store.complete_media_probe(
            task.asset_id, task.attempt_id, duration=duration or None, width=width, height=height, ok=True, error=None,
        )


def _probe_lut(store: Any, task: Task, object_name: str) -> None:
    """LUT `.cube` (E3-c): đọc được là xong, không có hình hay thời lượng; width = height =
    kích thước lưới để thư viện hiện "33³"."""
    with tempfile.TemporaryDirectory(prefix="opencmo-probe-") as tmp:
        local = Path(tmp) / "lut.cube"
        try:
            store.download_object("media", object_name, local, max_bytes=MAX_LUT_BYTES)
            size = cube_size(local.read_text(encoding="utf-8", errors="strict"))
        except TransientError:
            raise
        except Exception:
            log.info("LUT %s không đọc được", task.asset_id, exc_info=True)
            won = store.complete_media_probe(
                task.asset_id, task.attempt_id,
                duration=None, width=None, height=None, ok=False, error=BAD_MEDIA,
            )
            if won:
                store.remove_objects("media", [object_name])
            return
        store.complete_media_probe(
            task.asset_id, task.attempt_id, duration=None, width=size, height=size, ok=True, error=None,
        )
