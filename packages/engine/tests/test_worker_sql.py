"""Kiểm RPC vòng đời worker trên Postgres thật của Supabase local.

Chạy khi có container `supabase_db_opencmo` đã áp migration
`20260913120000_worker_lifecycle.sql`:

    supabase db start && supabase migration up --local

Không có container thì cả file skip — CI chưa dựng database. Mọi dữ liệu tạo
dưới một user tạm và xoá theo cascade khi test xong. KHÔNG trỏ vào production.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid

import pytest

CONTAINER = "supabase_db_opencmo"
# Đường thoát cho máy không chạy được Docker: trỏ vào một Postgres đã áp đủ
# migration thì test chạy y hệt, chỉ khác cách gọi psql. Cùng cơ chế với
# `test_web_sql_concurrency.py`.
DATABASE_URL = os.environ.get("OPENCMO_TEST_DATABASE_URL", "")


def _psql(query: str) -> subprocess.CompletedProcess:
    if DATABASE_URL:
        command = ["psql", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atq"]
    else:
        command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres",
                   "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]
    return subprocess.run(
        command, input=query, capture_output=True, text=True, timeout=60, check=False,
    )


def _available() -> bool:
    if not DATABASE_URL and not shutil.which("docker"):
        return False
    try:
        r = _psql("select to_regproc('public.finalize_job_failure') is not null;")
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and r.stdout.strip() == "t"


pytestmark = pytest.mark.skipif(
    not _available(), reason="cần Supabase local đã áp migration worker lifecycle"
)


def sql(query: str) -> str:
    r = _psql(query)
    if r.returncode:
        raise AssertionError(r.stderr)
    lines = r.stdout.strip().splitlines()
    return lines[-1] if lines else ""


@pytest.fixture
def user():
    uid = str(uuid.uuid4())
    # Trigger `handle_new_user` chỉ tạo profile. Quà đăng ký 30 credit đã bị bỏ
    # (`20260921150000_hard_paywall.sql`), nên số dư phải nạp tường minh ở đây —
    # các ca dưới đo chuyện trừ/hoàn credit, không đo chuyện tặng.
    sql(f"insert into auth.users (id, email) values ('{uid}', '{uid}@test.local');")
    sql(
        "insert into public.credit_ledger (user_id, delta, reason) "
        f"values ('{uid}', 30, 'Test top-up');"
    )
    yield uid
    sql(f"delete from auth.users where id = '{uid}';")


def new_job(uid: str, source: str = "https://youtu.be/x") -> str:
    return sql(f"""
        with j as (
          insert into public.jobs (user_id, source_url, clips_requested)
          values ('{uid}', '{source}', 3) returning id
        ), hold as (
          insert into public.credit_ledger (user_id, delta, reason, job_id)
          select '{uid}', -10, 'Hold for new job', id from j
        )
        select id from j;
    """)


def balance(uid: str) -> int:
    return int(sql(f"select public.credit_balance('{uid}');"))


def claim(job: str) -> str:
    return sql(f"select attempt_id from public.claim_job_attempt('{job}');")


def settle(job: str, seconds: int, attempt: str) -> str:
    return sql(
        f"select public.settle_job_credits('{job}', {seconds}, 'settle:{attempt}', '{attempt}');"
    )


def expire(job: str) -> None:
    sql(f"update public.jobs set lease_until = now() - interval '1 second' where id = '{job}';")


def job_row(job: str) -> dict:
    return json.loads(sql(f"select row_to_json(j) from public.jobs j where id = '{job}';"))


def test_duplicate_submit_claims_once(user):
    job = new_job(user)
    assert claim(job)
    assert claim(job) == ""
    assert job_row(job)["attempt"] == 1


def test_settle_replay_after_lost_response_does_not_double_charge(user):
    job = new_job(user)
    attempt = claim(job)
    # 20 phút: giữ 10, trừ thêm 10.
    assert settle(job, 1200, attempt) == "t"
    assert settle(job, 1200, attempt) == "t"
    assert balance(user) == 10


def test_parallel_settles_for_same_user_cannot_overspend(user):
    j1, j2 = new_job(user), new_job(user)  # số dư còn 10
    a1, a2 = claim(j1), claim(j2)

    # Giao dịch A giữ khoá ledger 1.5 giây. Không có khoá thì B đọc số dư cũ
    # (10), trừ thêm và số dư cuối âm.
    slow = threading.Thread(
        target=sql,
        args=(
            (
                f"begin; select public.settle_job_credits('{j1}', 1200, 'settle:{a1}', '{a1}');"
                " select pg_sleep(1.5); commit;"
            ),
        ),
    )
    slow.start()
    time.sleep(0.5)
    second = settle(j2, 1200, a2)
    slow.join()

    assert second == "f"
    assert balance(user) >= 0


def test_failure_and_refund_are_atomic_and_replayable(user):
    job = new_job(user)
    attempt = claim(job)
    settle(job, 1200, attempt)

    call = (f"select public.finalize_job_failure('{job}', '{attempt}',"
            f" 'RuntimeError: boom', 'fail:{attempt}');")
    first = json.loads(sql(call))
    replay = json.loads(sql(call))

    assert first == {"transitioned": True, "refunded": 20}
    assert replay == first
    assert balance(user) == 30
    assert job_row(job)["status"] == "failed"


def test_late_callback_from_replaced_attempt_cannot_finalize(user):
    job = new_job(user)
    old = claim(job)
    expire(job)
    assert json.loads(sql("select public.reclaim_expired_jobs();"))["requeued"] >= 1
    current = claim(job)

    assert settle(job, 60, old) == ""  # null: attempt cũ không đụng ledger
    assert sql(f"select public.complete_job('{job}', '{old}', 't', 60, '[]');") == "f"
    late_fail = json.loads(sql(
        f"select public.finalize_job_failure('{job}', '{old}', 'late', 'fail:{old}');"
    ))
    assert late_fail["transitioned"] is False
    assert job_row(job)["status"] == "running"

    clips = json.dumps([{"idx": 0, "hook": "h", "start_seconds": 1, "end_seconds": 20,
                         "score": 8, "reason": "r", "storage_path": "p", "preview_path": None}])
    done = f"select public.complete_job('{job}', '{current}', 'talk', 60, '{clips}');"
    assert sql(done) == "t"
    assert sql(done) == "t"  # replay sau khi mất response
    assert sql(f"select count(*) from public.clips where job_id = '{job}';") == "1"
    assert balance(user) == 20


def test_crash_after_claim_requeues_then_fails_once_after_max_attempts(user):
    job = new_job(user)
    for _ in range(2):
        claim(job)
        expire(job)
        sql("select public.reclaim_expired_jobs();")
        assert job_row(job)["status"] == "queued"

    claim(job)
    expire(job)
    sql("select public.reclaim_expired_jobs();")
    sql("select public.reclaim_expired_jobs();")

    row = job_row(job)
    assert (row["status"], row["attempt"]) == ("failed", 3)
    assert balance(user) == 30


def test_heartbeat_extends_only_current_attempt(user):
    job = new_job(user)
    attempt = claim(job)
    assert sql(f"select public.heartbeat_job('{job}', '{attempt}');") == "t"
    assert sql(f"select public.heartbeat_job('{job}', '{uuid.uuid4()}');") == "f"


def test_failed_upload_source_stays_live_within_retention(user):
    path = f"{user}/talk__abc.mp4"
    job = new_job(user, source=f"storage://{path}")
    attempt = claim(job)
    sql(f"select public.finalize_job_failure('{job}', '{attempt}', 'boom', 'fail:{attempt}');")
    assert path in sql("select string_agg(path, ',') from public.live_source_paths();").split(",")


# Mọi RPC mà chỉ worker được gọi. Kiểm cả danh sách chứ không chỉ `refund_job`:
# thiếu một revoke ở đây là người dùng tự hoàn tiền được cho job của chính mình.
WORKER_ONLY_RPCS = (
    "public.refund_job(uuid, text)",
    "public.claim_next_job()",
    "public.claim_job_attempt(uuid, int)",
    "public.claim_next_job_attempt(int)",
    "public.heartbeat_job(uuid, uuid, int)",
    "public.complete_job(uuid, uuid, text, numeric, jsonb)",
    "public.finalize_job_failure(uuid, uuid, text, text)",
    "public.settle_job_credits(uuid, numeric, text, uuid)",
    "public.reclaim_expired_jobs(int)",
    "public.lock_credit_owner(uuid)",
    "public.job_credits_spent(uuid)",
    "public.expired_clip_paths()",
)


def test_worker_rpcs_are_not_callable_by_signed_in_users(user):
    """Kiểm bằng CATALOG, không gọi hàm thật.

    Bản cũ chạy `set role authenticated; select public.refund_job(...)` rồi chờ
    "permission denied". Trên Postgres 17 của Supabase, đúng lời gọi đó làm
    SEGFAULT backend — không phải lỗi của pgTAP, vì đây là psql trần:

        LOG: server process was terminated by signal 11: Segmentation fault

    Cả database vào recovery, mọi test sau đó mất kết nối. Xem note.md 15/09.
    `has_function_privilege` kiểm đúng cùng một tính chất — vai không có EXECUTE,
    và đó chính là lý do lời gọi bị từ chối — mà không phải gọi hàm.
    """
    job = new_job(user)
    checks = ",".join(f"'{fn}'" for fn in WORKER_ONLY_RPCS)
    for role in ("authenticated", "anon"):
        granted = sql(
            f"select string_agg(f, ',') from unnest(array[{checks}]) f"
            f" where has_function_privilege('{role}', f, 'execute');"
        )
        assert granted == "", f"{role} vẫn gọi được: {granted}"
    assert balance(user) == 20
    assert job
