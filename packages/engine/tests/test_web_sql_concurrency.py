"""Kiểm RPC của editor web dưới tranh chấp THẬT, nhiều kết nối cùng lúc.

pgTAP chạy trong MỘT phiên nên nó không chứng minh được `for update skip locked`
hay khoá hàng draft: trong một phiên thì không có gì để tranh. File này mở nhiều
kết nối song song, giống `test_worker_sql.py`.

Chạy khi có Supabase local đã áp migration:

    supabase start && supabase migration up --local

Không có container thì cả file skip — CI chưa dựng database. Mọi dữ liệu tạo
dưới một user tạm và xoá theo cascade khi test xong. KHÔNG trỏ vào production.

`OPENCMO_TEST_DATABASE_URL` là đường thoát cho máy không chạy được Docker: trỏ
vào một Postgres đã áp đủ migration thì test chạy y hệt, chỉ khác cách gọi psql.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

CONTAINER = "supabase_db_opencmo"
DATABASE_URL = os.environ.get("OPENCMO_TEST_DATABASE_URL", "")


def _psql(query: str) -> subprocess.CompletedProcess:
    if DATABASE_URL:
        command = ["psql", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atq"]
    else:
        command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres",
                   "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]
    return subprocess.run(
        command, input=query, capture_output=True, text=True, timeout=60, check=False
    )


def _available() -> bool:
    if not DATABASE_URL and not shutil.which("docker"):
        return False
    try:
        r = _psql("select to_regproc('public.claim_next_task') is not null;")
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and r.stdout.strip() == "t"


pytestmark = pytest.mark.skipif(
    not _available(), reason="cần Supabase local đã áp migration web_rpc_worker"
)


def sql(query: str) -> str:
    r = _psql(query)
    if r.returncode:
        raise AssertionError(r.stderr)
    lines = r.stdout.strip().splitlines()
    return lines[-1] if lines else ""


def try_sql(query: str) -> tuple[bool, str]:
    """Như `sql` nhưng trả cả lỗi — dùng cho ca "một bên phải thua"."""
    r = _psql(query)
    return (r.returncode == 0, (r.stdout if r.returncode == 0 else r.stderr).strip())


def as_user(user: str, query: str) -> str:
    """Chạy một câu dưới đúng vai mà PostgREST dùng: `authenticated` + JWT giả."""
    claims = json.dumps({"sub": user})
    return (
        "begin; set local role authenticated;"
        f" set local request.jwt.claims = '{claims}';"
        f" {query} commit;"
    )


@pytest.fixture
def user():
    uid = str(uuid.uuid4())
    sql(f"insert into auth.users (id, email) values ('{uid}', '{uid}@test.local');")
    yield uid
    sql(f"delete from auth.users where id = '{uid}';")


@pytest.fixture
def clip(user):
    """Một project done với một clip đã có settings gốc và một editor revision."""
    job = str(uuid.uuid4())
    clip_id = str(uuid.uuid4())
    editor_revision = str(uuid.uuid4())
    sql(f"""
        insert into public.jobs (id, user_id, source_url, duration_seconds, status)
        values ('{job}', '{user}', 'https://youtu.be/x', 600, 'done');
        insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end,
                                  settings, settings_hash)
        values ('{clip_id}', '{job}', 0, 1, 20, 1, 20, '{{"source_start": 1, "source_end": 20}}', '{"a" * 64}');
        insert into public.editor_projects (clip_id, document) values ('{clip_id}', '{{"version":1}}');
        insert into public.editor_revisions (id, clip_id, number, source_hash, document)
        values ('{editor_revision}', '{clip_id}', 1, '{"b" * 64}', '{{"version":1}}');
    """)
    return {"user": user, "job": job, "clip": clip_id, "editor_revision": editor_revision}


def test_parallel_claims_never_hand_out_the_same_task_twice(user):
    """20 task, 8 luồng claim cùng lúc: mỗi task đúng một lần.

    Đây là ca mà `for update skip locked` tồn tại để giải. Thiếu nó thì hai
    worker cùng nhận một task và người dùng trả tiền render hai lần cho một clip.
    """
    job = str(uuid.uuid4())
    sql(f"""
        insert into public.jobs (id, user_id, source_url, status)
        values ('{job}', '{user}', 'https://youtu.be/x', 'done');
        insert into public.tasks (user_id, kind, job_id, request_id)
        select '{user}', 'zip', '{job}', gen_random_uuid() from generate_series(1, 20);
    """)

    def claim_all() -> list[str]:
        taken = []
        while True:
            got = sql("select id from public.claim_next_task(array['zip']);")
            if not got:
                return taken
            taken.append(got)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [f.result() for f in [pool.submit(claim_all) for _ in range(8)]]

    claimed = [task for batch in results for task in batch]
    assert len(claimed) == 20, f"claim được {len(claimed)} task, chờ 20"
    assert len(set(claimed)) == 20, "một task bị claim nhiều lần"
    assert sql(f"select count(*) from public.tasks where job_id = '{job}' and status = 'running';") == "20"


def test_same_request_id_in_parallel_creates_one_export(clip):
    """Bấm Export hai lần trong cùng một khoảnh khắc: đúng một task."""
    request = str(uuid.uuid4())
    call = as_user(clip["user"], (
        f"select id from public.request_document_export('{clip['clip']}', '{clip['editor_revision']}', '{request}', 720);"
    ))

    barrier = threading.Barrier(4)
    results: list[tuple[bool, str]] = []
    lock = threading.Lock()

    def run() -> None:
        barrier.wait()
        result = try_sql(call)
        with lock:
            results.append(result)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert any(ok for ok, _ in results), f"không lượt nào thành công: {results}"
    assert sql(
        f"select count(*) from public.tasks where clip_id = '{clip['clip']}' and kind = 'render_document';"
    ) == "1"


def test_late_result_from_reclaimed_attempt_is_dropped(clip):
    """Attempt bị reclaim rồi mới trả kết quả: bỏ, giữ kết quả của attempt mới.

    Worker chết sau khi render xong nhưng trước khi báo cáo là ca có thật; nếu
    kết quả muộn đó ghi đè được thì người dùng tải về file của lần chạy đã hỏng.
    """
    request = str(uuid.uuid4())
    task = sql(f"""
        insert into public.tasks (user_id, kind, clip_id, editor_revision_id, request_id)
        values ('{clip['user']}', 'render_document', '{clip['clip']}', '{clip['editor_revision']}', '{request}')
        returning id;
    """)

    stale = sql(f"select attempt_id from public.claim_task('{task}');")
    sql(f"update public.tasks set lease_until = now() - interval '1 minute' where id = '{task}';")
    assert json.loads(sql("select public.reclaim_expired_tasks();"))["requeued"] >= 1

    current = sql(f"select attempt_id from public.claim_task('{task}');")
    assert current != stale

    late = sql(
        f"""select public.complete_task('{task}', '{stale}',
            '{{"output_path": "renders/cu.mp4"}}'::jsonb);"""
    )
    assert late == "f", "attempt cũ không được chốt task"

    assert sql(f"select status from public.tasks where id = '{task}';") == "running"
    assert sql(f"select output_path from public.tasks where id = '{task}';") == ""

    assert sql(
        f"""select public.complete_task('{task}', '{current}',
            '{{"output_path": "renders/moi.mp4"}}'::jsonb);"""
    ) == "t"
    assert sql(f"select output_path from public.tasks where id = '{task}';") == "renders/moi.mp4"


def test_global_request_race_does_not_return_another_users_task(clip):
    """Giữ insert chưa commit để bắt đúng nhánh xung đột request_id toàn cục."""
    other = str(uuid.uuid4())
    request = str(uuid.uuid4())
    task = str(uuid.uuid4())
    marker = str(uuid.uuid4())
    sql(f"insert into auth.users(id,email) values ('{other}', '{other}@test.local');")
    ready = threading.Event()

    def hold_collision():
        # pg_stat_activity thấy marker khi transaction đang ngủ sau INSERT.
        return try_sql(f"""
            begin;
            insert into public.tasks(id,user_id,kind,request_id)
            values ('{task}', '{other}', 'zip', '{request}');
            select pg_sleep(2) /* {marker} */;
            commit;
        """)

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(hold_collision)
            for _ in range(100):
                if sql(f"select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and query like '%{marker}%' and wait_event='PgSleep');") == "t":
                    ready.set()
                    break
            assert ready.is_set(), "không quan sát được transaction giữ request"
            call = (
                f"select id from public.request_document_export("
                f"'{clip['clip']}', '{clip['editor_revision']}', '{request}', 720);"
            )
            ok, output = try_sql(as_user(clip["user"], call))
            assert pending.result()[0]
        assert not ok, output
        assert "already used" in output
        assert task not in output
    finally:
        sql(f"delete from auth.users where id='{other}';")


def test_parallel_media_registration_keeps_fifty_file_cap(clip):
    """Nhiều upload tranh vị trí 50: đúng một thắng; retry vẫn thành công."""
    user, job = clip["user"], clip["job"]
    sql(f"""
        insert into public.media_assets(user_id, job_id, storage_path, name)
        select '{user}', '{job}', 'media/{user}/{job}/' || gen_random_uuid() || '.mp4', 'Video'
        from generate_series(1,49);
    """)
    barrier = threading.Barrier(6)

    def register():
        # Bốn tham số từ D3: bản ba tham số đã thu quyền của `authenticated`, và
        # trên PG17 của Supabase, gọi một hàm không có EXECUTE làm SẬP backend
        # (note.md 15/09) — không phải chỉ nhận một lỗi quyền.
        path = f"media/{user}/{job}/{uuid.uuid4()}.mp4"
        object_name = path.removeprefix("media/")
        sql(f"""
            insert into public.upload_reservations
              (user_id,bucket,object_name,declared_size,content_type,project_id)
            values ('{user}','media','{object_name}',100,'video/mp4','{job}');
            insert into storage.objects(bucket_id,name,metadata)
            values ('media','{object_name}','{{"size":100,"mimetype":"video/mp4"}}');
        """)
        barrier.wait()
        call = (
            f"select public.register_media_asset('{job}', '{path}', 'Video',"
            f" gen_random_uuid()) -> 'asset' ->> 'id';"
        )
        return try_sql(as_user(user, call))

    with ThreadPoolExecutor(max_workers=6) as pool:
        outcomes = list(pool.map(lambda _: register(), range(6)))
    assert sum(ok for ok, _ in outcomes) == 1, outcomes
    assert sql(f"select count(*) from public.media_assets where job_id='{job}';") == "50"
    path = sql(f"select storage_path from public.media_assets where job_id='{job}' limit 1;")
    retry = (
        f"select public.register_media_asset('{job}', '{path}', 'Retry',"
        f" gen_random_uuid()) -> 'asset' ->> 'id';"
    )
    assert try_sql(as_user(user, retry))[0]


