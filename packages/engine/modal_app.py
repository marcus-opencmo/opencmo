"""Worker OpenCMO chạy trên Modal.

Deploy:
    modal secret create opencmo \
        ANTHROPIC_API_KEY=... \
        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        OPENCMO_WORKER_TOKEN=...   # cùng giá trị với biến của web app
        OPENCMO_WEB_URL=https://... CRON_SECRET=...   # AI CMO schedule + cleanup; same CRON_SECRET as Vercel
    modal secret create opencmo-voice ELEVENLABS_API_KEY=...   # transcripts (Scribe); same key as Vercel
    modal secret create fal-secret FAL_KEY=...                  # media + output moderation; same key as Vercel
    modal deploy modal_app.py

Bản này CẦN toàn bộ migration D1/D2 đã áp trên database TRƯỚC khi deploy.
Deploy ngược thứ tự khiến worker gọi RPC chưa tồn tại và mọi job/task đều lỗi.

Vì sao Modal chứ không phải VPS: không có máy nào để quản, không cập nhật OS,
không systemd, không bị đánh thức lúc 2h sáng. Trả tiền theo giây, rảnh thì $0.
Image được định nghĩa bằng chính Python nên không phải viết Dockerfile.

Hai đường vào, cố ý:
  1. `submit` — endpoint HTTP web app gọi thẳng khi người dùng bấm, rồi
     `run_job.spawn(...)`. Không độ trễ.
  2. `sweep()` — cron mỗi phút: reconciler trả job hết lease về hàng đợi, rồi
     nhặt job còn queued. Đây là lưới an toàn, không phải đường chính.
     It also dispatches queued AI CMO runs to the web app (`_dispatch_cmo`).
  3. `cmo_schedule()` and `cleanup()` — daily crons that call the web app's cron routes.
     Modal is the only scheduler; `apps/web/vercel.json` has no crons.

Nhờ có (2), (1) được phép hỏng: web app coi lỗi gọi `submit` là chuyện nhỏ, job
vẫn nằm ở 'queued' và chạy chậm nhất một phút sau.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import modal

APP_NAME = "opencmo"

# Trần số việc một lượt `sweep()` nhặt. Có trần để một đợt dồn bất thường (lỗi
# vòng lặp phía web, spam) không đẻ ra hàng trăm container trong một phút.
SWEEP_BATCH = 10

# Model bám mặt được NƯỚNG SẴN vào image thay vì tải lúc chạy: worker khởi động
# nguội cho từng job, tải lại mỗi lần là thêm một điểm hỏng vì mạng.
FACE_MODEL_REMOTE = "/root/models/blaze_face_short_range.tflite"
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)

NODE_VERSION = "22.22.2"
WEB_ROOT = "/root/web"
_ENGINE = Path(__file__).parent
_PACKAGES = _ENGINE.parent
_NODE_IGNORE = ["node_modules", "node_modules/**", "**/*.test.ts"]
# Font + bộ Lottie của clip (R7c): một bản ở packages/clip-media cho cả hai image.
MEDIA_ROOT = f"{WEB_ROOT}/packages/clip-media"
_MEDIA_ENV = {
    "OPENCMO_EDITOR_FONTS": f"{MEDIA_ROOT}/fonts",
    "OPENCMO_EDITOR_LOTTIE": f"{MEDIA_ROOT}/lottie",
}


def _with_node(img: modal.Image) -> modal.Image:
    # Exporter và clip-three chạy THẲNG file .ts bằng type stripping — cần
    # Node ≥ 22.18, apt của bookworm chỉ có 18.
    return img.run_commands(
        f"curl -sSLf https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        " | tar -xJ -C /usr/local --strip-components=1",
    )


def _with_engine(img: modal.Image, *, face: bool) -> modal.Image:
    # Cài engine từ chính repo này. Đổi sang `.pip_install("opencmo-engine")`
    # nếu sau này publish lên PyPI.
    #
    # `ignore` là bắt buộc: thư mục engine trên máy dev chứa .venv và clip test,
    # cỡ vài GB. Không loại ra thì mỗi lần build image phải đẩy hết chỗ đó lên.
    # Neo theo vị trí file, không theo thư mục đang đứng: "." làm
    # `modal deploy packages/engine/modal_app.py` chạy từ gốc repo đẩy nhầm cả
    # repo lên và pip báo "Neither 'setup.py' nor 'pyproject.toml' found".
    img = img.add_local_dir(
        _ENGINE,
        remote_path="/root/engine",
        copy=True,
        ignore=[
            ".venv*", "**/.venv*",
            "clips", "clips/**",
            "**/__pycache__", "**/*.pyc",
            ".pytest_cache", ".pytest_cache/**",
            ".ruff_cache", ".ruff_cache/**",
            "tests", "tests/**",
        ],
    )
    # Catalog model sinh media nằm ở packages/contracts, NGOÀI thư mục engine:
    # thiếu file này thì task `generate` nào cũng hỏng (opencmo/ai/catalog.py).
    # Bảng task kind (opencmo/worker/kinds.py): thiếu thì worker không phân được việc nào.
    for name in ("ai-models.json", "task-kinds.json"):
        img = img.add_local_file(
            _PACKAGES / "contracts" / name, remote_path=f"/root/contracts/{name}", copy=True
        )
    # Cài KÈM extra [face] cho worker CPU. Không có MediaPipe thì engine tự rơi về
    # cắt căn giữa — chạy vẫn ra file, nhưng đo trên video thật cho thấy người nói
    # bị cắt mất nửa người khi họ không đứng giữa khung. Đây không phải tính năng
    # phụ. Image GPU chỉ render 3D, không bám mặt.
    return img.run_commands(f"pip install '/root/engine{'[face]' if face else ''}'")


def _with_media(img: modal.Image) -> modal.Image:
    # Renderer vẽ chữ bằng đúng các file font này; Lottie `builtin:<tên>` đọc ở
    # thư mục lottie (OPENCMO_EDITOR_LOTTIE, không suy từ thư mục font).
    return img.add_local_dir(_PACKAGES / "clip-media", remote_path=MEDIA_ROOT, copy=True)


cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    # `fonts-dejavu-core` là bắt buộc, không phải cho đẹp: cả phụ đề (libass) và
    # watermark (drawtext) đều cần file font thật. debian_slim không có font nào,
    # và thiếu font thì ffmpeg vẫn chạy — chỉ là clip ra không có chữ. Đúng kiểu
    # lỗi im lặng mà CLAUDE.md cảnh báo.
    #
    # `libegl1`/`libgles2` là cho MediaPipe, không phải cho ffmpeg: Tasks API nạp
    # `tasks/c/libmediapipe.so` bằng ctypes lúc chạy, và file đó NEEDED đúng hai
    # thư viện này (`objdump -p` để kiểm lại). Thiếu chúng thì
    # `FaceDetector.create_from_options` ném `OSError: libEGL.so.1` — mà
    # `reframe.py` KHÔNG bắt lỗi đó (chỉ fallback khi thiếu hẳn MediaPipe), nên
    # cả job chết. Máy dev có sẵn nên lỗi này chỉ lộ ra trên Modal.
    .apt_install(
        "ffmpeg", "curl", "fonts-dejavu-core", "fontconfig", "libegl1", "libgles2"
    )
)
cpu_image = (
    _with_engine(cpu_image, face=True)
    # Cho `submit` — web app là TypeScript nên không gọi được `run_job.spawn()`
    # trực tiếp; nó cần một endpoint HTTP.
    .pip_install("fastapi[standard]")
    .run_commands(
        "mkdir -p /root/models",
        f"curl -sSLf -o {FACE_MODEL_REMOTE} {FACE_MODEL_URL}",
    )
    .env({"OPENCMO_FACE_MODEL": FACE_MODEL_REMOTE})
)
# Export trên server (task `render_document`). Chỉ ba package exporter cần cùng
# font/Lottie của clip. Không kéo cả monorepo: Next, Playwright là vài trăm MB
# image không ai dùng tới ở đây.
cpu_image = (
    _with_media(_with_node(cpu_image))
    .add_local_file(_ENGINE / "clip_export_package.json", remote_path=f"{WEB_ROOT}/package.json", copy=True)
    .add_local_dir(_PACKAGES / "clip-doc", remote_path=f"{WEB_ROOT}/packages/clip-doc", copy=True, ignore=_NODE_IGNORE)
    .add_local_dir(
        _PACKAGES / "clip-render", remote_path=f"{WEB_ROOT}/packages/clip-render", copy=True, ignore=_NODE_IGNORE
    )
    .add_local_dir(
        _PACKAGES / "clip-export", remote_path=f"{WEB_ROOT}/packages/clip-export", copy=True, ignore=_NODE_IGNORE
    )
    .run_commands(f"cd {WEB_ROOT} && npm install --omit=dev --no-audit --no-fund")
    .env(
        {
            "OPENCMO_CLIP_EXPORT": f"{WEB_ROOT}/packages/clip-export/src/cli.ts",
            **_MEDIA_ENV,
            # Task `generate` của model studio-3d spawn `render_three` bên dưới.
            "OPENCMO_3D": "modal",
        }
    )
)
# Tên cũ: `modal.App(image=…)` và mọi hàm không khai image riêng dùng image CPU.
image = cpu_image

# 3D Studio (spec 2026-09-30-studio-3d): image RIÊNG cho hàm GPU — Chromium +
# three chỉ nằm ở đây, image worker không phình thêm vài trăm MB.
#
# Chromium vẽ WebGL qua ANGLE/EGL của driver NVIDIA (`chromiumGpuArgs` ở
# clip-three/src/render.ts). KHÔNG dùng ANGLE/Vulkan: trên L4 nó mất WebGL context
# ở khung 2 của mọi video và MP4 ra tối sầm, mất nền + ánh sáng môi trường, không
# báo lỗi (đo 02/10). File ICD Vulkan bên dưới giữ cho `vulkaninfo` chẩn đoán.
# `renderer` trong log của mỗi lượt cho biết chạy trên gì (rơi về SwiftShader thì
# cùng hình, chậm ~20 lần). Đo 02/10 (L4, cảnh code 1080×1920, 4 s): 164 ms/khung;
# trước khi có thư viện X11/GLVND bên dưới thì treo hẳn.
_ICD = '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}'
gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    # libx11/libxext/libglvnd/libegl: driver NVIDIA mà Modal gắn vào
    # (libGLX_nvidia, libEGL_nvidia) cần chúng để nạp. Thiếu thì Vulkan loader báo
    # "Could not get vkCreateInstance" và Chromium TREO lúc tạo WebGL (đo L4
    # 01/10, `packages/clip-three/spike/smoke.mts`); có thì ANGLE chạy NVIDIA L4.
    .apt_install(
        "ffmpeg", "curl", "xz-utils", "libvulkan1", "vulkan-tools",
        "libx11-6", "libxext6", "libglvnd0", "libegl1", "libgl1", "libgles2",
    )
)
gpu_image = (
    _with_node(gpu_image)
    .run_commands(
        "mkdir -p /etc/vulkan/icd.d",
        f"echo '{_ICD}' > /etc/vulkan/icd.d/nvidia_icd.json",
    )
)
gpu_image = (
    # Font tiêu đề của Brand Kit: cùng file woff2 mà editor và exporter 2D dùng.
    _with_media(_with_engine(gpu_image, face=False))
    .add_local_dir(_PACKAGES / "clip-three", remote_path=f"{WEB_ROOT}/packages/clip-three", copy=True, ignore=_NODE_IGNORE)
    .run_commands(
        f"cd {WEB_ROOT}/packages/clip-three && npm install --omit=dev --no-audit --no-fund",
        # Chromium của đúng bản playwright-core đang dùng, kèm thư viện hệ thống.
        f"cd {WEB_ROOT}/packages/clip-three && npx playwright-core install --with-deps chromium",
        "ln -sf \"$(find /root/.cache/ms-playwright -path '*chrome-linux*' -name chrome -type f | head -1)\""
        " /usr/local/bin/chromium-3d",
    )
    .env(
        {
            "OPENCMO_CLIP_THREE": f"{WEB_ROOT}/packages/clip-three/src/cli.ts",
            **_MEDIA_ENV,
            "CHROMIUM_PATH": "/usr/local/bin/chromium-3d",
            "OPENCMO_3D_GPU": "1",
            "NVIDIA_DRIVER_CAPABILITIES": "all",
        }
    )
)

app = modal.App(APP_NAME, image=cpu_image)
secret = modal.Secret.from_name("opencmo")

# Proxy tách riêng một secret vì `modal secret create --force` THAY cả secret
# chứ không thêm key — nhét chung vào `opencmo` thì mỗi lần đổi mật khẩu proxy
# phải gõ lại toàn bộ khoá Supabase/Anthropic.
#
#   modal secret create opencmo-proxy \
#     OPENCMO_PROXY='http://USER:PASS_country-us_session-XXXXXXXX_lifetime-10m@geo.iproyal.com:12321'
#
# Bắt buộc sticky session: link googlevideo ký kèm IP (`ip` nằm trong `sparams`),
# proxy xoay IP mỗi request thì lấy link một IP, tải bằng IP khác → 403.
# Chỉ gắn vào hàm chạy yt-dlp; `submit` và `sweep` không tải gì từ YouTube.
proxy_secret = modal.Secret.from_name("opencmo-proxy")

# Khoá ElevenLabs tách riêng, cùng lý do: thêm vào `opencmo` bằng `--force` là
# phải gõ lại mọi khoá cũ. Thiếu nó thì web (Vercel CÓ khoá) vẫn bán voiceover
# mà worker báo "not set up" ở MỌI lượt — đúng lỗi production 02/10.
#
#   modal secret create opencmo-voice ELEVENLABS_API_KEY=...   # cùng khoá với Vercel
#
# `run_job` and `probe` need it for transcripts (ElevenLabs Scribe); `run_task` for captions of
# library files.
voice_secret = modal.Secret.from_name("opencmo-voice")

# fal key, separate for the same reason. Every generated image, video, voice and sound goes
# through fal, so without it the web sells generation that the worker reports as "not set up".
#
#   modal secret create fal-secret FAL_KEY=...   # same key as Vercel
fal_secret = modal.Secret.from_name("fal-secret")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("opencmo.worker")


def _store():
    from opencmo.backends.supabase import SupabaseStore

    return SupabaseStore(
        os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    )


def _record_call(store, job, call) -> None:
    try:
        store.set_call_id(job.id, job.attempt_id, call.object_id)
    except Exception:
        # Chỉ để tra log Modal; thiếu nó không ảnh hưởng vòng đời job.
        log.warning("Không ghi được call_id cho job %s", job.id, exc_info=True)


@app.function(
    secrets=[secret, proxy_secret, voice_secret],
    timeout=1800,
    cpu=4,
    memory=4096,
    # Cho container chết giữa chừng (OOM, preempt): chạy lại CÙNG attempt. Lỗi
    # bắt được thì `process_job.process` đã chốt, lần chạy lại thấy job không còn running
    # và thoát ngay.
    retries=modal.Retries(max_retries=1, initial_delay=10.0),
)
def run_job(job_id: str, attempt_id: str) -> None:
    """Đường vào chính. Chỉ nhận ID; mọi dữ liệu job đọc lại từ database."""
    from opencmo.worker.process_job import process

    store = _store()
    try:
        job = store.get_job(job_id)
        if job is None or job.status != "running" or job.attempt_id != attempt_id:
            log.info("Job %s: attempt %s không còn hiện hành — bỏ qua", job_id, attempt_id)
            return
        process(store, job)
    finally:
        store.close()


@app.function(
    secrets=[secret, proxy_secret, voice_secret, fal_secret],
    timeout=1800,
    cpu=4,
    memory=4096,
    retries=modal.Retries(max_retries=1, initial_delay=10.0),
    max_containers=10,
)
def run_task(task_id: str, attempt_id: str) -> None:
    """Chạy một task canonical; kind/payload luôn đọc lại từ database."""
    from opencmo.worker.kinds import handlers as task_handlers

    handlers = task_handlers()
    store = _store()
    try:
        task = store.get_task(task_id)
        if task is None or task.status != "running" or task.attempt_id != attempt_id:
            log.info("Task %s: attempt %s không còn hiện hành — bỏ qua", task_id, attempt_id)
            return
        handler = handlers.get(task.kind)
        if handler is None:
            store.fail_task(task.id, task.attempt_id, "Unsupported worker task.")
            return
        handler(store, task)
    finally:
        store.close()


@app.function(
    image=gpu_image,
    gpu="L4",
    timeout=600,
    cpu=2,
    memory=4096,
    max_containers=4,
    # Cảnh `code` chạy code do agent viết (spec code-scenes): không secret, và
    # Chromium tự cắt mạng ra ngoài (`OFFLINE` trong clip-three/src/render.ts).
    # KHÔNG dùng `block_network=True`: nó chặn cả đường Modal tải kết quả > 2 MiB
    # lên kho blob — MP4 không về được, lỗi DNS tới r2.cloudflarestorage.com (01/10).
)
def render_three(payload: dict) -> bytes:
    """3D Studio: một cảnh → bytes MP4. Không đụng database hay Storage —
    task `generate` (trong `run_task`) spawn hàm này, hỏi lại, rồi tự upload.

    Lỗi đi ra là `ProviderError` với câu tiếng Anh (Modal pickle giữ message),
    để worker chốt đúng lời cho người dùng.
    """
    from opencmo.ai.providers.three import render_local

    with tempfile.TemporaryDirectory(prefix="opencmo-3d-") as tmp:
        return render_local(payload, Path(tmp), gpu=True).read_bytes()


@app.function(secrets=[secret], timeout=30)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict) -> dict:
    """Cửa HTTP cho web app.

    Vì sao cần: `run_job.spawn()` là API Python, mà web app là TypeScript. Không
    có endpoint này thì job phải chờ `sweep()` nhặt — tức là trung bình 30 giây
    người dùng nhìn màn hình "đang chờ" mà chẳng có gì chạy.

    Xác thực bằng một token dùng chung trong body, không phải header: chữ ký hàm
    được đánh giá trên MÁY DEV lúc `modal deploy`, nên nhận `fastapi.Header` sẽ
    bắt máy dev phải cài fastapi. Body là `dict` thuần thì không.

    Chỉ dùng một trong `job_id`/`task_id` từ payload. Toàn bộ dữ liệu còn lại
    lấy từ hàng canonical mà RPC claim trả về.
    """
    import hmac

    from fastapi import HTTPException

    from opencmo.backends.retry import TransientError

    expected = os.environ.get("OPENCMO_WORKER_TOKEN", "")
    given = str(payload.get("token") or "")
    if not expected or not hmac.compare_digest(expected, given):
        raise HTTPException(status_code=401, detail="Invalid worker token.")

    job_id = str(payload.get("job_id") or "")
    task_id = str(payload.get("task_id") or "")
    if bool(job_id) == bool(task_id):
        raise HTTPException(status_code=400, detail="Send exactly one job_id or task_id.")

    store = _store()
    try:
        try:
            item = store.claim_job(job_id) if job_id else store.claim_task(task_id)
        except TransientError as exc:
            # Không retry claim. Nếu nó đã commit, lease hết hạn trả job về
            # hàng đợi; nếu chưa, sweep phút sau nhặt.
            log.warning("Submit %s: database lỗi tạm — để sweep xử lý", job_id or task_id)
            raise HTTPException(status_code=503, detail="The database is temporarily unavailable.") from exc

        if item is None:
            log.info("Việc %s đã có worker nhận — bỏ qua", job_id or task_id)
            return {"ok": True, "already_claimed": True}

        if job_id:
            call = run_job.spawn(item.id, item.attempt_id)
            _record_call(store, item, call)
        else:
            call = run_task.spawn(item.id, item.attempt_id)
    finally:
        store.close()

    log.info("Nhận %s %s attempt %s từ web", "job" if job_id else "task", item.id, item.attempt)
    return {"ok": True, "call_id": call.object_id}


@app.function(secrets=[secret], schedule=modal.Period(minutes=1), timeout=60)
def sweep() -> None:
    """Lưới an toàn: phục hồi lease rồi nhặt job/task còn kẹt ở queued.

    Nhặt HẾT hàng đợi (tối đa SWEEP_BATCH) rồi giao cho `run_job` — không tự
    chạy pipeline ở đây: hàm này timeout 60 giây, còn một job mất vài phút.

    Lỗi tạm của database chỉ ghi warning rồi thôi: cron chạy lại sau một phút,
    và 504 lúc hàng đợi rỗng (13/09 11:00) không phải sự cố cần báo động.
    """
    from opencmo.backends.retry import TransientError
    from opencmo.worker.kinds import task_kinds

    store = _store()
    try:
        try:
            outcome = store.reclaim_expired()
            if outcome.get("requeued") or outcome.get("failed"):
                log.warning("Reconciler: %s", outcome)
        except TransientError:
            log.warning("Reconciler lỗi tạm — phút sau chạy lại", exc_info=True)

        try:
            outcome = store.reclaim_expired_tasks()
            if outcome.get("requeued") or outcome.get("failed"):
                log.warning("Task reconciler: %s", outcome)
        except TransientError:
            log.warning("Task reconciler lỗi tạm — phút sau chạy lại", exc_info=True)

        for _ in range(SWEEP_BATCH):
            try:
                job = store.claim_next_job()
            except TransientError:
                log.warning("Claim lỗi tạm — phút sau chạy lại", exc_info=True)
                break
            if job is not None:
                log.info("Sweep nhặt job %s attempt %s", job.id, job.attempt)
                call = run_job.spawn(job.id, job.attempt_id)
                _record_call(store, job, call)
                continue

            try:
                task = store.claim_next_task(list(task_kinds()))
            except TransientError:
                log.warning("Claim task lỗi tạm — phút sau chạy lại", exc_info=True)
                break
            if task is None:
                break
            log.info("Sweep nhặt task %s kind %s", task.id, task.kind)
            run_task.spawn(task.id, task.attempt_id)
    finally:
        store.close()

    _dispatch_cmo()


def _dispatch_cmo() -> None:
    """Send the AI CMO runs waiting in `cmo_runs` to the web app, one call per run.

    Errors only warn: the runs stay queued and the next sweep, a minute later, tries again.
    """
    from opencmo.worker import cmo_dispatch

    web = cmo_dispatch.web_config(dict(os.environ))
    if web is None:
        log.info("OPENCMO_WEB_URL or CRON_SECRET missing: AI CMO runs are not dispatched")
        return
    try:
        waiting = cmo_dispatch.count_dispatchable(
            os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        )
        if waiting:
            sent = cmo_dispatch.dispatch(*web, waiting)
            log.info("AI CMO: %s waiting, %s dispatched", waiting, sent)
    except Exception:
        log.warning("AI CMO dispatch failed; next sweep tries again", exc_info=True)


@app.function(secrets=[secret], schedule=modal.Cron("5 0 * * *"), timeout=330)
def cmo_schedule() -> None:
    """Enqueue the AI CMO loops due today (00:05 UTC, right after the calendar's day starts).

    Only enqueues; `sweep()` dispatches the runs. Once a day on purpose: the loops are daily, and
    enqueuing again after a run finished would run it twice.
    """
    from opencmo.worker import cmo_dispatch

    web = cmo_dispatch.web_config(dict(os.environ))
    if web is None:
        log.error("OPENCMO_WEB_URL or CRON_SECRET missing: the AI CMO schedule did not run")
        return
    log.info("AI CMO schedule: %s", cmo_dispatch.call_cron(*web, "/api/cron/cmo"))


@app.function(secrets=[secret], schedule=modal.Cron("0 3 * * *"), timeout=90)
def cleanup() -> None:
    """Daily cleanup of expired files and free accounts (the web route does the work)."""
    from opencmo.worker import cmo_dispatch

    web = cmo_dispatch.web_config(dict(os.environ))
    if web is None:
        log.error("OPENCMO_WEB_URL or CRON_SECRET missing: cleanup did not run")
        return
    log.info("Cleanup: %s", cmo_dispatch.call_cron(*web, "/api/cron/cleanup", timeout=75.0))


@app.local_entrypoint()
def main(url: str, clips: int = 3) -> None:
    """Chạy thử một video mà không cần database.

        modal run modal_app.py --url "https://youtube.com/watch?v=..."

    Dùng để kiểm chứng ngày 11/9: engine chạy được trên hạ tầng Modal chưa, và
    YouTube có chặn IP của Modal không.
    """
    frame = probe.remote(url, clips)
    if frame:
        # Thư mục tạm trong container bị xoá khi hàm trả về, nên đây là cách duy
        # nhất để NHÌN clip render trên cloud — xem mục "Kiểm chứng" ở CLAUDE.md.
        Path("modal-kiem.png").write_bytes(frame)
        print("frame clip đầu tiên (t=8s): modal-kiem.png — mở ra xem")


@app.function(secrets=[secret, proxy_secret, voice_secret], timeout=1800, cpu=4, memory=4096)
def probe(url: str, clips: int) -> bytes | None:
    """Chạy pipeline, in thời gian từng bước, trả về một frame của clip đầu."""
    import subprocess

    from opencmo.config import Config
    from opencmo.pipeline import run_pipeline

    print(f"proxy      : {'CÓ' if os.environ.get('OPENCMO_PROXY') else 'KHÔNG'}")
    with tempfile.TemporaryDirectory() as out:
        result = run_pipeline(url, Config(out_dir=Path(out)), clip_count=clips)
        t = result.timings
        print(f"nguồn      : {result.source.title} ({result.source.duration:.0f}s)")
        print(f"transcript : {t.transcript:.1f}s (nguồn: {result.transcript_source})")
        print(f"chọn đoạn  : {t.select:.1f}s")
        print(f"tải đoạn   : {t.download:.1f}s")
        print(f"render     : {t.render:.1f}s")
        print(f"TỔNG       : {t.total:.1f}s — {len(result.clips)} clip")

        if not result.clips:
            return None
        frame = Path(out) / "kiem.png"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", "8", "-i", result.clips[0].path,
             "-frames:v", "1", str(frame)],
            check=True,
        )
        return frame.read_bytes()
