"""Lớp HTTP chung: một `httpx.Client` service-role, retry, gọi RPC."""

from __future__ import annotations

import time
from typing import Any

import httpx

from opencmo.backends import retry

_TIMEOUT = httpx.Timeout(60.0, connect=15.0)
_JSON = {"Content-Type": "application/json"}


class _Http:
    def __init__(self, url: str, service_role_key: str) -> None:
        if not url or not service_role_key:
            raise RuntimeError("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.")
        self.url = url.rstrip("/")
        self._client = httpx.Client(
            timeout=_TIMEOUT,
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
        )
        self._sleep = time.sleep

    def _send(self, method: str, path: str, *, idempotent: bool, **kwargs: Any) -> httpx.Response:
        return retry.call(
            lambda: self._client.request(method, f"{self.url}{path}", **kwargs),
            idempotent=idempotent,
            what=f"{method} {path}",
            sleep=self._sleep,
        )

    def _rpc(self, name: str, body: dict[str, Any], *, idempotent: bool) -> httpx.Response:
        return self._send(
            "POST", f"/rest/v1/rpc/{name}", idempotent=idempotent, json=body, headers=_JSON
        )

    def close(self) -> None:
        self._client.close()
