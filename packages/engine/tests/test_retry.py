"""Phân loại lỗi và backoff của `opencmo.backends.retry` — không chạm mạng."""

import httpx
import pytest

from opencmo.backends.retry import PermanentError, TransientError, call


def _responses(*items):
    queue = list(items)
    calls = []

    def send():
        calls.append(1)
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    return send, calls


def _run(send, **kwargs):
    sleeps = []
    kwargs.setdefault("idempotent", True)
    result = call(send, what="POST rpc", sleep=sleeps.append, rng=lambda: 0.0, **kwargs)
    return result, sleeps


def test_retries_transient_status_with_backoff():
    send, calls = _responses(httpx.Response(503), httpx.Response(502), httpx.Response(200))
    resp, sleeps = _run(send)
    assert resp.status_code == 200
    assert len(calls) == 3
    assert sleeps == [1.0, 2.0]


def test_transport_timeout_is_transient():
    request = httpx.Request("POST", "https://x")
    send, calls = _responses(httpx.ReadTimeout("slow", request=request), httpx.Response(200))
    resp, _ = _run(send)
    assert resp.status_code == 200 and len(calls) == 2


def test_honours_retry_after_header():
    send, _ = _responses(httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(200))
    _, sleeps = _run(send)
    assert sleeps == [3.0]


def test_gives_up_after_three_retries():
    send, calls = _responses(httpx.Response(504))
    with pytest.raises(TransientError):
        _run(send)
    assert len(calls) == 4


def test_non_idempotent_call_is_never_retried():
    send, calls = _responses(httpx.Response(504), httpx.Response(200))
    with pytest.raises(TransientError):
        _run(send, idempotent=False)
    assert len(calls) == 1


def test_permanent_status_is_not_retried():
    send, calls = _responses(httpx.Response(403), httpx.Response(200))
    with pytest.raises(PermanentError) as info:
        _run(send)
    assert len(calls) == 1 and info.value.status == 403


def test_permanent_error_carries_parsed_body_for_translation():
    # `SupabaseStore.put_artifact` cần đọc lại message P0001 gốc để dịch sang
    # `StaleAttemptError` — nếu message tổng hợp của `call()` là thứ duy nhất
    # còn lại thì không tài nào phân biệt được với một lỗi 400 khác.
    send, _ = _responses(
        httpx.Response(400, json={"code": "P0001", "message": "boom"}),
    )
    with pytest.raises(PermanentError) as info:
        _run(send)
    assert info.value.body == {"code": "P0001", "message": "boom"}


def test_permanent_error_body_is_none_when_not_json():
    send, _ = _responses(httpx.Response(400, content=b"not json"))
    with pytest.raises(PermanentError) as info:
        _run(send)
    assert info.value.body is None


def test_deadline_stops_retrying_before_waiting_past_it():
    now = [0.0]
    send, calls = _responses(httpx.Response(503))
    with pytest.raises(TransientError):
        call(
            send,
            idempotent=True,
            what="POST rpc",
            sleep=lambda s: now.__setitem__(0, now[0] + s),
            clock=lambda: now[0],
            rng=lambda: 0.0,
            deadline=2.5,
        )
    # 1s rồi 2s: lần chờ thứ hai vượt hạn 2.5s nên dừng sau hai request.
    assert len(calls) == 2


def test_jitter_stays_within_a_quarter():
    send, _ = _responses(httpx.Response(503), httpx.Response(200))
    sleeps = []
    call(send, idempotent=True, what="x", sleep=sleeps.append, rng=lambda: 1.0)
    assert sleeps == [1.25]
