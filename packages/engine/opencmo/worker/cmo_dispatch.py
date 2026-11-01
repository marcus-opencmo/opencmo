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

    Counted in SQL by `cmo_dispatch_count`, next to `claim_cmo_run`, so the two rules cannot drift: the REST filter
    below missed the pause filter, and the sweep sent calls every minute that claimed nothing (review R6). A database
    without the function (before its migration) falls back to that filter.
    """
    own = client is None
    http = client or httpx.Client(timeout=_CALL_TIMEOUT)
    try:
        resp = http.post(
            f"{supabase_url.rstrip('/')}/rest/v1/rpc/cmo_dispatch_count",
            json={"p_limit": limit},
            headers={"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"},
        )
        if resp.status_code != 404:
            resp.raise_for_status()
            return int(resp.json() or 0)
    finally:
        if own:
            http.close()
    return _count_dispatchable_rest(supabase_url, service_role_key, limit=limit, client=client)


def _count_dispatchable_rest(
    supabase_url: str, service_role_key: str, *, limit: int, client: httpx.Client | None = None
) -> int:
    """The older count, for a database without `cmo_dispatch_count`: queued and past `not_before`, or running with an
    expired lease."""
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


def count_studio_work(supabase_url: str, service_role_key: str, *, client: httpx.Client | None = None) -> int:
    """Studio orders the same route would carry out now (`studio_work_count`, P2 A2).

    They are not `cmo_runs`: queued video and shorts orders, approved Studio steps, and steps whose generations
    finished. A database without the function (before its migration) counts nothing rather than failing the sweep.
    """
    own = client is None
    http = client or httpx.Client(timeout=_CALL_TIMEOUT)
    try:
        resp = http.post(
            f"{supabase_url.rstrip('/')}/rest/v1/rpc/studio_work_count",
            json={},
            headers={"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"},
        )
        if resp.status_code == 404:
            return 0
        resp.raise_for_status()
        return max(0, int(resp.json() or 0))
    finally:
        if own:
            http.close()


def claim_due_slots(supabase_url: str, service_role_key: str, *, client: httpx.Client | None = None) -> dict:
    """Fire the schedule slots whose time has come (`schedule_claim_due`, P4 A2).

    SQL does the work: past-window slots are missed, due ones become `publish_post` runs that `dispatch` then sends.
    Returns its counts. A database without the function (before its migration) claims nothing rather than failing
    the sweep.
    """
    own = client is None
    http = client or httpx.Client(timeout=_CALL_TIMEOUT)
    try:
        resp = http.post(
            f"{supabase_url.rstrip('/')}/rest/v1/rpc/schedule_claim_due",
            json={},
            headers={"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"},
        )
        if resp.status_code == 404:
            return {}
        resp.raise_for_status()
        body = resp.json()
        return body if isinstance(body, dict) else {}
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
