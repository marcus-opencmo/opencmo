"""SPIKE (01/10): chạy `spike/run.mts` trên Modal (CPU 8 lõi, SwiftShader) thay vì laptop.

App tạm (`modal run`), tên riêng — không đụng app `opencmo` đã deploy. Image
dựng y như `gpu_image` của `packages/engine/modal_app.py` (Node 22, ffmpeg,
Vulkan ICD của NVIDIA, Chromium của playwright-core), chỉ bớt phần engine Python.

    cd packages/clip-three
    GEMINI_API_KEY=… ../engine/.venv312/bin/modal run spike/modal_spike.py \
        --transcript <ted-transcript.json> --out <thư mục kết quả>

Khoá Gemini đi bằng secret tạm tạo từ biến môi trường của máy chạy lệnh, không
ghi vào secret `opencmo`.
"""

import os
import subprocess
from pathlib import Path

import modal

HERE = Path(__file__).parent
PACKAGE = HERE.parent
NODE_VERSION = "22.22.2"
ROOT = "/root/clip-three"
ICD = '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}'

image = (
    modal.Image.debian_slim(python_version="3.12")
    # libGLX_nvidia/libEGL_nvidia (driver do Modal gắn vào) cần X11 + GLVND để nạp:
    # thiếu thì Vulkan loader "Could not get vkCreateInstance" và Chromium treo.
    .apt_install("ffmpeg", "curl", "xz-utils", "libvulkan1", "vulkan-tools", "libx11-6", "libxext6", "libglvnd0", "libegl1", "libgl1", "libgles2")
    .run_commands(
        f"curl -sSLf https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        " | tar -xJ -C /usr/local --strip-components=1",
        "mkdir -p /etc/vulkan/icd.d",
        f"echo '{ICD}' > /etc/vulkan/icd.d/nvidia_icd.json",
    )
    .add_local_file(PACKAGE / "package.json", remote_path=f"{ROOT}/package.json", copy=True)
    .run_commands(
        f"cd {ROOT} && npm install --omit=dev --no-audit --no-fund",
        f"cd {ROOT} && npx playwright-core install --with-deps chromium",
        "ln -sf \"$(find /root/.cache/ms-playwright -path '*chrome-linux*' -name chrome -type f | head -1)\" /usr/local/bin/chromium-3d",
    )
    # CPU (SwiftShader): cờ Vulkan của production TREO trên L4 (smoke 01/10) — lỗi
    # riêng, ghi ở VIEC-CAN-LAM. Spike chỉ cần hình để đánh giá.
    .env({"CHROMIUM_PATH": "/usr/local/bin/chromium-3d", "OPENCMO_3D_GPU": "0", "SPIKE_SIZE": "540", "SPIKE_BEATS": "countdown,all-nighters"})
    # Mã nguồn vào SAU npm install: sửa spike không bắt cài lại node_modules.
    .add_local_dir(PACKAGE / "src", remote_path=f"{ROOT}/src", ignore=["**/*.test.ts"])
    .add_local_dir(PACKAGE / "spike", remote_path=f"{ROOT}/spike", ignore=["*.py", "__pycache__"])
)

app = modal.App("opencmo-spike3d", image=image)


@app.function(
    cpu=8,
    memory=4096,
    timeout=1800,
    secrets=[modal.Secret.from_dict({"GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", "")})],
)
def run(transcript: bytes) -> dict[str, bytes]:
    work = Path("/tmp/spike")
    work.mkdir(parents=True, exist_ok=True)
    (work / "transcript.json").write_bytes(transcript)
    out = work / "out"
    # Log chảy thẳng ra (không gom tới cuối): lần đầu treo 30 phút mà không một dòng nào.
    if not transcript:
        subprocess.run(["node", "spike/smoke.mts"], cwd=ROOT, timeout=300, check=False)
        return {}
    try:
        subprocess.run(["node", "spike/run.mts", str(work / "transcript.json"), str(out)], cwd=ROOT, timeout=1500, check=False)
    except subprocess.TimeoutExpired:
        print("[spike] run.mts quá 25 phút — trả phần đã có")
    return {path.name: path.read_bytes() for path in out.glob("*")} if out.exists() else {}


@app.local_entrypoint()
def main(transcript: str = "", out: str = "/tmp/spike3d-gpu") -> None:
    """Không có --transcript: chỉ chạy smoke (Chromium có vẽ bằng GPU không)."""
    target = Path(out)
    target.mkdir(parents=True, exist_ok=True)
    for name, data in run.remote(Path(transcript).read_bytes() if transcript else b"").items():
        (target / name).write_bytes(data)
    print(f"→ {target}")


@app.function(gpu="L4", cpu=8, memory=8192, timeout=600)
def diag() -> None:
    """Bước 0: container GPU có gì cho Vulkan/EGL (driver lib, ICD, vendor JSON)."""
    for cmd in [
        "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader",
        "ls /usr/lib/x86_64-linux-gnu | grep -iE 'nvidia|libEGL|libGLX|libvulkan|libGLdispatch' | head -40",
        "find / \\( -name 'libGLX_nvidia*' -o -name 'libEGL_nvidia*' -o -name 'libnvidia-glcore*' -o -name 'nvidia_icd*.json' -o -name '10_nvidia*.json' \\) -not -path '/proc/*' 2>/dev/null | head -20",
        "cat /etc/vulkan/icd.d/nvidia_icd.json; ls /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d 2>&1",
        "env | grep -iE 'nvidia|vk_|ld_library'",
        "ldd /usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0 | grep -i 'not found'; ldd /usr/lib/x86_64-linux-gnu/libEGL_nvidia.so.0 | grep -i 'not found'; echo ldd-done",
        "timeout 60 vulkaninfo --summary 2>&1 | grep -iE 'deviceName|driverName|ERROR|apiVersion' | head -12",
    ]:
        print(f"\n$ {cmd}", flush=True)
        subprocess.run(cmd, shell=True, check=False)
    print("\n$ smoke", flush=True)
    subprocess.run(["node", "spike/smoke.mts"], cwd=ROOT, timeout=240, check=False)
    # Cảnh thật qua đúng đường production (cli.ts → render.ts), 1080×1920, 6 s, GPU.
    import json

    spec = {"scene": {"template": "number", "value": 90, "label": "pages in 72 hours"}, "aspectRatio": "9:16", "duration": 6}
    Path("/tmp/spec.json").write_text(json.dumps(spec))
    # Chỉ vẽ (không readPixels/ffmpeg): GPU nhanh tới đâu khi không bị nén chặn.
    for extra in ():
        subprocess.run(["node", "spike/bench.mts"], cwd=ROOT, env={**os.environ, "OPENCMO_3D_GPU": "1", **extra}, timeout=200, check=False)
    for gpu in ("1",):
        print(f"\n$ cli.ts GPU={gpu}", flush=True)
        subprocess.run(["node", "src/cli.ts", "/tmp/spec.json", f"/tmp/out-{gpu}.mp4"], cwd=ROOT, env={**os.environ, "OPENCMO_3D_GPU": gpu}, timeout=600, check=False)


@app.function(gpu="L4", cpu=2, memory=4096, timeout=600, block_network=True)
def bench_prod() -> None:
    """Bước 0: cảnh thật với ĐÚNG cấu hình `render_three` production (cpu=2)."""
    import json

    spec = {"scene": {"template": "number", "value": 90, "label": "pages in 72 hours"}, "aspectRatio": "9:16", "duration": 6}
    Path("/tmp/spec.json").write_text(json.dumps(spec))
    for preset in ("medium",):
        print(f"\n$ cpu=2 preset={preset}", flush=True)
        subprocess.run(["node", "src/cli.ts", "/tmp/spec.json", "/tmp/out.mp4"], cwd=ROOT, env={**os.environ, "OPENCMO_3D_GPU": "1", "OPENCMO_3D_PRESET": preset}, timeout=280, check=False)
    # Cảnh code dưới block_network: code thử gọi ra ngoài chỉ thấy fetch = undefined.
    code = "const b = kit.bars([12, 31], { labels: ['Before', 'After'] });\nreturn (t) => { b.grow(kit.phase(t, 0.2, 1.5)); kit.frame({ push: t / 3 }); };"
    Path("/tmp/code.json").write_text(json.dumps({"scene": {"template": "code", "code_ref": "a" * 64}, "aspectRatio": "9:16", "duration": 6, "code": code}))
    print("\n$ code scene, block_network", flush=True)
    subprocess.run(["node", "src/cli.ts", "/tmp/code.json", "/tmp/code.mp4"], cwd=ROOT, env={**os.environ, "OPENCMO_3D_GPU": "1"}, timeout=280, check=False)


@app.function(gpu="L4", cpu=2, memory=4096, timeout=600)
def gpu_stills(code: str) -> dict[str, bytes]:
    """02/10: cảnh render trên L4 mất nền/sàn/ánh sáng môi trường — so các bộ cờ."""
    Path("/tmp/scene.js").write_text(code)
    Path("/tmp/stills").mkdir(exist_ok=True)
    subprocess.run(["node", "spike/gpu-stills.mts", "/tmp/scene.js", "/tmp/stills"], cwd=ROOT, timeout=500, check=False)
    return {p.name: p.read_bytes() for p in Path("/tmp/stills").glob("*.jpg")}


@app.local_entrypoint()
def stills(code: str, out: str) -> None:
    Path(out).mkdir(parents=True, exist_ok=True)
    for name, data in gpu_stills.remote(Path(code).read_text()).items():
        (Path(out) / name).write_bytes(data)
        print("ghi", Path(out) / name)


@app.function(gpu="L4", cpu=2, memory=4096, timeout=600)
def gpu_video(spec_json: str) -> dict[str, bytes]:
    """02/10: MP4 của render_three trên L4 mất nền/ánh sáng, ảnh tĩnh thì đúng — chạy đúng cli.ts."""
    Path("/tmp/code.json").write_text(spec_json)
    import json

    Path("/tmp/scene.js").write_text(json.loads(spec_json)["code"])
    Path("/tmp/stills").mkdir(exist_ok=True)
    env = {**os.environ, "OPENCMO_3D_GPU": "1"}
    subprocess.run(["node", "src/cli.ts", "/tmp/code.json", "/tmp/stills/video.mp4"], cwd=ROOT, env=env, timeout=280, check=False)
    subprocess.run(["node", "spike/gpu-stills.mts", "/tmp/scene.js", "/tmp/stills"], cwd=ROOT, env={**env, "ONLY": "prod", "W": "1080", "H": "1920"}, timeout=200, check=False)
    return {p.name: p.read_bytes() for p in Path("/tmp/stills").iterdir()}


@app.local_entrypoint()
def video(spec: str, out: str) -> None:
    Path(out).mkdir(parents=True, exist_ok=True)
    for name, data in gpu_video.remote(Path(spec).read_text()).items():
        (Path(out) / name).write_bytes(data)
        print("ghi", Path(out) / name)


@app.function(gpu="L4", cpu=2, memory=4096, timeout=900)
def gpu_variants(spec_json: str) -> None:
    """02/10: video trên L4 mất WebGL context ở khung 2 — thử các bộ cờ Chromium."""
    Path("/tmp/code.json").write_text(spec_json)
    subprocess.run(["node", "spike/gpu-variants.mts", "/tmp/code.json"], cwd=ROOT, timeout=800, check=False)


@app.local_entrypoint()
def variants(spec: str) -> None:
    gpu_variants.remote(Path(spec).read_text())
