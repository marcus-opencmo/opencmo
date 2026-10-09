"""Dispatch queued AI CMO runs to the web app.

The CMO jobs are TypeScript and live in the web app (they only wait on LLMs and the database).
Modal is just the clock: `sweep()` counts the runs waiting in `cmo_runs` and calls
`/api/internal/cmo/run` once per run, so each run gets its own Vercel function and they run in
parallel. The route answers 202 at once and claims its own lease, so an extra call is harmless.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import httpx

log = logging.getLogger("opencmo.worker.cmo")

# Cap per sweep: a burst (a bug on the web side, spam) must not open hundreds of functions in
# one minute. Anything left waits for the next sweep.
MAX_DISPATCH = 10
_CALL_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


def web_config(env: dict[str, str]) -> tuple[str, str] | None:
    """Web base URL and cron secret, or None when the worker is not wired to the web app."""
    url = env.get("OPENCMO_WEB_URL", "").strip().rstrip("/")
    secret = env.get("CRON_SECRET", "").strip()
    return (url, secret) if url and secret else None


def count_dispatchable(
    supabase_url: str, service_role_key: str, *, limit: int = MAX_DISPATCH, client: httpx.Client | None = None
) -> int:
    """Runs a call to `/api/internal/cmo/run` would pick up now.

    Same rule as `claim_cmo_run`: queued and past `not_before`, or running with an expired lease
    (the claim puts those back in the queue).
    """
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    claimable = (
        f'(and(status.eq.queued,or(not_before.is.null,not_before.lte."{now}")),'
        f'and(status.eq.running,kind.neq.onboard,lease_until.lt."{now}"))'
    )
    own = client is None
    http = client or httpx.Client(timeout=_CALL_TIMEOUT)
    try:
        resp = http.get(
            f"{supabase_url.rstrip('/')}/rest/v1/cmo_runs",
            params={"select": "id", "or": claimable, "limit": str(limit)},
            headers={"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"},
        )
        resp.raise_for_status()
        return len(resp.json())
    finally:
        if own:
            http.close()


def dispatch(web_url: str, secret: str, count: int, *, client: httpx.Client | None = None) -> int:
    """Calls the run route `count` times in parallel. Returns how many calls were accepted."""
    count = max(0, min(count, MAX_DISPATCH))
    if count == 0:
        return 0
    own = client is None
    http = client or httpx.Client(timeout=_CALL_TIMEOUT)

    def call(_: int) -> bool:
        try:
            resp = http.post(
                f"{web_url}/api/internal/cmo/run", headers={"Authorization": f"Bearer {secret}"}
            )
        except httpx.HTTPError as exc:
            log.warning("CMO dispatch failed: %s", exc)
            return False
        if resp.status_code != 202:
            log.warning("CMO dispatch answered %s", resp.status_code)
            return False
        return True

    try:
        with ThreadPoolExecutor(max_workers=count) as pool:
            return sum(pool.map(call, range(count)))
    finally:
        if own:
            http.close()


def call_cron(web_url: str, secret: str, path: str, *, timeout: float = 300.0) -> dict:
    """GET a web cron route (`/api/cron/cmo`, `/api/cron/cleanup`) and return its JSON."""
    resp = httpx.get(
        f"{web_url}{path}",
        headers={"Authorization": f"Bearer {secret}"},
        timeout=httpx.Timeout(timeout, connect=10.0),
    )
    resp.raise_for_status()
    return resp.json()
