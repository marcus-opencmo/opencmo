from __future__ import annotations

import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from opencmo.backends.retry import TransientError
from opencmo.backends.supabase import Task
from opencmo.worker import publish_media_task as pm

USER = "11111111-1111-4111-8111-111111111111"
CLIP = "22222222-2222-4222-8222-222222222222"
EXPORT = "33333333-3333-4333-8333-333333333333"
OBJECT = f"{USER}/{CLIP}/{EXPORT}.mp4"

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")


@pytest.fixture(scope="module")
def mp4(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    out = tmp_path_factory.mktemp("media") / "short.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=180x320:rate=10:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
        check=True,
    )
    return out.read_bytes()


class Server:
    """Storage (GET) and Zernio's presigned upload (PUT) on one local port."""

    def __init__(self, source: bytes) -> None:
        self.source = source
        self.put_status = 200
        self.uploads: list[tuple[dict[str, str], bytes]] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                if self.path != "/source.mp4":
                    self.send_response(404)
                    self.end_headers()
                    return
                body = server.source
                rng = self.headers.get("Range")
                status = 200
                if rng and rng.startswith("bytes="):
                    start_s, _, end_s = rng[6:].partition("-")
                    start = int(start_s)
                    end = int(end_s) if end_s else len(body) - 1
                    status, part = 206, body[start:end + 1]
                    self.send_response(status)
                    self.send_header("Content-Range", f"bytes {start}-{start + len(part) - 1}/{len(body)}")
                    body = part
                else:
                    self.send_response(status)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_PUT(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(length)
                server.uploads.append(({k.lower(): v for k, v in self.headers.items()}, data))
                self.send_response(server.put_status)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()


class FakeStore:
    def __init__(self, server: Server) -> None:
        self.server = server
        self.completed: list[dict] = []
        self.failed: list[str] = []
        self.signed: list[tuple[str, str]] = []

    def sign_object_url(self, bucket: str, path: str, expires_in: int = 3600) -> str:
        self.signed.append((bucket, path))
        return f"{self.server.base}/source.mp4"

    def heartbeat_task(self, task_id: str, attempt_id: str | None) -> bool:
        return True

    def complete_task(self, task_id: str, attempt_id: str | None, output: dict) -> bool:
        self.completed.append(output)
        return True

    def fail_task(self, task_id: str, attempt_id: str | None, error: str) -> None:
        self.failed.append(error)

    def get_task(self, task_id: str) -> None:
        return None


@pytest.fixture
def server(mp4: bytes, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENCMO_PUBLISH_UPLOAD_HOSTS", "127.0.0.1")
    s = Server(mp4)
    yield s
    s.close()


def task(server: Server, **payload: object) -> Task:
    base = {
        "bucket": "exports",
        "object": OBJECT,
        "upload_url": f"{server.base}/upload/short.mp4?X-Amz-Signature=abc",
        "content_type": "video/mp4",
    }
    base.update(payload)
    return Task(id="t1", user_id=USER, kind="publish_media", payload=base, attempt_id="a1")


def test_streams_the_export_to_the_presigned_url(server: Server, mp4: bytes) -> None:
    store = FakeStore(server)
    pm.process(store, task(server))
    assert store.failed == []
    assert store.signed == [("exports", OBJECT)]
    [(headers, body)] = server.uploads
    assert body == mp4
    assert headers["content-type"] == "video/mp4"
    assert headers["content-length"] == str(len(mp4))
    assert "transfer-encoding" not in headers
    assert "authorization" not in headers
    [output] = store.completed
    assert output["bytes"] == len(mp4) and output["width"] == 180 and output["height"] == 320
    assert output["duration"] == pytest.approx(2, abs=0.2)


def test_streams_a_post_image_still(mp4: bytes, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """P5: a post's image is one still of `render_stills`, read as a PNG (named demuxer) and sent as image/png."""
    png = tmp_path / "still.png"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x320", "-frames:v", "1", str(png)], check=True)
    monkeypatch.setenv("OPENCMO_PUBLISH_UPLOAD_HOSTS", "127.0.0.1")
    s = Server(png.read_bytes())
    try:
        store = FakeStore(s)
        still = f"{USER}/{CLIP}/{EXPORT}-01.png"
        pm.process(store, task(s, object=still, content_type="image/png"))
        assert store.failed == []
        [(headers, body)] = s.uploads
        assert headers["content-type"] == "image/png" and body == png.read_bytes()
        [output] = store.completed
        assert output["width"] == 320 and output["height"] == 320 and "duration" not in output
        # A video sent as an image, or a still that is not a PNG, is refused.
        bad = FakeStore(s)
        pm.process(bad, task(s, object=still, content_type="video/mp4"))
        assert bad.completed == [] and bad.failed == [pm.NOT_PLAYABLE]
    finally:
        s.close()
    s2 = Server(mp4)
    try:
        wrong = FakeStore(s2)
        pm.process(wrong, task(s2, object=f"{USER}/{CLIP}/{EXPORT}-01.png", content_type="image/png"))
        assert wrong.failed == [pm.NOT_PLAYABLE]
    finally:
        s2.close()


@pytest.mark.parametrize(
    "payload",
    [
        {"object": f"44444444-4444-4444-8444-444444444444/{CLIP}/{EXPORT}.mp4"},  # someone else's export
        {"bucket": "media"},
        {"object": f"{USER}/{CLIP}/../x.mp4"},
    ],
)
def test_refuses_a_source_that_is_not_the_owners_export(server: Server, payload: dict) -> None:
    store = FakeStore(server)
    pm.process(store, task(server, **payload))
    assert store.failed == [pm.NOT_PLAYABLE] and store.signed == [] and server.uploads == []


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com/upload",
        "http://bucket.r2.cloudflarestorage.com/upload",
        "file:///etc/passwd",
        "https://user:pw@bucket.r2.cloudflarestorage.com/x",
    ],
)
def test_upload_url_allowlist(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENCMO_PUBLISH_UPLOAD_HOSTS", raising=False)
    assert not pm.upload_url_allowed(url)
    assert pm.upload_url_allowed("https://acct.r2.cloudflarestorage.com/temp/1_a.mp4?X-Amz-Signature=x")
    assert not pm.upload_url_allowed("http://127.0.0.1:9/upload"), "local only when the env names it"


def test_refuses_a_file_that_is_not_a_playable_mp4(server: Server) -> None:
    server.source = b"#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n"
    store = FakeStore(server)
    pm.process(store, task(server))
    assert store.failed == [pm.NOT_PLAYABLE] and server.uploads == []


def test_expired_upload_link_fails_with_a_reason(server: Server) -> None:
    server.put_status = 403
    store = FakeStore(server)
    pm.process(store, task(server))
    assert store.failed == [pm.EXPIRED] and store.completed == []


def test_upload_5xx_is_retried_by_the_lease(server: Server) -> None:
    server.put_status = 503
    with pytest.raises(TransientError):
        pm.process(FakeStore(server), task(server))


def test_never_reads_the_whole_file_into_memory() -> None:
    source = Path(pm.__file__).read_text(encoding="utf-8")
    assert ".read()" not in source and "download_object" not in source
