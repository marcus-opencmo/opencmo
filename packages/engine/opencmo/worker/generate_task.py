"""Task `generate`: sinh một media asset bằng provider trong catalog (spec §7.3).

Tiền không được đụng tới ở đây: `create_generation` đã đặt trước, trigger trên
`tasks` hoàn toàn bộ khi task chết bằng bất kỳ đường nào, và
`complete_generation` chốt ≤ phần đặt trước. Việc của worker chỉ là: kiểm lại
spec (lớp thứ ba), gọi provider, tải kết quả THEO STREAM lên bucket `media`,
và chốt.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from opencmo.ai.catalog import (
    CODE_NOT_FOUND,
    MEDIA_NOT_FOUND,
    VIDEO_NOT_FOUND,
    SpecError,
    get_model,
    validate_spec,
    with_row,
)
from opencmo.ai.moderation import check_input, check_input_video, check_output
from opencmo.ai.providers import ProviderError, adapter_for
from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.editing.models import canonical_json
from opencmo.media.ffmpeg import run
from opencmo.worker.task_run import task_workspace

log = logging.getLogger(__name__)

FAILED = "Generation failed. Your credits were refunded."


def spec_hash(model: str, spec: dict[str, Any]) -> str:
    """Cùng chuỗi với route Next (`canonicalJson` + sha256) — luật web số 4."""
    return hashlib.sha256(canonical_json({"model": model, "spec": spec}).encode()).hexdigest()


def _probe(path: Path) -> tuple[float | None, int | None, int | None]:
    """Thời lượng + kích thước của file kết quả. Ảnh không có thời lượng;
    âm thanh không có kích thước — cả hai là None, không phải 0."""
    proc = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ], timeout=60)
    data = json.loads(proc.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    duration = data.get("format", {}).get("duration")
    seconds = float(duration) if duration not in (None, "N/A") else None
    if path.suffix == ".png":
        seconds = None
    return (
        seconds if seconds and seconds > 0 else None,
        int(video["width"]) if video and video.get("width") else None,
        int(video["height"]) if video and video.get("height") else None,
    )


def _file_name(prompt: str, extension: str) -> str:
    """Tên người đọc được trong thư viện: đầu prompt, cắt ở ranh giới từ.

    KHÔNG thêm "…" khi cắt: editor ghi file này vào OPFS đúng tên này, và
    Chromium thử ở máy build sập cả trình duyệt với tên có ký tự ngoài ASCII
    (`a….m4a`, cả `café.m4a`). Prompt tiếng khác vẫn ra tên Unicode — xem
    VIEC-CAN-LAM (thử trên Chrome thật).
    """
    text = re.sub(r"\s+", " ", prompt).strip().replace("/", "-")
    if len(text) > 48:
        cut = text.rfind(" ", 0, 48)
        text = text[: cut if cut > 0 else 48].rstrip(" .,;:")
    return f"{text or 'Generated'}.{extension}"


#: Ảnh đầu vào tối đa trước khi thu nhỏ; ảnh gửi provider có cạnh dài ≤ 1100 px (như Palmier).
INPUT_MAX_BYTES = 30 * 1024 * 1024
INPUT_EDGE = 1100


def _prepare_inputs(store: Any, task: Task, model: Any, spec: dict[str, Any], workdir: Path) -> dict[str, Any]:
    """Ảnh của người dùng (frame đầu/cuối, tham chiếu) → file đã thu nhỏ + đã kiểm duyệt.

    SQL đã kiểm chủ sở hữu theo người gọi; ở đây kiểm lại theo CHỦ TASK (lớp thứ ba):
    một hàng generation bị sửa tay cũng không đưa được ảnh của người khác cho provider.
    Spec trả về mang ĐƯỜNG DẪN FILE thay cho tên object — chỉ adapter đọc, không băm lại.
    """
    def local(ref: str, index: int) -> str:
        if not ref.startswith(f"{task.user_id}/"):
            raise SpecError(MEDIA_NOT_FOUND)
        raw = workdir / f"input-{index}"
        try:
            store.download_object("media", ref, raw, max_bytes=INPUT_MAX_BYTES)
        except Exception as exc:
            raise SpecError(MEDIA_NOT_FOUND) from exc
        out = workdir / f"input-{index}.jpg"
        run([
            # Ảnh của người dùng đi qua stdin bằng image2pipe: ffmpeg chỉ giải mã đúng bytes đó, không
            # mở được file hay URL nào khác (một "ảnh" là playlist HLS từng đọc được file trên worker).
            "ffmpeg", "-v", "error", "-y", "-protocol_whitelist", "pipe", "-f", "image2pipe", "-i", "pipe:0",
            "-frames:v", "1",
            "-vf", f"scale='min({INPUT_EDGE},iw)':'min({INPUT_EDGE},ih)':force_original_aspect_ratio=decrease",
            str(out),
        ], timeout=120, stdin_path=raw)
        check_input(model, out)
        return str(out)

    prepared = dict(spec)
    count = 0
    for key in ("startImage", "endImage"):
        if isinstance(spec.get(key), str):
            prepared[key] = local(spec[key], count)
            count += 1
    if isinstance(spec.get("references"), list):
        refs = []
        for ref in spec["references"]:
            refs.append(local(str(ref), count))
            count += 1
        prepared["references"] = refs
    if isinstance(spec.get("sourceVideo"), str):
        prepared["sourceVideo"] = _source_clip(store, task, model, spec, workdir)
    return prepared


#: Cạnh ngắn của đoạn gửi model sửa video: Kling O1 Edit nhận 720–2160 px.
SOURCE_EDGE = 720


def _source_clip(store: Any, task: Task, model: Any, spec: dict[str, Any], workdir: Path) -> str:
    """Đoạn `[sourceStart, +duration]` của video người dùng (G2, sửa video bằng lời).

    ffmpeg đọc thẳng URL đã ký với `-ss` TRƯỚC `-i` (luật engine 3–4): chỉ kéo đúng đoạn cần,
    không tải nguyên file. Cạnh ngắn đưa về 720 px, H.264 + AAC — dạng mọi provider nhận.
    """
    ref = str(spec["sourceVideo"])
    if not ref.startswith(f"{task.user_id}/"):
        raise SpecError(VIDEO_NOT_FOUND)
    try:
        url = store.sign_object_url("media", ref, expires_in=900)
    except Exception as exc:
        raise SpecError(VIDEO_NOT_FOUND) from exc
    out = workdir / "source.mp4"
    # Nội dung là của người dùng: buộc demuxer mov/mp4 (không để ffmpeg đoán ra playlist HLS
    # rồi đi lấy URL tuỳ ý — SSRF) và chỉ cho đúng giao thức của URL đã ký.
    protocols = "https,http,tls,tcp" if url.startswith(("https://", "http://")) else "file"
    try:
        run([
            "ffmpeg", "-v", "error", "-y", "-protocol_whitelist", protocols, "-f", "mov",
            "-ss", f"{float(spec.get('sourceStart') or 0):.3f}", "-i", url,
            "-t", str(int(spec["duration"])),
            "-vf", f"scale='if(lte(iw,ih),{SOURCE_EDGE},-2)':'if(lte(iw,ih),-2,{SOURCE_EDGE})',fps=30",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out),
        ], timeout=300)
    except Exception as exc:
        raise SpecError(VIDEO_NOT_FOUND) from exc
    if not out.exists() or out.stat().st_size == 0:
        raise SpecError(VIDEO_NOT_FOUND)
    check_input_video(model, out, workdir)
    return str(out)


def process(store: Any, task: Task) -> None:
    generation_id = str((task.payload or {}).get("generation_id") or "")
    generation = store.get_generation(generation_id) if generation_id else None
    if (
        not generation
        or generation.get("task_id") != task.id
        or generation.get("user_id") != task.user_id
        or generation.get("job_id") != task.job_id
    ):
        store.fail_task(task.id, task.attempt_id, FAILED)
        return

    spec = generation.get("spec") or {}
    try:
        model = get_model(str(generation.get("model")))
        # Giá + giới hạn lấy từ DB (G5) — cùng hàng `ai_check_spec` đã kiểm lúc tạo.
        lookup = getattr(store, "get_ai_model", None)
        model = with_row(model, lookup(model.id) if lookup else None)
        validate_spec(model, spec)
        # Hash là khoá khử trùng: một hàng mà hash không khớp spec là hàng có
        # thể trả nhầm kết quả cho một yêu cầu khác. Không sinh cho nó.
        if spec_hash(model.id, spec) != generation.get("spec_hash"):
            raise SpecError("Invalid generation request.")
        adapter = adapter_for(model)
        scene = spec.get("scene") if isinstance(spec.get("scene"), dict) else None
        if scene and scene.get("template") == "code":
            # Cảnh code: spec (và hash) chỉ mang code_ref; code lấy theo CHỦ task,
            # nên không render được code của người khác dù đoán đúng hash.
            code = store.get_scene_code(task.user_id, scene["code_ref"])
            if not code:
                raise SpecError(CODE_NOT_FOUND)
            spec = {**spec, "code": code}
    except SpecError as exc:
        store.fail_task(task.id, task.attempt_id, str(exc))
        return

    object_name = ""
    with task_workspace(store, task, "generate") as (heartbeat, root):
        try:
            try:
                inputs = _prepare_inputs(store, task, model, spec, root)
            except SpecError as exc:
                store.fail_task(task.id, task.attempt_id, str(exc))
                return
            result = adapter.run(model, inputs, root, alive=lambda: not heartbeat.lost.is_set())
            if result is None or heartbeat.lost.is_set():
                return
            # Kiểm thứ model vẽ ra TRƯỚC khi lên bucket: bị chặn thì không có file nào để lộ.
            check_output(model, spec, result.path)
            duration, width, height = _probe(result.path)
            object_name = f"{task.user_id}/{task.job_id}/gen-{generation_id}.{result.extension}"
            store.upload_object("media", object_name, result.path, content_type=result.content_type)
            won = store.complete_generation(
                task.id, task.attempt_id,
                object_name=object_name,
                name=_file_name(str(spec.get("prompt") or ""), result.extension),
                duration=duration, width=width, height=height,
                credits=adapter.cost(model, spec, result),
                words=result.words if model.kind == "voice" else None,
            )
            if not won:
                # Bị huỷ hoặc mất lease trong lúc sinh: không hàng nào tham chiếu
                # file này — xoá ngay thay vì chờ dọn mồ côi.
                store.remove_objects("media", [object_name])
        except TransientError:
            raise
        except ProviderError as exc:
            if exc.retryable:
                raise TransientError(str(exc)) from exc
            store.fail_task(task.id, task.attempt_id, str(exc))
        except Exception:
            log.exception("Generation %s hỏng", generation_id)
            if object_name:
                store.remove_objects("media", [object_name])
            store.fail_task(task.id, task.attempt_id, FAILED)
