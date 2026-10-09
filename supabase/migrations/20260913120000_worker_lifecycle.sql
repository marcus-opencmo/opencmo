-- OpenCMO — vòng đời worker phục hồi được và credit idempotent.
--
-- Bối cảnh 13/09/2026: Supabase trả 504 cho `claim_next_job` (cron, hàng đợi
-- rỗng) và cho `settle_job_credits` (job 095ba0e4…). Worker cũ không retry, và
-- cũng KHÔNG ĐƯỢC retry mù: các RPC cũ không phân biệt "request chưa chạy" với
-- "đã commit nhưng mất response". File này làm cho retry trở nên an toàn:
--
-- 1. Operation key: mỗi thao tác ghi credit/chốt job mang một khoá do worker
--    đặt; kết quả lưu ở `worker_operations`, gọi lại cùng khoá trả đúng kết quả
--    cũ mà không ghi thêm dòng nào.
-- 2. Khoá ledger theo người dùng: settle/refund/finalize khoá hàng `profiles`
--    giống `create_job()`, nên hai thao tác cùng user luôn tuần tự — đọc tổng
--    rồi insert không còn cửa sổ tranh chấp.
-- 3. Attempt + lease: mỗi lần claim sinh `attempt_id` mới và lease 120 giây,
--    worker heartbeat mỗi 30 giây. Chỉ attempt hiện hành được chốt job. Worker
--    chết hoặc spawn hỏng thì lease hết hạn và `reclaim_expired_jobs()` trả job
--    về hàng đợi, tối đa 3 attempt rồi chốt failed + hoàn tiền.
--
-- TƯƠNG THÍCH NGƯỢC: worker v4 đang deploy vẫn gọi `claim_next_job()`, PATCH
-- `jobs`, `settle_job_credits(p_job_id, p_duration_seconds)` và `refund_job()`.
-- Tất cả vẫn chạy. Job claim theo đường cũ có `attempt_id` null nên reconciler
-- không đụng tới — không có chuyện requeue một job mà worker cũ đang chạy.

-- ------------------------------------------------------------------- jobs

alter table public.jobs
  add column if not exists attempt int not null default 0,
  add column if not exists attempt_id uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists call_id text;

create index if not exists jobs_lease_idx
  on public.jobs (lease_until)
  where status = 'running' and attempt_id is not null;

-- ------------------------------------------------------ worker_operations

-- Chỉ service role đọc/ghi (RLS bật, không policy). Xoá theo job.
create table if not exists public.worker_operations (
  operation_key text primary key,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  kind          text not null,
  result        jsonb not null,
  created_at    timestamptz not null default now()
);

alter table public.worker_operations enable row level security;

-- Cùng thứ tự khoá với `create_job()`: hàng profiles trước, hàng jobs sau.
-- Lệch thứ tự ở một hàm là mở đường cho deadlock giữa hai giao dịch.
create or replace function public.lock_credit_owner(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform 1 from public.profiles where id = p_user_id for update;
end;
$$;

-- ------------------------------------------------------------------ claim

create or replace function public.claim_job_attempt(
  p_job_id uuid,
  p_lease_seconds int default 120
)
returns setof public.jobs
language sql
volatile
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      call_id = null
  where id = p_job_id and status = 'queued'
  returning *;
$$;

-- Không idempotent: timeout ở đây có thể đã claim một job. Worker không retry
-- mà để lease hết hạn đưa job đó về hàng đợi.
create or replace function public.claim_next_job_attempt(p_lease_seconds int default 120)
returns setof public.jobs
language sql
volatile
security definer
set search_path = public
as $$
  update public.jobs
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      call_id = null
  where id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;

create or replace function public.heartbeat_job(
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_seconds int default 120
)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  with touched as (
    update public.jobs
    set heartbeat_at = now(),
        lease_until = now() + make_interval(secs => p_lease_seconds)
    where id = p_job_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;

-- --------------------------------------------------------------- credit

-- Đổi chữ ký: phải DROP bản cũ. `create or replace` với tham số khác tạo ra
-- một overload, và PostgREST báo lỗi mơ hồ khi gọi bằng hai tham số.
drop function if exists public.settle_job_credits(uuid, numeric);

-- Trả về: true = chạy tiếp; false = không đủ credit (phần giữ đã hoàn);
-- null = attempt không còn hiện hành hoặc job không còn running — không đụng
-- ledger. Gọi lại cùng `p_operation_key` trả đúng kết quả lần đầu.
create or replace function public.settle_job_credits(
  p_job_id uuid,
  p_duration_seconds numeric,
  p_operation_key text default null,
  p_attempt_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_status public.job_status;
  v_attempt uuid;
  v_prev jsonb;
  v_ok boolean;
  v_spent int;
  v_actual int;
  v_diff int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    raise exception 'No such job: %', p_job_id;
  end if;

  perform public.lock_credit_owner(v_user);

  if p_operation_key is not null then
    select result into v_prev
    from public.worker_operations where operation_key = p_operation_key;
    if found then
      return (v_prev->>'ok')::boolean;
    end if;
  end if;

  select status, attempt_id into v_status, v_attempt
  from public.jobs where id = p_job_id;

  if v_status <> 'running'
     or (p_attempt_id is not null and v_attempt is distinct from p_attempt_id) then
    v_ok := null;
  else
    -- 1 credit = 1 phút nguồn, làm tròn lên. Video 30 giây vẫn tính 1 phút.
    v_actual := greatest(1, ceil(coalesce(p_duration_seconds, 0) / 60.0)::int);
    v_spent := public.job_credits_spent(p_job_id);
    v_diff := v_actual - v_spent;
    v_ok := true;

    if v_diff > 0 and public.credit_balance(v_user) < v_diff then
      if v_spent > 0 then
        insert into public.credit_ledger (user_id, delta, reason, job_id)
        values (v_user, v_spent, 'Refund: not enough credits for the real length', p_job_id);
      end if;
      v_ok := false;
    elsif v_diff <> 0 then
      insert into public.credit_ledger (user_id, delta, reason, job_id)
      values (v_user, -v_diff, 'Adjusted to real video length', p_job_id);
    end if;
  end if;

  if p_operation_key is not null then
    insert into public.worker_operations (operation_key, job_id, kind, result)
    values (p_operation_key, p_job_id, 'settle', jsonb_build_object('ok', v_ok));
  end if;

  return v_ok;
end;
$$;

-- Giữ chữ ký cũ cho worker v4; thêm khoá ledger để không tranh với settle.
create or replace function public.refund_job(p_job_id uuid, p_reason text default 'Refund: job failed')
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_spent int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return 0;
  end if;

  perform public.lock_credit_owner(v_user);

  v_spent := public.job_credits_spent(p_job_id);
  if v_spent <= 0 then
    return 0;
  end if;

  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, v_spent, p_reason, p_job_id);

  return v_spent;
end;
$$;

-- ----------------------------------------------------------------- chốt job

-- Failed + hoàn tiền trong MỘT giao dịch. Bản cũ tách hai request: mất mạng
-- giữa chừng là job failed mà người dùng không được hoàn.
-- `p_error` hiện thẳng trên trang kết quả — worker phải truyền tiếng Anh.
create or replace function public.finalize_job_failure(
  p_job_id uuid,
  p_attempt_id uuid,
  p_error text,
  p_operation_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_prev jsonb;
  v_rows int;
  v_refund int := 0;
  v_result jsonb;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return jsonb_build_object('transitioned', false, 'refunded', 0);
  end if;

  perform public.lock_credit_owner(v_user);

  select result into v_prev
  from public.worker_operations where operation_key = p_operation_key;
  if found then
    return v_prev;
  end if;

  update public.jobs
  set status = 'failed',
      error = left(p_error, 2000),
      finished_at = now(),
      lease_until = null
  where id = p_job_id
    and status = 'running'
    and attempt_id is not distinct from p_attempt_id;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    v_refund := greatest(public.job_credits_spent(p_job_id), 0);
    if v_refund > 0 then
      insert into public.credit_ledger (user_id, delta, reason, job_id)
      values (v_user, v_refund, 'Refund: job failed', p_job_id);
    end if;
  end if;

  v_result := jsonb_build_object('transitioned', v_rows > 0, 'refunded', v_refund);

  insert into public.worker_operations (operation_key, job_id, kind, result)
  values (p_operation_key, p_job_id, 'fail', v_result);

  return v_result;
end;
$$;

-- Done + clip trong một giao dịch, chỉ cho attempt hiện hành. Gọi lại sau khi
-- mất response vẫn trả true mà không chèn clip lần hai: nhánh "đã done bởi
-- chính attempt này" nhận ra lần gọi trước đã commit.
create or replace function public.complete_job(
  p_job_id uuid,
  p_attempt_id uuid,
  p_title text,
  p_duration_seconds numeric,
  p_clips jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.jobs
  set status = 'done',
      title = p_title,
      duration_seconds = p_duration_seconds,
      finished_at = now(),
      lease_until = null
  where id = p_job_id
    and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if not found then
    return exists (
      select 1 from public.jobs
      where id = p_job_id
        and status = 'done'
        and attempt_id is not distinct from p_attempt_id
    );
  end if;

  insert into public.clips (
    job_id, idx, hook, start_seconds, end_seconds, score, reason, storage_path, preview_path
  )
  select p_job_id, c.idx, c.hook, c.start_seconds, c.end_seconds, c.score, c.reason,
         c.storage_path, c.preview_path
  from jsonb_populate_recordset(null::public.clips, coalesce(p_clips, '[]'::jsonb)) c
  on conflict (job_id, idx) do update
  set hook = excluded.hook,
      start_seconds = excluded.start_seconds,
      end_seconds = excluded.end_seconds,
      score = excluded.score,
      reason = excluded.reason,
      storage_path = excluded.storage_path,
      preview_path = excluded.preview_path;

  return true;
end;
$$;

-- ------------------------------------------------------------ reconciler

-- Sweep gọi mỗi phút, TRƯỚC khi claim. Không khoá hàng jobs trong vòng lặp:
-- nhánh failed phải khoá profiles trước (thứ tự của `lock_credit_owner`), nên
-- điều kiện "vẫn là attempt đó và lease vẫn hết hạn" nằm ngay trong UPDATE.
create or replace function public.reclaim_expired_jobs(p_max_attempts int default 3)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r record;
  v_refund int;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, user_id, attempt, attempt_id
    from public.jobs
    where status = 'running' and attempt_id is not null and lease_until < now()
    order by lease_until
    limit 50
  loop
    if r.attempt < p_max_attempts then
      update public.jobs
      set status = 'queued', attempt_id = null, lease_until = null,
          heartbeat_at = null, call_id = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_requeued := v_requeued + 1;
      end if;
    else
      perform public.lock_credit_owner(r.user_id);

      update public.jobs
      set status = 'failed',
          error = 'Processing was interrupted too many times.',
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();

      if found then
        v_refund := public.job_credits_spent(r.id);
        if v_refund > 0 then
          insert into public.credit_ledger (user_id, delta, reason, job_id)
          values (r.user_id, v_refund, 'Refund: job failed', r.id);
        end if;
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

-- ------------------------------------------------------- nguồn upload

-- Job failed giữ nguồn tới hết hạn lưu trữ để còn thử lại; worker chỉ xoá nguồn
-- khi job done. Cron dọn rác không được xoá những file này.
create or replace function public.live_source_paths()
returns table (path text)
language sql
stable
security definer
set search_path = public
as $$
  select substring(j.source_url from 11)
  from public.jobs j
  where j.source_url like 'storage://%'
    and (
      j.status in ('queued', 'running')
      or (j.status = 'failed' and j.expires_at > now())
    );
$$;

-- ---------------------------------------------------------------- quyền

-- `create function` cấp execute cho `public`, tức mọi người dùng đã đăng nhập
-- (và cả anon) gọi được các RPC `security definer` này qua PostgREST. Trước
-- migration này một người dùng có thể tự gọi `refund_job` cho job đang chạy
-- của mình để lấy lại phần giữ tạm. Chỉ worker và cron (service role) cần chúng.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.claim_next_job()',
    'public.claim_job_attempt(uuid, int)',
    'public.claim_next_job_attempt(int)',
    'public.heartbeat_job(uuid, uuid, int)',
    'public.reclaim_expired_jobs(int)',
    'public.settle_job_credits(uuid, numeric, text, uuid)',
    'public.refund_job(uuid, text)',
    'public.finalize_job_failure(uuid, uuid, text, text)',
    'public.complete_job(uuid, uuid, text, numeric, jsonb)',
    'public.lock_credit_owner(uuid)',
    'public.job_credits_spent(uuid)',
    'public.expired_clip_paths()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
