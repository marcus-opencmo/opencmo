from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import httpx
import pytest

from opencmo.backends.supabase import SupabaseStore
from opencmo.models import Clip, JobResult, Moment, SourceInfo, Timings
from opencmo.worker import job_editor, probe_media, process_job
from opencmo.worker.loop import _claim_work, _dispatch

ROOT = Path(__file__).resolve().parents[3]
WEB = ROOT / "apps/web"


def _local_env() -> dict[str, str]:
    try:
        output = subprocess.check_output(
            ["supabase", "status", "-o", "env"], cwd=WEB, text=True, stderr=subprocess.DEVNULL
        )
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("Supabase local chưa chạy")
    values = {}
    for line in output.splitlines():
        key, sep, value = line.partition("=")
        if sep and key in {"API_URL", "SERVICE_ROLE_KEY"}:
            values[key] = value.strip().strip('"').strip("'")
    if not values.get("API_URL") or not values.get("SERVICE_ROLE_KEY"):
        pytest.skip("Supabase local thiếu REST/Storage")
    return values


def _video(path: Path, seconds: int, color: str | None = None) -> None:
    source = f"color=c={color}:s=640x360:r=25:d={seconds}" if color else (
        f"testsrc2=size=640x360:rate=25:duration={seconds}"
    )
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", source,
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            str(path),
        ],
        check=True,
    )


def test_worker_e2e_local_supabase(monkeypatch, tmp_path):
    env = _local_env()
    url, key = env["API_URL"], env["SERVICE_ROLE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    client = httpx.Client(base_url=url, headers=headers, timeout=30)
    user_id = str(uuid.uuid4())
    email = f"worker-{user_id}@example.test"
    created = client.post(
        "/auth/v1/admin/users",
        json={"id": user_id, "email": email, "password": "Local-test-123!", "email_confirm": True},
    )
    if created.status_code >= 400:
        pytest.skip(f"Supabase Auth local không sẵn sàng: {created.status_code}")

    # Đăng ký không còn tặng credit (`20260921150000_hard_paywall.sql`), nên nạp
    # tường minh: số dư 0 thì `settle_job_credits` ném ngay cả với clip 30 giây
    # và cả ca này chết ở "Not enough credits" thay vì đo đường đi của worker.
    client.post(
        "/rest/v1/credit_ledger",
        json={"user_id": user_id, "delta": 60, "reason": "Test top-up"},
    ).raise_for_status()

    store = SupabaseStore(url, key)
    try:
        source = tmp_path / "source.mp4"
        _video(source, 30)
        source_object = f"{user_id}/e2e.mp4"
        store.upload_object("sources", source_object, source, content_type="video/mp4")
        job_row = client.post(
            "/rest/v1/jobs",
            headers={**headers, "Prefer": "return=representation"},
            json={
                "user_id": user_id, "source_url": f"storage://{source_object}",
                "clips_requested": 1, "watermark": False,
            },
        ).raise_for_status().json()[0]
        def fake_pipeline(local_source, cfg, **callbacks):
            info = SourceInfo(local_source, "E2E", 30)
            callbacks["on_probe"](info)
            callbacks["on_progress"]("select")
            transcript = {
                "version": 1, "language": "en", "source": "subs",
                "segments": [{"start": 0.0, "end": 2.0, "text": "hello e2e", "words": None}],
            }
            for kind, data in (
                ("source", {"version": 1, "url": local_source, "title": "E2E", "duration": 30}),
                ("transcript", transcript),
                ("moments", {"version": 1, "moments": [{"start": 0, "end": 2, "hook": "E2E"}]}),
                ("render_settings", {"version": 1, "width": 1080, "height": 1920}),
            ):
                callbacks["on_artifact"](kind, data)
            moment = Moment(0, 2, "E2E", 9, "fixture")
            callbacks["on_sections"]([moment], [(Path(local_source), 0.0)])
            out = cfg.out_dir / "00-e2e.mp4"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", local_source, "-t", "2", "-c", "copy", str(out)],
                check=True,
            )
            return JobResult(info, [Clip(0, moment, str(out))], Timings())

        monkeypatch.setattr(process_job, "run_pipeline", fake_pipeline)
        monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [(0.0, 0.5, 0.1)])
        handlers = {
            "job": process_job.process,
            "probe_media": probe_media.process,
        }
        job = _claim_work(store)
        assert job is not None and job.id == job_row["id"]
        _dispatch(store, handlers, job)

        done = store.get_job_row(job.id)
        assert done["status"] == "done"
        assert store.list_artifacts(job.id, "transcript")
        assert store.list_artifacts(job.id, "face_track")
        clip = store.list_clips(job.id)[0]
        proxy = done["media_manifest"]["proxies"][clip["id"]]
        assert store.object_exists(proxy["bucket"], proxy["object"])

        settings = client.get(
            "/rest/v1/clips", params={"id": f"eq.{clip['id']}", "select": "settings,settings_hash"}
        ).raise_for_status().json()
        assert settings[0]["settings"] and settings[0]["settings_hash"]

        asset_id = str(uuid.uuid4())
        broll = tmp_path / "broll.mp4"
        _video(broll, 2, "red")
        media_object = f"{user_id}/{job.id}/{asset_id}.mp4"
        store.upload_object("media", media_object, broll, content_type="video/mp4")
        client.post(
            "/rest/v1/media_assets", headers={**headers, "Prefer": "return=minimal"},
            json={
                "id": asset_id, "user_id": user_id, "job_id": job.id,
                "storage_path": f"media/{media_object}", "name": "broll.mp4", "status": "pending",
            },
        ).raise_for_status()
        probe_id = str(uuid.uuid4())
        client.post(
            "/rest/v1/tasks", headers={**headers, "Prefer": "return=minimal"},
            json={
                "id": probe_id, "request_id": str(uuid.uuid4()), "user_id": user_id,
                "kind": "probe_media", "asset_id": asset_id,
            },
        ).raise_for_status()
        probe = _claim_work(store)
        assert probe is not None and probe.id == probe_id
        _dispatch(store, handlers, probe)
        assert store.get_task(probe_id).status == "done"

        # Ảnh (plan Palmier P2-b): frame từ save_frame / ảnh tham chiếu qua cùng probe, ra `ready` không thời lượng.
        image_id = str(uuid.uuid4())
        still = tmp_path / "frame.png"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x568", "-frames:v", "1", str(still)],
            check=True,
        )
        image_object = f"{user_id}/{job.id}/{image_id}.png"
        store.upload_object("media", image_object, still, content_type="image/png")
        client.post(
            "/rest/v1/media_assets", headers={**headers, "Prefer": "return=minimal"},
            json={
                "id": image_id, "user_id": user_id, "job_id": job.id,
                "storage_path": f"media/{image_object}", "name": "frame.png", "status": "pending",
            },
        ).raise_for_status()
        image_probe = str(uuid.uuid4())
        client.post(
            "/rest/v1/tasks", headers={**headers, "Prefer": "return=minimal"},
            json={"id": image_probe, "request_id": str(uuid.uuid4()), "user_id": user_id, "kind": "probe_media", "asset_id": image_id},
        ).raise_for_status()
        claimed = _claim_work(store)
        assert claimed is not None and claimed.id == image_probe
        _dispatch(store, handlers, claimed)
        image_row = client.get(
            "/rest/v1/media_assets", params={"id": f"eq.{image_id}", "select": "status,duration,width,height"}
        ).raise_for_status().json()[0]
        assert image_row == {"status": "ready", "duration": None, "width": 320, "height": 568}

    finally:
        store.close()
        client.delete(f"/auth/v1/admin/users/{user_id}")
        client.close()
