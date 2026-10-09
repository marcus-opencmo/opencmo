"""Tái hiện lỗi Modal/Supabase 13/09 bằng HTTP mock — không chạm mạng.

Hai lỗi thật (plan 2026-09-13 §2): `claim_next_job` 504 lúc 11:00:27 và
`settle_job_credits` 504 lúc 17:30:09. Bốn test đầu từng là `xfail(strict)` và
đã fail đúng lý do trên worker cũ trước khi sửa (xem plan P0.1).
"""

from __future__ import annotations

import json

import httpx
import pytest

from opencmo.backends.supabase import Job, SupabaseStore

JOB = "095ba0e4-787c-4ece-87cf-7db6b379ccfb"


def _store(handler) -> SupabaseStore:
    store = SupabaseStore("https://x.supabase.co", "key")
    store._client = httpx.Client(transport=httpx.MockTransport(handler))
    # Retry có backoff; test không được ngủ thật.
    store._sleep = lambda _seconds: None
    return store


def _rpc(request: httpx.Request) -> str | None:
    path = request.url.path
    return path.rsplit("/", 1)[-1] if "/rest/v1/rpc/" in path else None


# ------------------------------------------------------------------ settle


def test_settle_survives_one_transient_504():
    calls = []

    def handler(request):
        calls.append(_rpc(request))
        if len(calls) == 1:
            return httpx.Response(504, text="Gateway Timeout")
        return httpx.Response(200, json=True)

    _store(handler).settle(JOB, 196.0)
    assert calls == ["settle_job_credits", "settle_job_credits"]


def test_settle_retry_after_lost_response_reuses_operation_key():
    # Server đã commit nhưng response mất. Retry chỉ an toàn khi server nhận ra
    # đây là CÙNG một thao tác — không được giả định request đầu chưa chạy.
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            raise httpx.ReadTimeout("response lost after commit", request=request)
        return httpx.Response(200, json=True)

    _store(handler).settle(JOB, 196.0)
    assert len(bodies) == 2
    key = bodies[0].get("p_operation_key")
    assert key and bodies[1].get("p_operation_key") == key


def test_settle_does_not_retry_auth_errors():
    from opencmo.backends.retry import PermanentError

    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401, json={"message": "bad key"})

    with pytest.raises(PermanentError):
        _store(handler).settle(JOB, 196.0)
    assert len(calls) == 1


# ------------------------------------------------------------- claim_next


def test_claim_next_504_is_transient_and_not_blind_retried():
    # Claim không idempotent: timeout có thể đã đổi một job sang running. Retry
    # mù sẽ nhận thêm job thứ hai; lease mới là đường phục hồi job thứ nhất.
    from opencmo.backends.retry import TransientError

    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(504, text="Gateway Timeout")

    with pytest.raises(TransientError):
        _store(handler).claim_next_job()
    assert len(calls) == 1


# ---------------------------------------------------- failure + refund


class _FakeServer:
    """Giữ trạng thái job/ledger tối thiểu để thấy được 'failed mà không hoàn'."""

    def __init__(self) -> None:
        self.status = "running"
        self.refunded = False
        self.finalize_calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        rpc = _rpc(request)
        if request.method == "GET" and request.url.path.endswith("/clips"):
            return httpx.Response(200, json=[])
        if request.method == "GET" and request.url.path.endswith("/jobs"):
            return httpx.Response(200, json=[{"id": JOB, "status": self.status}])
        if request.method == "PATCH" and request.url.path.endswith("/jobs"):
            if request.url.params.get("status") == "eq.running" and self.status == "running":
                self.status = "failed"
                return httpx.Response(200, json=[{"id": JOB}])
            return httpx.Response(200, json=[])
        if rpc == "refund_job":
            raise httpx.ReadTimeout("refund timed out", request=request)
        if rpc == "finalize_job_failure":
            self.finalize_calls += 1
            if self.finalize_calls == 1:
                self.status, self.refunded = "failed", True
                raise httpx.ReadTimeout("response lost after commit", request=request)
            return httpx.Response(200, json={"transitioned": False, "refunded": 10})
        return httpx.Response(200, json=True)


def _boom(*_args, **_kwargs):
    raise RuntimeError("render exploded")


def test_refund_timeout_cannot_leave_failed_job_unrefunded(monkeypatch):
    import opencmo.worker.process_job

    server = _FakeServer()
    monkeypatch.setattr(opencmo.worker.process_job, "run_pipeline", _boom)

    # `process` không được ném: lỗi chốt job thuộc về reconciler, không phải
    # Modal retry chạy lại cả pipeline.
    opencmo.worker.process_job.process(
        _store(server.handler),
        Job(id=JOB, user_id="u", source_url="https://youtu.be/x", clips_requested=3),
    )

    assert not (server.status == "failed" and not server.refunded)
    assert server.finalize_calls == 2


def test_get_scene_code_doc_dung_dong_chi_co_cot_code() -> None:
    # Lỗi thật 01/10: dùng `_first_row` (đòi cột `id`) cho truy vấn chỉ chọn `code`
    # → luôn None → mọi cảnh code render hỏng "code was not found". FakeStore của
    # test generate_task bỏ qua tầng REST nên không bắt được.
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=[{"code": "return (t) => {};"}])

    store = _store(handler)
    assert store.get_scene_code("user-1", "a" * 64) == "return (t) => {};"
    assert "user_id=eq.user-1" in seen["url"] and f"hash=eq.{'a' * 64}" in seen["url"]
    assert _store(lambda _r: httpx.Response(200, json=[])).get_scene_code("user-1", "a" * 64) is None


def test_task_progress_goi_dung_rpc_va_doc_ket_qua() -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=True)

    assert _store(handler).task_progress("t1", "a1", 0.123456) is True
    assert seen["url"].endswith("/rest/v1/rpc/task_progress")
    assert seen["body"] == {"p_task_id": "t1", "p_attempt_id": "a1", "p_progress": 0.1235}
    assert _store(lambda _r: httpx.Response(200, json=False)).task_progress("t1", "old", 0.5) is False
