"""Worker OpenCMO chạy trên Modal.

Deploy:
    modal secret create opencmo \
        ANTHROPIC_API_KEY=... \
        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        OPENCMO_WORKER_TOKEN=...   # cùng giá trị với biến của web app
        OPENCMO_WEB_URL=https://... CRON_SECRET=...   # AI CMO schedule; same CRON_SECRET as Vercel
        CRON_CLEANUP_SECRET=...   # cleanup only; same value as Vercel's CRON_CLEANUP_SECRET
        OPENCMO_WAKE_TOKEN=...    # `wake`; same value as the MCP server's OPENCMO_WAKE_TOKEN
    modal secret create opencmo-voice ELEVENLABS_API_KEY=...   # transcripts (Scribe); same key as Vercel
    modal secret create fal-secret FAL_KEY=...                  # media + output moderation; same key as Vercel
    modal secret create opencmo-motion MOTION_PREVIEW_TOKEN=... # explainer previews; same as Vercel, not the worker token
    modal deploy modal_app.py

Optional: add GEMINI_API_KEY to the `opencmo` secret. Gemini then checks AI output when Claude
cannot answer (no credit, an outage); without it such output is refunded, never delivered.

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
  4. `wake` — the MCP server (`mcp_app.py`, its own app) asks for an early `sweep()` with a
     token that can do nothing else.

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

NODE_VERSION = "22.22.2"
WEB_ROOT = "/root/web"
_ENGINE = Path(__file__).parent
_PACKAGES = _ENGINE.parent
_NODE_IGNORE = ["node_modules", "node_modules/**", "**/*.test.ts"]

# The face model is baked into the upload worker's image: a cold container per job would otherwise download it each
# time, one more network failure point (opencmo/steps/reframe.py).
FACE_MODEL_REMOTE = "/root/models/blaze_face_short_range.tflite"
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
# The clip fonts (R7c): one copy in packages/clip-media for every image.
MEDIA_ROOT = f"{WEB_ROOT}/packages/clip-media"
_MEDIA_ENV = {
    "OPENCMO_EDITOR_FONTS": f"{MEDIA_ROOT}/fonts",
}


def _with_node(img: modal.Image) -> modal.Image:
    # The exporter and clip-motion run .ts files directly with type stripping: Node ≥ 22.18,
    # bookworm's apt only has 18.
    return img.run_commands(
        f"curl -sSLf https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        " | tar -xJ -C /usr/local --strip-components=1",
    )


def _with_engine(img: modal.Image, *, face: bool = False) -> modal.Image:
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
    # The edit-length cap the web Upload panel shares (opencmo/worker/process_job.py).
    # Platform profiles Writer and the cards share (opencmo/platforms.py).
    for name in ("ai-models.json", "task-kinds.json", "upload-limits.json", "platforms.json"):
        img = img.add_local_file(
            _PACKAGES / "contracts" / name, remote_path=f"/root/contracts/{name}", copy=True
        )
    # The upload worker takes the [face] extra (MediaPipe) for face tracking; the other images never track faces.
    return img.run_commands(f"pip install '/root/engine{'[face]' if face else ''}'")


def _with_media(img: modal.Image) -> modal.Image:
    # The renderers draw text with exactly these font files.
    return img.add_local_dir(_PACKAGES / "clip-media", remote_path=MEDIA_ROOT, copy=True)


cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    # `fonts-dejavu-core` là bắt buộc, không phải cho đẹp: cả phụ đề (libass) và
    # watermark (drawtext) đều cần file font thật. debian_slim không có font nào,
    # và thiếu font thì ffmpeg vẫn chạy — chỉ là clip ra không có chữ. Đúng kiểu
    # lỗi im lặng mà CLAUDE.md cảnh báo.
    #
    # Noto: captions translated to Japanese/Korean/Chinese/Thai/Hindi and emoji would export as
    # boxes; the renderer names these families after the brand font (clip-render `applyFont`).
    #
    # `libegl1`/`libgles2` are for MediaPipe, not ffmpeg: its Tasks API loads `libmediapipe.so` with ctypes, which
    # NEEDS both. Without them `FaceDetector.create_from_options` raised `OSError: libEGL.so.1` on Modal only (dev
    # machines have them); reframe.py now falls back to the centre on that error, but the tracking would be lost.
    .apt_install(
        "ffmpeg", "curl", "fonts-dejavu-core", "fontconfig", "libegl1", "libgles2",
        "fonts-noto-cjk", "fonts-noto-core", "fonts-noto-color-emoji",
    )
)
cpu_image = (
    _with_engine(cpu_image, face=True)
    # For `submit`: the web app is TypeScript and cannot call `run_job.spawn()` directly; it needs an HTTP
    # endpoint.
    .pip_install("fastapi[standard]")
    .run_commands("mkdir -p /root/models", f"curl -sSLf -o {FACE_MODEL_REMOTE} {FACE_MODEL_URL}")
    .env({"OPENCMO_FACE_MODEL": FACE_MODEL_REMOTE})
)
# Server export (task `render_document`). Only the three exporter packages and the clip fonts. Not the whole
# monorepo: Next and Playwright are hundreds of MB of image nothing here uses.
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
            # Explainers: the worker makes the voice, then spawns `render_motion` below.
            "OPENCMO_MOTION": "modal",
            # Proof B-roll: task `capture_page` calls `page_capture` below; no Chromium here.
            "OPENCMO_CAPTURE": "modal",
        }
    )
)
# Tên cũ: `modal.App(image=…)` và mọi hàm không khai image riêng dùng image CPU.
image = cpu_image

# Explainers (docs/explainer-build.md): a CPU image of its own for `clip-motion` (Remotion +
# headless Chromium). Rendering is CPU work, so no GPU; the worker image does not carry Chromium.
# Libraries are the ones Remotion lists for Debian; fonts come from clip-media like the exporter.
motion_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "ffmpeg", "curl", "xz-utils",
        "libnss3", "libdbus-1-3", "libatk1.0-0", "libatk-bridge2.0-0", "libgbm1", "libasound2",
        "libxrandr2", "libxkbcommon0", "libxfixes3", "libxcomposite1", "libxdamage1",
        "libpango-1.0-0", "libcairo2", "libcups2",
    )
)
motion_image = (
    _with_media(_with_engine(_with_node(motion_image)))
    # For the `motion_preview` endpoint.
    .pip_install("fastapi[standard]")
    .add_local_dir(_PACKAGES / "clip-motion", remote_path=f"{WEB_ROOT}/packages/clip-motion", copy=True, ignore=_NODE_IGNORE)
    # v2 kit: every Lucide icon (`<Icon>`) is copied into the Remotion bundle, never fetched. The CLI
    # only sees OPENCMO_MOTION_*.
    .add_local_dir(_PACKAGES / "clip-icons" / "data", remote_path=f"{WEB_ROOT}/packages/clip-icons/data", copy=True)
    .env({
        **_MEDIA_ENV,
        "OPENCMO_MOTION_CACHE": "/root/motion-cache",
        "OPENCMO_MOTION_ICONS": f"{WEB_ROOT}/packages/clip-icons/data/icons.json",
    })
    .run_commands(
        f"cd {WEB_ROOT}/packages/clip-motion && npm install --omit=dev --no-audit --no-fund",
        # Remotion's own headless shell, downloaded once at build time, then pinned by path so the
        # CLI wraps it with its offline flags (an unset path would download it again per container).
        f"cd {WEB_ROOT}/packages/clip-motion && node -e \"import('@remotion/renderer').then((r) => r.ensureBrowser())\"",
        "ln -sf \"$(find / -xdev -type f -name chrome-headless-shell -path '*remotion*' 2>/dev/null | head -1)\""
        " /usr/local/bin/chrome-motion && test -x /usr/local/bin/chrome-motion",
    )
    .env({"OPENCMO_CLIP_MOTION": f"{WEB_ROOT}/packages/clip-motion/src/cli.ts", "OPENCMO_MOTION_CHROME": "/usr/local/bin/chrome-motion"})
    # Bundle the composition into the image (cached by source hash under OPENCMO_MOTION_CACHE)
    # and prove the image renders the v2 kit (icons, both themes): a cold container then
    # starts at the render, not at webpack. Remotion rejects a concurrency above the core count, and
    # the image builder may have one core: same rule as `cli_env`, min(cores, 4).
    .run_commands(
        f"cd {WEB_ROOT}/packages/clip-motion && OPENCMO_MOTION_SCALE=0.25"
        ' OPENCMO_MOTION_CONCURRENCY="$(n=$(nproc); [ "$n" -gt 4 ] && n=4; echo "$n")"'
        " node src/cli.ts render fixtures/vaccine.job.json /tmp/warm.mp4 && rm /tmp/warm.mp4",
    )
)

# Page captures (docs/style-skills-build.md, C3): Chromium opens pages the user names and runs their
# JavaScript, so it gets an image and a function of its own with no secrets. Only the engine's
# `opencmo.capture` and Playwright's Chromium are in it; no Node, no ffmpeg, no fonts beyond
# what Playwright's `--with-deps` installs plus Noto for non-Latin pages.
CAPTURE_PLAYWRIGHT = "1.56.0"
capture_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("fonts-noto-core", "fonts-noto-cjk", "fonts-noto-color-emoji")
    .pip_install(f"playwright=={CAPTURE_PLAYWRIGHT}")
    .run_commands("playwright install --with-deps chromium")
)
capture_image = _with_engine(capture_image)

app = modal.App(APP_NAME, image=cpu_image)
secret = modal.Secret.from_name("opencmo")

# Khoá ElevenLabs tách riêng, cùng lý do: thêm vào `opencmo` bằng `--force` là
# phải gõ lại mọi khoá cũ. Thiếu nó thì web (Vercel CÓ khoá) vẫn bán voiceover
# mà worker báo "not set up" ở MỌI lượt — đúng lỗi production 02/10.
#
#   modal secret create opencmo-voice ELEVENLABS_API_KEY=...   # cùng khoá với Vercel
#
# `run_job` needs it for an upload's transcript (ElevenLabs Scribe); `run_task` for captions of
# library files.
voice_secret = modal.Secret.from_name("opencmo-voice")

# fal key, separate for the same reason. Every generated image, video, voice and sound goes
# through fal, so without it the web sells generation that the worker reports as "not set up".
#
#   modal secret create fal-secret FAL_KEY=...   # same key as Vercel
fal_secret = modal.Secret.from_name("fal-secret")

# Explainer previews run code the Assistant wrote: their container gets a token that can only ask
# for previews, never the worker token (it can submit tasks) or the service-role key.
#
#   modal secret create opencmo-motion MOTION_PREVIEW_TOKEN=...   # same value as Vercel's MOTION_PREVIEW_TOKEN
motion_secret = modal.Secret.from_name("opencmo-motion")

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
    secrets=[secret, voice_secret],
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
    secrets=[secret, voice_secret, fal_secret],
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
    image=motion_image,
    timeout=900,
    cpu=4,
    memory=4096,
    max_containers=4,
    # Runs code the Assistant wrote: no secrets, and Chromium is cut off from the network by the
    # CLI's offline flags. Not `block_network=True`: Modal then cannot hand back results > 2 MiB.
)
def render_motion(payload: dict) -> bytes:
    """Explainer: `{job, audio}` → MP4 bytes. No database or Storage: the worker's `generate`
    task spawns this, polls it, and uploads the result itself.

    Errors leave as `ProviderError` with an English message (Modal pickles it), so the worker
    reports the right sentence to the user.
    """
    from opencmo.ai.providers.motion import render_bytes

    with tempfile.TemporaryDirectory(prefix="opencmo-motion-") as tmp:
        return render_bytes(payload, Path(tmp))


@app.function(
    image=capture_image,
    timeout=90,
    cpu=2,
    memory=2048,
    max_containers=8,
    # No secrets: the page's JavaScript runs here. Network stays on (the page has to load), but
    # every connection goes through `opencmo.capture.guard`, which refuses private, loopback,
    # link-local and metadata addresses. Not `block_network=True`: the page could not load.
)
def page_capture(spec: dict) -> dict:
    """`{url, width, max_height}` → `{png: bytes, boxes: dict}`. The worker's `capture_page`
    task calls this, then moderates and stores the result itself.

    Refusals leave as `CaptureError` with one of the contract's English sentences (Modal pickles
    the message), so the worker writes the right one for the user.
    """
    from opencmo.capture.page import capture

    return capture(spec)


@app.cls(
    image=motion_image,
    secrets=[motion_secret],
    timeout=70,
    # Opening Chromium and loading the bundle happen once per container, before the first preview.
    startup_timeout=120,
    cpu=4,
    memory=4096,
    max_containers=8,
)
class MotionPreview:
    """Explainer previews for the web app's `previewMotion`: `{token, job}` → PreviewResult plus
    `images` (base64 JPEGs).

    The token (`MOTION_PREVIEW_TOKEN`) is in the body like `submit`'s. The scene code runs here and
    never on Vercel, so this container holds only that preview token, never the worker token or
    the service key. One `clip-motion serve` process per container keeps Chromium open, so only a
    cold container pays for starting it.
    """

    @modal.enter()
    def open_browser(self) -> None:
        from opencmo.ai.providers.motion import PreviewSession

        self.session = PreviewSession()
        self.session.start()

    @modal.exit()
    def close_browser(self) -> None:
        self.session.close()

    # Same URL as the v1 function `motion_preview`, so MOTION_PREVIEW_URL does not change.
    @modal.fastapi_endpoint(method="POST", label=f"{APP_NAME}-motion-preview")
    def motion_preview(self, payload: dict) -> dict:
        import hmac

        from fastapi import HTTPException

        expected = os.environ.get("MOTION_PREVIEW_TOKEN", "")
        given = str(payload.get("token") or "")
        if not expected or not hmac.compare_digest(expected, given):
            raise HTTPException(status_code=401, detail="Invalid preview token.")
        job = payload.get("job")
        if not isinstance(job, dict):
            raise HTTPException(status_code=400, detail="Send the explainer job.")
        with tempfile.TemporaryDirectory(prefix="opencmo-motion-preview-") as tmp:
            try:
                return self.session.preview(job, Path(tmp))
            except RuntimeError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.function(secrets=[secret], timeout=140, cpu=2, memory=2048, max_containers=10)
@modal.fastapi_endpoint(method="POST", label=f"{APP_NAME}-look")
def look(payload: dict) -> dict:
    """Look and listen for Claude over MCP (editor-MCP plan, item 1): `{token, user_id, clip_id, op, input,
    document, manifest}` → `{images: [base64 JPEG], data}` or `{error}`.

    The MCP server calls this with `OPENCMO_LOOK_TOKEN`, not the worker token, which that
    internet-facing container must not hold. The clip's ownership is checked again here with the
    service role before any source is downloaded (`opencmo.worker.look`). A request draws at most
    12 frames with the export's renderer; nothing is stored. `timeout` stays under Modal's 150 s
    cut for web endpoints.

    UNTESTED on Modal (2026-10-20): needs `modal deploy modal_app.py` and `OPENCMO_LOOK_TOKEN` in
    the `opencmo` secret (same value as in `opencmo-mcp`). `opencmo.worker.look` runs in
    `tests/test_worker_look.py`, and once end to end against a local clip-export.
    """
    import hmac

    from fastapi import HTTPException

    from opencmo.worker.look import look as run_look

    expected = os.environ.get("OPENCMO_LOOK_TOKEN", "")
    given = str(payload.pop("token", "") or "")
    if not expected or not hmac.compare_digest(expected, given):
        raise HTTPException(status_code=401, detail="Invalid look token.")
    store = _store()
    try:
        with tempfile.TemporaryDirectory(prefix="opencmo-look-") as tmp:
            return run_look(store, payload, Path(tmp))
    finally:
        store.close()


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


@app.function(secrets=[secret], timeout=30)
@modal.fastapi_endpoint(method="POST")
def wake(payload: dict) -> dict:
    """Wake the worker without the worker token: runs one `sweep()` early.

    For callers that create work but must not hold `OPENCMO_WORKER_TOKEN` (the MCP server, which
    faces the internet). It takes no job id, so the token can only make the sweep come sooner:
    the sweep claims through the same leases, and a spare run finds an empty queue.
    The token travels in the body for the same reason as in `submit`.
    """
    import hmac

    from fastapi import HTTPException

    expected = os.environ.get("OPENCMO_WAKE_TOKEN", "")
    given = str(payload.get("token") or "")
    if not expected or not hmac.compare_digest(expected, given):
        raise HTTPException(status_code=401, detail="Invalid wake token.")
    sweep.spawn()
    return {"ok": True}


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

        try:
            reaped = store.reap_agent_turns()
            if reaped:
                log.warning("Assistant turns closed by the sweep: %s", reaped)
        except TransientError:
            log.warning("Turn sweep: transient error, retrying next minute", exc_info=True)

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
        db = (os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
        # Schedule's clock (P4 A2): due slots become publish_post runs first, so this same sweep dispatches them.
        try:
            fired = cmo_dispatch.claim_due_slots(*db)
            if any(fired.values()):
                log.info("Schedule: %s", fired)
        except Exception:
            log.warning("Schedule claim failed; next sweep tries again", exc_info=True)
        # One route runs both queues; Studio's orders (P2 A2) are counted apart and capped by `dispatch`.
        waiting = cmo_dispatch.count_dispatchable(*db) + cmo_dispatch.count_studio_work(*db)
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


@app.function(secrets=[secret], schedule=modal.Cron("2 * * * *"), timeout=150)
def cmo_digest() -> None:
    """Hourly: release cards held past a day's budget, send each founder's digest at their local hour, email the
    cards about to expire and push new cards (P6). Every send is claimed in SQL, so a second call sends nothing.
    """
    from opencmo.worker import cmo_dispatch

    web = cmo_dispatch.web_config(dict(os.environ))
    if web is None:
        log.error("OPENCMO_WEB_URL or CRON_SECRET missing: the digest did not run")
        return
    log.info("Digest: %s", cmo_dispatch.call_cron(*web, "/api/cron/cmo-digest", timeout=140.0))


@app.function(secrets=[secret], schedule=modal.Cron("0 3 * * *"), timeout=90)
def cleanup() -> None:
    """Daily cleanup of expired files and free accounts (the web route does the work).

    The route deletes users, so it takes its own secret, `CRON_CLEANUP_SECRET`: a leak of the
    `CRON_SECRET` that the CMO routes share cannot delete accounts.
    """
    from opencmo.worker import cmo_dispatch

    url = os.environ.get("OPENCMO_WEB_URL", "").strip().rstrip("/")
    token = os.environ.get("CRON_CLEANUP_SECRET", "").strip()
    if not url or not token:
        log.error("OPENCMO_WEB_URL or CRON_CLEANUP_SECRET missing: cleanup did not run")
        return
    log.info("Cleanup: %s", cmo_dispatch.call_cron(url, token, "/api/cron/cleanup", timeout=75.0))
