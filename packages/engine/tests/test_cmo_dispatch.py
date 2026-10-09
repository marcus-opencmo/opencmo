"""Dispatch of AI CMO runs from Modal to the web app."""

from __future__ import annotations

import threading

import httpx

from opencmo.worker import cmo_dispatch


def test_web_config_needs_url_and_secret():
    assert cmo_dispatch.web_config({}) is None
    assert cmo_dispatch.web_config({"OPENCMO_WEB_URL": "https://x.app"}) is None
    assert cmo_dispatch.web_config(
        {"OPENCMO_WEB_URL": "https://x.app/", "CRON_SECRET": "s"}
    ) == ("https://x.app", "s")


def test_count_dispatchable_uses_claim_rule():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["or"] = request.url.params["or"]
        seen["limit"] = request.url.params["limit"]
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, json=[{"id": "a"}, {"id": "b"}])

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        count = cmo_dispatch.count_dispatchable("https://db.example/", "key", client=client)

    assert count == 2
    assert seen["path"] == "/rest/v1/cmo_runs"
    assert "status.eq.queued" in seen["or"] and "not_before.lte." in seen["or"]
    assert "status.eq.running" in seen["or"] and "lease_until.lt." in seen["or"]
    assert seen["limit"] == str(cmo_dispatch.MAX_DISPATCH)
    assert seen["auth"] == "Bearer key"


def test_dispatch_calls_run_route_once_per_run_and_caps():
    calls = []
    lock = threading.Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        with lock:
            calls.append((request.method, request.url.path, request.headers["authorization"]))
        return httpx.Response(202, json={"accepted": True})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert cmo_dispatch.dispatch("https://web.example", "s", 3, client=client) == 3
        assert cmo_dispatch.dispatch("https://web.example", "s", 0, client=client) == 0
        assert (
            cmo_dispatch.dispatch("https://web.example", "s", 50, client=client)
            == cmo_dispatch.MAX_DISPATCH
        )

    assert len(calls) == 3 + cmo_dispatch.MAX_DISPATCH
    assert calls[0] == ("POST", "/api/internal/cmo/run", "Bearer s")


def test_dispatch_counts_only_accepted_calls():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Forbidden."})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert cmo_dispatch.dispatch("https://web.example", "wrong", 2, client=client) == 0
