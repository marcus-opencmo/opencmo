"""Kiểm tra phần thuần logic của backend Supabase — không chạm mạng."""

import json
from pathlib import Path

import httpx
import pytest

from opencmo.backends.supabase import (
    Job,
    ObjectTooLargeError,
    StaleAttemptError,
    SupabaseStore,
    Task,
    storage_path,
)

# `_CHUNK` sống ở module storage: patch bản re-export ở package thì code upload không thấy.
from opencmo.backends.supabase import storage as storage_module


def test_storage_path_puts_user_id_first():
    # Policy RLS ở 20260907162807_init.sql so segment đầu với auth.uid(), nên thứ tự này
    # là hợp đồng giữa worker và database — đổi là vỡ phân quyền.
    assert storage_path("u1", "j2", "00-hook.mp4") == "u1/j2/00-hook.mp4"


def test_job_from_row_defaults_clip_count():
    job = Job.from_row({"id": "j", "user_id": "u", "source_url": "https://x"})
    assert job.clips_requested == 5


def test_job_from_row_reads_clip_count():
    job = Job.from_row(
        {"id": "j", "user_id": "u", "source_url": "https://x", "clips_requested": 3}
    )
    assert job.clips_requested == 3


def test_job_from_row_handles_null_clip_count():
    # Postgres trả null cho cột chưa set; ép về mặc định thay vì vỡ.
    job = Job.from_row(
        {"id": "j", "user_id": "u", "source_url": "https://x", "clips_requested": None}
    )
    assert job.clips_requested == 5


def test_store_refuses_missing_credentials():
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        SupabaseStore("", "key")
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        SupabaseStore("https://x.supabase.co", "")


def test_store_strips_trailing_slash_from_url():
    store = SupabaseStore("https://x.supabase.co/", "key")
    try:
        assert store.url == "https://x.supabase.co"
    finally:
        store.close()


def test_job_from_row_defaults_to_watermarked():
    # Mặc định phải là CÓ watermark: cột thiếu hoặc null nghĩa là ta không biết
    # người dùng ở bậc nào, và đoán nhầm về phía "bản trả tiền" là cho không.
    job = Job.from_row({"id": "j", "user_id": "u", "source_url": "https://x"})
    assert job.watermark is True


def test_job_from_row_reads_watermark_flag():
    job = Job.from_row(
        {"id": "j", "user_id": "u", "source_url": "https://x", "watermark": False}
    )
    assert job.watermark is False


def _store_with(handler):
    store = SupabaseStore("https://x.supabase.co", "key")
    store._client = httpx.Client(transport=httpx.MockTransport(handler))
    store._sleep = lambda _seconds: None
    return store


def test_claim_job_returns_canonical_row_from_database():
    # Owner/nguồn/watermark phải đến từ hàng database, không từ payload của web.
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json=[
                {
                    "id": "j1",
                    "user_id": "u-db",
                    "source_url": "storage://u-db/a.mp4",
                    "clips_requested": 3,
                    "watermark": False,
                    "status": "running",
                    "attempt": 1,
                    "attempt_id": "a1",
                }
            ],
        )

    job = _store_with(handler).claim_job("j1")
    assert seen["path"] == "/rest/v1/rpc/claim_job_attempt"
    assert seen["body"]["p_job_id"] == "j1"
    assert (job.user_id, job.attempt, job.attempt_id, job.watermark) == ("u-db", 1, "a1", False)


def test_claim_job_reports_already_taken():
    store = _store_with(lambda request: httpx.Response(200, json=[]))
    assert store.claim_job("j1") is None


def test_stale_attempt_cannot_complete_job():
    store = _store_with(lambda request: httpx.Response(200, json=False))
    assert store.complete("j1", "old", title="t", duration=1.0, clips=[]) is False


def test_settle_null_means_attempt_was_replaced():
    # PostgREST trả body `null`; `httpx.Response(json=None)` lại tạo body rỗng.
    store = _store_with(
        lambda request: httpx.Response(
            200, content=b"null", headers={"Content-Type": "application/json"}
        )
    )
    with pytest.raises(StaleAttemptError):
        store.settle("j1", 60.0, attempt_id="old")


def test_settle_key_is_stable_per_attempt():
    # Modal chạy lại cùng attempt phải gặp lại đúng khoá, để database replay.
    keys = []

    def handler(request):
        keys.append(json.loads(request.content)["p_operation_key"])
        return httpx.Response(200, json=True)

    store = _store_with(handler)
    store.settle("j1", 60.0, attempt_id="a1")
    store.settle("j1", 60.0, attempt_id="a1")
    assert keys == ["settle:a1", "settle:a1"]


def test_permanent_error_does_not_leak_supabase_host():
    # Message này có thể nằm trong jobs.error, thứ trang kết quả đọc.
    store = _store_with(lambda request: httpx.Response(409, json={"message": "dup"}))
    with pytest.raises(Exception) as info:
        store.complete("j1", "a1", title="t", duration=1.0, clips=[])
    assert "supabase.co" not in str(info.value)


# ============================================================ Task (D2)


def test_task_from_row_reads_all_fields():
    task = Task.from_row(
        {
            "id": "t1",
            "user_id": "u1",
            "kind": "preview",
            "clip_id": "c1",
            "settings_hash": "h",
            "asset_id": None,
            "job_id": "j1",
            "payload": {"settings": {}},
            "status": "queued",
            "attempt": 0,
            "attempt_id": None,
            "created_at": "2026-01-01T00:00:00Z",
        }
    )
    assert task.id == "t1" and task.kind == "preview" and task.payload == {"settings": {}}


def test_task_from_row_defaults_status_and_attempt():
    task = Task.from_row({"id": "t1", "user_id": "u1", "kind": "zip", "job_id": "j1"})
    assert task.status == "queued"
    assert task.attempt == 0


def test_claim_next_task_sends_kinds_and_lease():
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=[{"id": "t1", "user_id": "u1", "kind": "preview", "job_id": None}])

    task = _store_with(handler).claim_next_task(["preview", "export"])
    assert seen["path"] == "/rest/v1/rpc/claim_next_task"
    assert seen["body"] == {"p_kinds": ["preview", "export"], "p_lease_seconds": 120}
    assert task.id == "t1"


def test_claim_next_task_empty_queue_returns_none():
    store = _store_with(lambda request: httpx.Response(200, json=[]))
    assert store.claim_next_task(["preview"]) is None


def test_claim_next_task_504_raises_transient_immediately():
    # KHÔNG idempotent: timeout có thể đã claim thật, retry sẽ claim đúp.
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(504)

    from opencmo.backends.retry import TransientError

    with pytest.raises(TransientError):
        _store_with(handler).claim_next_task(["preview"])
    assert len(calls) == 1


def test_claim_task_sends_task_id():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=[])

    _store_with(handler).claim_task("t1")
    assert seen["body"] == {"p_task_id": "t1", "p_lease_seconds": 120}


def test_heartbeat_task_retries_504_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(504)
        assert json.loads(request.content) == {
            "p_task_id": "t1",
            "p_attempt_id": "a1",
            "p_lease_seconds": 120,
        }
        return httpx.Response(200, json=True)

    assert _store_with(handler).heartbeat_task("t1", "a1") is True
    assert len(calls) == 2


def test_complete_task_sends_output_and_reads_bool():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=True)

    output = {"output_path": "renders/x/export.mp4", "bytes": 10}
    assert _store_with(handler).complete_task("t1", "a1", output) is True
    assert seen["body"] == {"p_task_id": "t1", "p_attempt_id": "a1", "p_output": output}


def test_fail_task_truncates_error_to_2000_chars():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=True)

    _store_with(handler).fail_task("t1", "a1", "x" * 3000)
    assert len(seen["body"]["p_error"]) == 2000


def test_reclaim_expired_tasks_returns_json_dict():
    store = _store_with(
        lambda request: httpx.Response(200, json={"requeued": 2, "failed": 1})
    )
    assert store.reclaim_expired_tasks(5) == {"requeued": 2, "failed": 1}


def test_complete_media_probe_sends_expected_body():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=True)

    store = _store_with(handler)
    store.complete_media_probe(
        "asset1", "a1", duration=12.5, width=1080, height=1920, ok=True, error=None
    )
    assert seen["body"] == {
        "p_asset_id": "asset1",
        "p_attempt_id": "a1",
        "p_duration": 12.5,
        "p_width": 1080,
        "p_height": 1920,
        "p_ok": True,
        "p_error": None,
    }


# ================================================= artifact / drafts / publish


def test_put_artifact_sends_expected_body_and_returns_row():
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"job_id": "j1", "kind": "transcript", "version": 1})

    row = _store_with(handler).put_artifact("j1", "a1", "transcript", {"segments": []})
    assert seen["path"] == "/rest/v1/rpc/put_artifact"
    assert seen["body"] == {
        "p_job_id": "j1",
        "p_attempt_id": "a1",
        "p_kind": "transcript",
        "p_data": {"segments": []},
    }
    assert row["version"] == 1


def test_put_artifact_translates_stale_attempt_error():
    store = _store_with(
        lambda request: httpx.Response(
            400,
            json={"code": "P0001", "message": "This processing attempt is no longer active."},
        )
    )
    with pytest.raises(StaleAttemptError):
        store.put_artifact("j1", "old", "transcript", {})


def test_put_artifact_other_permanent_error_is_not_translated():
    from opencmo.backends.retry import PermanentError

    store = _store_with(
        lambda request: httpx.Response(
            400, json={"code": "22023", "message": "Some other validation error."}
        )
    )
    with pytest.raises(PermanentError):
        store.put_artifact("j1", "a1", "transcript", {})


def test_create_clip_drafts_sends_expected_body_and_returns_count():
    seen = {}
    revisions = [{"clip_id": "c1", "settings": {}, "settings_hash": "h" * 64}]

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=1)

    count = _store_with(handler).create_clip_drafts("j1", "a1", revisions)
    assert seen["body"] == {"p_job_id": "j1", "p_attempt_id": "a1", "p_revisions": revisions}
    assert count == 1


def test_create_clip_drafts_translates_stale_attempt_error():
    store = _store_with(
        lambda request: httpx.Response(
            400,
            json={"code": "P0001", "message": "This processing attempt is no longer active."},
        )
    )
    with pytest.raises(StaleAttemptError):
        store.create_clip_drafts("j1", "old", [])


def test_complete_job_publication_sends_expected_body():
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=True)

    store = _store_with(handler)
    clips = [{"id": "c1", "idx": 0}]
    revisions = [{"clip_id": "c1", "settings": {}, "settings_hash": "h"}]
    manifest = {"attempt_id": "a1", "sections": [], "proxies": {}}
    ok = store.complete_job_publication(
        "j1", "a1", title="t", duration=60.0, clips=clips, revisions=revisions, manifest=manifest
    )
    assert ok is True
    assert seen["path"] == "/rest/v1/rpc/complete_job_publication"
    assert seen["body"] == {
        "p_job_id": "j1",
        "p_attempt_id": "a1",
        "p_title": "t",
        "p_duration_seconds": 60.0,
        "p_clips": clips,
        "p_revisions": revisions,
        "p_manifest": manifest,
    }


def test_complete_job_publication_false_when_not_true():
    store = _store_with(lambda request: httpx.Response(200, json=False))
    assert (
        store.complete_job_publication(
            "j1", "old", title="t", duration=1.0, clips=[], revisions=[], manifest={}
        )
        is False
    )


# ============================================================= read helpers


def test_get_task_returns_none_when_missing():
    store = _store_with(lambda request: httpx.Response(200, json=[]))
    assert store.get_task("t1") is None


def test_get_task_returns_task():
    store = _store_with(
        lambda request: httpx.Response(200, json=[{"id": "t1", "user_id": "u", "kind": "zip"}])
    )
    task = store.get_task("t1")
    assert isinstance(task, Task) and task.id == "t1"


def test_get_job_row_returns_full_dict_including_manifest():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json=[
                {
                    "id": "j1",
                    "user_id": "u1",
                    "source_url": "https://x",
                    "watermark": True,
                    "stage": "render",
                    "status": "running",
                    "attempt_id": "a1",
                    "media_manifest": {"sections": []},
                }
            ],
        )

    row = _store_with(handler).get_job_row("j1")
    assert seen["params"]["id"] == "eq.j1"
    assert row["media_manifest"] == {"sections": []}
    assert row["stage"] == "render"


def test_get_job_row_returns_none_when_missing():
    store = _store_with(lambda request: httpx.Response(200, json=[]))
    assert store.get_job_row("j1") is None


def test_get_clip_get_editor_revision_get_media_asset_return_none_when_missing():
    store = _store_with(lambda request: httpx.Response(200, json=[]))
    assert store.get_clip("c1") is None
    assert store.get_editor_revision("r1") is None
    assert store.get_media_asset("m1") is None


def test_get_clip_returns_row():
    store = _store_with(lambda request: httpx.Response(200, json=[{"id": "c1", "job_id": "j1"}]))
    assert store.get_clip("c1") == {"id": "c1", "job_id": "j1"}


def test_get_editor_transcript_reads_body_of_a_table_without_id():
    # `editor_transcripts` không có cột `id`: đi qua `_first_row` là hàng nào
    # cũng thành "không có", và export lỗi "captions are no longer available".
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=[{"body": '[{"text":"hi"}]'}])

    assert _store_with(handler).get_editor_transcript("c1", "a" * 64) == '[{"text":"hi"}]'
    assert seen["params"] == {"clip_id": "eq.c1", "hash": f"eq.{'a' * 64}", "select": "body"}
    assert _store_with(lambda request: httpx.Response(200, json=[])).get_editor_transcript("c1", "a" * 64) is None


def test_get_editor_revision_returns_row_with_document():
    row = {"id": "r1", "clip_id": "c1", "source": "x", "document": {"version": 1, "stage": {"children": []}}}
    assert _store_with(lambda request: httpx.Response(200, json=[row])).get_editor_revision("r1") == row


def test_list_artifacts_filters_by_job_and_kind_ordered_by_version():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=[{"version": 1, "data": {}, "created_at": "t", "attempt_id": "a"}])

    rows = _store_with(handler).list_artifacts("j1", "transcript")
    assert seen["params"]["job_id"] == "eq.j1"
    assert seen["params"]["kind"] == "eq.transcript"
    assert seen["params"]["order"] == "version.asc"
    assert rows[0]["version"] == 1


def test_get_tasks_uses_in_filter():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=[{"id": "t1", "user_id": "u", "kind": "export"}])

    tasks = _store_with(handler).get_tasks(["t1", "t2"])
    assert seen["params"]["id"] == "in.(t1,t2)"
    assert tasks[0].id == "t1"


def test_get_tasks_empty_list_short_circuits():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=[])

    assert _store_with(handler).get_tasks([]) == []
    assert calls == []


def test_list_clips_filters_by_job():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=[{"id": "c1", "job_id": "j1"}])

    rows = _store_with(handler).list_clips("j1")
    assert seen["params"]["job_id"] == "eq.j1"
    assert rows == [{"id": "c1", "job_id": "j1"}]


def test_update_job_stage_sends_fenced_patch():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        seen["body"] = json.loads(request.content)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200)

    _store_with(handler).update_job_stage("j1", "a1", "render")
    assert seen["params"] == {"id": "eq.j1", "attempt_id": "eq.a1", "status": "eq.running"}
    assert seen["body"] == {"stage": "render"}
    assert seen["headers"]["prefer"] == "return=minimal"


# ==================================================================== storage


def test_upload_object_streams_multiple_chunks_not_one_blob(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_module, "_CHUNK", 4)
    local = tmp_path / "clip.mp4"
    local.write_bytes(b"0123456789ABCDEF")  # 16 bytes / 4-byte chunks = 4 chunks

    seen = {}

    class InspectStreamingTransport(httpx.BaseTransport):
        def handle_request(self, request):
            # MockTransport gọi request.read() trước handler và gom generator
            # thành một blob. Transport nhỏ này quan sát đúng stream mà client
            # gửi xuống transport, trước bước buffer đó.
            chunks = list(request.stream)
            seen["chunks"] = chunks
            seen["body"] = b"".join(chunks)
            seen["headers"] = dict(request.headers)
            seen["path"] = request.url.path
            return httpx.Response(200, json={"Key": "clips/x"}, request=request)

    store = SupabaseStore("https://x.supabase.co", "key")
    store._client = httpx.Client(transport=InspectStreamingTransport())
    path = store.upload_object("clips", "u1/j1/0/x.mp4", local)
    assert path == "u1/j1/0/x.mp4"
    assert seen["path"] == "/storage/v1/object/clips/u1/j1/0/x.mp4"
    assert len(seen["chunks"]) > 1
    assert seen["body"] == b"0123456789ABCDEF"
    assert seen["headers"]["x-upsert"] == "false"


def test_replace_object_streams_and_explicitly_upserts(tmp_path):
    local = tmp_path / "final.mp4"
    local.write_bytes(b"faststart")
    seen = {}

    def handler(request):
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["headers"] = dict(request.headers)
        seen["body"] = request.read()
        return httpx.Response(200)

    path = _store_with(handler).replace_object("exports", "u1/c1/t1.mp4", local)
    assert path == "u1/c1/t1.mp4"
    assert seen["method"] == "POST"
    assert seen["path"] == "/storage/v1/object/exports/u1/c1/t1.mp4"
    assert seen["headers"]["x-upsert"] == "true"
    assert seen["body"] == b"faststart"


def test_upload_object_guesses_content_type():
    seen = {}

    def handler(request):
        list(request.stream)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200)

    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as fh:
        fh.write(b"data")
        local = Path(fh.name)
    try:
        _store_with(handler).upload_object("clips", "x/y.mp4", local)
    finally:
        local.unlink()
    assert seen["headers"]["content-type"] == "video/mp4"


def test_upload_object_duplicate_conflict_same_size_succeeds(tmp_path):
    local = tmp_path / "f.mp4"
    local.write_bytes(b"abcd")

    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(409, json={"error": "Duplicate", "message": "already exists"})
        assert request.method == "GET"
        return httpx.Response(200, json={"size": 4})

    path = _store_with(handler).upload_object("clips", "x/f.mp4", local)
    assert path == "x/f.mp4"
    assert calls == ["/storage/v1/object/clips/x/f.mp4", "/storage/v1/object/info/clips/x/f.mp4"]


def test_upload_object_duplicate_conflict_different_size_raises(tmp_path):
    from opencmo.backends.retry import PermanentError

    local = tmp_path / "f.mp4"
    local.write_bytes(b"abcd")

    def handler(request):
        if request.method == "POST":
            return httpx.Response(409, json={"error": "Duplicate"})
        return httpx.Response(200, json={"size": 999})

    with pytest.raises(PermanentError):
        _store_with(handler).upload_object("clips", "x/f.mp4", local)


def test_upload_object_400_duplicate_body_is_treated_as_conflict(tmp_path):
    local = tmp_path / "f.mp4"
    local.write_bytes(b"ab")

    def handler(request):
        if request.method == "POST":
            return httpx.Response(400, json={"error": "Duplicate"})
        return httpx.Response(200, json={"size": 2})

    path = _store_with(handler).upload_object("clips", "x/f.mp4", local)
    assert path == "x/f.mp4"


def test_upload_object_plain_400_is_not_treated_as_conflict(tmp_path):
    from opencmo.backends.retry import PermanentError

    local = tmp_path / "f.mp4"
    local.write_bytes(b"ab")

    def handler(request):
        return httpx.Response(400, json={"error": "InvalidRequest", "message": "bad"})

    with pytest.raises(PermanentError):
        _store_with(handler).upload_object("clips", "x/f.mp4", local)


def test_download_object_streams_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_module, "_CHUNK", 4)
    dest = tmp_path / "out.mp4"

    def handler(request):
        return httpx.Response(200, content=b"0123456789")

    result = _store_with(handler).download_object("sources", "u1/x.mp4", dest)
    assert result == dest
    assert dest.read_bytes() == b"0123456789"


def test_download_object_max_bytes_exceeded_removes_partial_file(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_module, "_CHUNK", 4)
    dest = tmp_path / "out.mp4"

    def handler(request):
        return httpx.Response(200, content=b"0123456789ABCDEF")

    with pytest.raises(ObjectTooLargeError):
        _store_with(handler).download_object("media", "u1/j1/x.mp4", dest, max_bytes=5)
    assert not dest.exists()


def test_download_object_retries_transient_response_and_truncates_partial(tmp_path):
    dest = tmp_path / "out.mp4"
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(504, content=b"gateway")
        return httpx.Response(200, content=b"complete")

    _store_with(handler).download_object("sources", "u1/x.mp4", dest)

    assert calls == 2
    assert dest.read_bytes() == b"complete"


def test_object_info_returns_size_dict():
    store = _store_with(
        lambda request: httpx.Response(200, json={"size": 123, "content_type": "video/mp4"})
    )
    info = store.object_info("media", "u1/j1/x.mp4")
    assert info == {"size": 123, "content_type": "video/mp4"}


def test_object_info_returns_none_on_404():
    store = _store_with(lambda request: httpx.Response(404, json={"error": "not_found"}))
    assert store.object_info("media", "missing") is None


def test_object_exists_true_and_false():
    store_true = _store_with(lambda request: httpx.Response(200))
    assert store_true.object_exists("media", "x") is True

    store_false = _store_with(lambda request: httpx.Response(404))
    assert store_false.object_exists("media", "x") is False


def test_remove_objects_sends_prefixes_and_raises_on_failure():
    seen = {}

    def ok_handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=[])

    _store_with(ok_handler).remove_objects("clips", ["a", "b"])
    assert seen["body"] == {"prefixes": ["a", "b"]}

    from opencmo.backends.retry import PermanentError

    store = _store_with(lambda request: httpx.Response(403, json={"message": "no"}))
    with pytest.raises(PermanentError):
        store.remove_objects("clips", ["a"])


def test_remove_objects_noop_on_empty_list():
    calls = []
    store = _store_with(lambda request: calls.append(1) or httpx.Response(200))
    store.remove_objects("clips", [])
    assert calls == []


# ------------------------------------------------------- legacy delegation


def test_legacy_upload_delegates_to_upload_object_with_no_upsert(tmp_path):
    seen = {}

    def handler(request):
        list(request.stream)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200)

    local = tmp_path / "00-hook.mp4"
    local.write_bytes(b"x")
    path = _store_with(handler).upload("u1/j1/0/00-hook.mp4", local)
    assert path == "u1/j1/0/00-hook.mp4"
    assert seen["headers"]["x-upsert"] == "false"


def test_legacy_download_source_still_checks_empty_file(tmp_path):
    dest = tmp_path / "src.mp4"
    store = _store_with(lambda request: httpx.Response(200, content=b""))
    with pytest.raises(RuntimeError, match="empty"):
        store.download_source("u1/x.mp4", dest)


def test_legacy_remove_source_swallows_errors():
    store = _store_with(lambda request: httpx.Response(500))
    store.remove_source("u1/x.mp4")  # không được ném


def test_legacy_delete_clip_objects_swallows_errors():
    store = _store_with(lambda request: httpx.Response(500))
    store.delete_clip_objects(["a", "b"])  # không được ném


def test_legacy_delete_clip_objects_noop_on_empty():
    calls = []
    store = _store_with(lambda request: calls.append(1) or httpx.Response(200))
    store.delete_clip_objects([])
    assert calls == []
