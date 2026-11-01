"""`opencmo-mcp`: OpenCMO's MCP server on Modal, in its own app.

The TypeScript server (packages/mcp-server) lets the user's own Claude drive OpenCMO. One small
always-warm container answers every session: the server is stateless, waits on the database, and
never runs scene code (previews go to `motion_preview`, renders through the task queue).

Why a separate app and secret (docs/plans/security/2026-10-17-mcp-auth-api-fixes-plan.md,
items 1 and 2):
  - The container faces the internet. It mounts one secret, `opencmo-mcp`, and nothing of the
    worker's (`opencmo`: service role for the worker, `CRON_SECRET`, `OPENCMO_WORKER_TOKEN`; the
    provider keys). It wakes the worker through the worker's `wake` endpoint, whose token can only
    start an early sweep.
  - Modal's request quota is per workspace, and every request counts before any container runs,
    so only a separate workspace keeps a flood against MCP from starving the web app's `submit`.
    For now it shares the worker's workspace (owner's call, 2026-10-19: no paying users yet). To
    move it: deploy this file in a new workspace, set `OPENCMO_MCP_URL` there and on Vercel, and
    connected apps reconnect once.
This file does not import `modal_app`: that would build the worker's secret objects here.

Deploy:
    npm run build --workspace @opencmo/mcp-server
    modal secret create opencmo-mcp \
        NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
        SUPABASE_JWT_SECRET=...          # API key -> 5-minute user JWT
        SUPABASE_SERVICE_ROLE_KEY=...    # only for `api_key_owner`
        GROQ_API_KEY=... [ANTHROPIC_API_KEY=... GEMINI_API_KEY=... FAL_KEY=...]   # moderation, any provider
        MOTION_PREVIEW_URL=... MOTION_PREVIEW_TOKEN=... \
        OPENCMO_MCP_URL=https://<workspace>--opencmo-mcp.<region>.modal.run/mcp \
        OPENCMO_WEB_URL=https://opencmo.io \
        OPENCMO_MCP_CONFIRM_KEY=...      # signs confirm codes; its own random value
        OPENCMO_WAKE_URL=https://<workspace>--opencmo-wake.<region>.modal.run \
        OPENCMO_WAKE_TOKEN=...           # same value as in the worker's `opencmo` secret
        OPENCMO_LOOK_URL=https://<workspace>--opencmo-look.<region>.modal.run \
        OPENCMO_LOOK_TOKEN=...           # capture_frame & co.; same value as in `opencmo`
        OPENCMO_VOICE_ENABLED=1          # list voice tools; the worker holds the voice key
        OPENCMO_MOTION=modal             # explainers (preview_explainer, add_explainer); unset hides them
        OPENCMO_ENV=production           # turns on the production-only guards (isProduction())
    modal deploy mcp_app.py            # prints the URL; OPENCMO_MCP_URL is it plus /mcp
After changing only the secret, stop the warm container (`modal container stop -y <id>`): a deploy
without code changes keeps it running with the old values.
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

APP_NAME = "opencmo-mcp"
NODE_VERSION = "22.22.2"
MCP_PORT = 8000
_BUNDLE = Path(__file__).parent.parent / "mcp-server" / "dist" / "server.cjs"
_ROOT = "/root/mcp"

app = modal.App(APP_NAME)

# Modal imports this file again inside the container, where the local bundle path does not exist:
# check for the bundle only on the deploying machine.
if _BUNDLE.exists() or not modal.is_local():
    image = (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("curl", "xz-utils")
        .run_commands(
            f"curl -sSLf https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
            " | tar -xJ -C /usr/local --strip-components=1",
        )
        .add_local_file(_BUNDLE, remote_path=f"{_ROOT}/server.cjs")
    )

    @app.function(
        image=image,
        secrets=[modal.Secret.from_name("opencmo-mcp")],
        # Warm for a snappy connector (0.25 core, 0.5 GiB). Modal cuts web requests at 150 s,
        # which is why every slow tool is async.
        min_containers=1,
        # A flood scales to at most 3 containers. It does not protect the quota (Modal checks it
        # before any container runs; only a separate workspace does that), it caps the bill.
        max_containers=3,
        cpu=0.25,
        memory=512,
        timeout=150,
    )
    @modal.concurrent(max_inputs=50)
    @modal.web_server(port=MCP_PORT, startup_timeout=60, label=APP_NAME)
    def mcp_server() -> None:
        import subprocess

        env = {**os.environ, "PORT": str(MCP_PORT), "HOST": "0.0.0.0"}
        subprocess.Popen(["node", "--enable-source-maps", f"{_ROOT}/server.cjs"], env=env)
else:
    raise SystemExit("Build the MCP bundle first: npm run build --workspace @opencmo/mcp-server")
