-- OpenCMO — RPC cho worker (service role).
--
-- Dùng lại NGUYÊN mẫu vòng đời của `20260913120000_worker_lifecycle.sql` cho
-- bảng `tasks`: claim sinh `attempt_id` mới + lease, heartbeat gia hạn, chỉ
-- attempt hiện hành được chốt, lease hết hạn thì reconciler nhặt lại. Lý do
-- giữ nguyên mẫu thay vì nghĩ mẫu mới: worker chết giữa chừng là chuyện xảy ra
-- thật (Modal spawn hỏng, 504 của Supabase), và mẫu này đã chịu được nó một lần.
--
-- Mọi hàm ở đây chỉ `service_role` gọi được. Cuối file revoke khỏi
-- `public, anon, authenticated` rồi grant đúng một vai — người dùng đăng nhập
-- mà gọi được `complete_task` thì tự chốt được task của chính mình.

-- ------------------------------------------------------------------ claim

create or replace function public.claim_next_task(
  p_kinds text[],
  p_lease_seconds int default 120
)
returns setof public.tasks
language sql
volatile
security definer
set search_path = public
as $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = (
    select id from public.tasks
    where status = 'queued' and kind = any(p_kinds)
    order by created_at
    -- `skip locked` là mấu chốt: tám worker chạy song song không bao giờ nhận
    -- trùng một task, và không worker nào phải đợi worker khác.
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- Đường `submit`: web đánh thức worker và nói thẳng task nào cần chạy.
create or replace function public.claim_task(
  p_task_id uuid,
  p_lease_seconds int default 120
)
returns setof public.tasks
language sql
volatile
security definer
set search_path = public
as $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = p_task_id and status = 'queued'
  returning *;
$$;

create or replace function public.heartbeat_task(
  p_task_id uuid,
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
    update public.tasks
    set heartbeat_at = now(),
        lease_until = now() + make_interval(secs => p_lease_seconds)
    where id = p_task_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;

-- ------------------------------------------------------------------ chốt
--
-- Cả hai hàm dưới trả `false` khi attempt đã bị thay (lease hết hạn, reconciler
-- đã requeue, worker khác đã nhận): kết quả của attempt cũ về muộn thì BỎ, chứ
-- không ghi đè kết quả của attempt mới.
--
-- Gọi lại sau khi mất response vẫn trả `true` mà không ghi lần hai — nhánh
-- "đã chốt bởi chính attempt này" nhận ra lần gọi trước đã commit.

create or replace function public.complete_task(
  p_task_id uuid,
  p_attempt_id uuid,
  p_output jsonb default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.tasks
  set status = 'done',
      output = p_output,
      -- Các cột rút ra từ output để truy vấn được mà không phải mở jsonb: UI
      -- hiện kích thước file và độ phân giải ngay trên danh sách.
      output_path = coalesce(p_output ->> 'output_path', output_path),
      bytes = coalesce((p_output ->> 'bytes')::bigint, bytes),
      width = coalesce((p_output ->> 'width')::int, width),
      height = coalesce((p_output ->> 'height')::int, height),
      duration = coalesce((p_output ->> 'duration')::numeric, duration),
      error = null,
      finished_at = now(),
      lease_until = null
  where id = p_task_id and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if found then
    return true;
  end if;

  return exists (
    select 1 from public.tasks
    where id = p_task_id and status = 'done'
      and attempt_id is not distinct from p_attempt_id
  );
end;
$$;

-- `p_error` hiện THẲNG trên màn hình người dùng — worker phải truyền tiếng Anh.
create or replace function public.fail_task(
  p_task_id uuid,
  p_attempt_id uuid,
  p_error text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.tasks
  set status = 'failed',
      error = left(coalesce(p_error, 'Rendering failed. Please try again.'), 2000),
      finished_at = now(),
      lease_until = null
  where id = p_task_id and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if found then
    return true;
  end if;

  return exists (
    select 1 from public.tasks
    where id = p_task_id and status = 'failed'
      and attempt_id is not distinct from p_attempt_id
  );
end;
$$;

-- ------------------------------------------------------------ reconciler
--
-- Cron gọi mỗi phút, TRƯỚC khi claim. Điều kiện "vẫn là attempt đó và lease vẫn
-- hết hạn" nằm ngay trong UPDATE thay vì khoá hàng rồi mới sửa: hai reconciler
-- chạy chồng nhau thì một câu thắng, câu kia sửa 0 hàng, không ai đếm trùng.
create or replace function public.reclaim_expired_tasks(p_max_attempts int default 3)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r record;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, attempt, attempt_id
    from public.tasks
    where status = 'running' and attempt_id is not null and lease_until < now()
    order by lease_until
    limit 50
  loop
    if r.attempt < p_max_attempts then
      update public.tasks
      set status = 'queued', attempt_id = null, lease_until = null, heartbeat_at = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_requeued := v_requeued + 1;
      end if;
    else
      update public.tasks
      set status = 'failed',
          error = 'Rendering stopped unexpectedly. Please try again.',
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

-- ------------------------------------------------------- probe B-roll
--
-- Task và asset chốt trong MỘT giao dịch: một asset 'ready' mà task vẫn
-- 'running' sẽ khiến timeline nhận một đoạn video chưa ai đo được độ dài.
create or replace function public.complete_media_probe(
  p_asset_id uuid,
  p_attempt_id uuid,
  p_duration numeric,
  p_width int,
  p_height int,
  p_ok boolean,
  p_error text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.tasks
  set status = case when p_ok then 'done' else 'failed' end,
      duration = p_duration,
      width = p_width,
      height = p_height,
      error = case when p_ok then null
                   else left(coalesce(p_error, 'We could not read this media file.'), 2000) end,
      finished_at = now(),
      lease_until = null
  where kind = 'probe_media' and asset_id = p_asset_id
    and status = 'running' and attempt_id is not distinct from p_attempt_id;

  if not found then
    return false;
  end if;

  update public.media_assets
  set status = case when p_ok then 'ready' else 'rejected' end,
      duration = p_duration,
      width = p_width,
      height = p_height,
      error = case when p_ok then null
                   else left(coalesce(p_error, 'We could not read this media file.'), 500) end
  where id = p_asset_id;

  return true;
end;
$$;

-- --------------------------------------------------------------- artifact
--
-- Version kế tiếp thay vì ghi đè: chạy lại một project không được xoá mất
-- transcript mà revision của người dùng đang trỏ mốc thời gian vào.
create or replace function public.put_artifact(
  p_job_id uuid,
  p_kind text,
  p_data jsonb
)
returns public.artifacts
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_artifact public.artifacts;
begin
  -- Khoá hàng job để hai attempt ghi cùng lúc không cùng tính ra một số version.
  perform 1 from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'No such job: %', p_job_id using errcode = 'P0002';
  end if;

  insert into public.artifacts (job_id, kind, version, data)
  select p_job_id, p_kind, coalesce(max(version), 0) + 1, p_data
  from public.artifacts
  where job_id = p_job_id and kind = p_kind
  returning * into v_artifact;

  return v_artifact;
end;
$$;

-- ---------------------------------------------------- revision #1 + draft
--
-- KHÁC PLAN ở chữ ký: plan viết `create_clip_drafts(p_job_id)`, bản này nhận
-- thêm `p_revisions`. Lý do: `settings_hash` là sha256 trên JSON chuẩn hoá theo
-- RFC 8785, và cả plan lẫn Phase 5 đều chốt rằng hash chỉ sinh ở Python/
-- TypeScript — SQL chỉ kiểm hình dạng. Tự tính hash trong SQL là dựng bản cài
-- đặt THỨ BA của cùng một hàm băm, tức đúng thứ mà Phase 5 sinh ra để tránh.
-- Worker gửi kèm settings + hash do `models.py` tính ra.
--
-- `p_revisions`: [{"clip_id": uuid, "settings": {...}, "settings_hash": "..."}]
-- Clip đã có draft thì bỏ qua — chạy lại job không được reset bản người dùng sửa.
create or replace function public.create_clip_drafts(
  p_job_id uuid,
  p_revisions jsonb
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_created int;
begin
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be an array.' using errcode = '22023';
  end if;

  with wanted as (
    select (item ->> 'clip_id')::uuid as clip_id,
           item -> 'settings' as settings,
           item ->> 'settings_hash' as settings_hash
    from jsonb_array_elements(p_revisions) as item
  ),
  fresh as (
    select w.*
    from wanted w
    join public.clips c on c.id = w.clip_id and c.job_id = p_job_id
    left join public.clip_drafts d on d.clip_id = w.clip_id
    where d.clip_id is null
  ),
  made as (
    insert into public.clip_revisions (clip_id, number, settings, settings_hash)
    select clip_id, 1, settings, settings_hash from fresh
    returning id, clip_id
  )
  insert into public.clip_drafts (clip_id, revision_id)
  select clip_id, id from made;

  get diagnostics v_created = row_count;
  return v_created;
end;
$$;

-- ------------------------------------------------------- nguồn upload
--
-- Sửa so với `20260913120000_worker_lifecycle.sql`: giữ thêm nguồn của job
-- **done chưa hết hạn**. Trước đây worker xoá nguồn ngay khi job xong vì không
-- ai cần nó nữa — nhưng editor thì cần: render lại một clip sau khi người dùng
-- trim hay đổi caption phải đọc lại chính file nguồn đó. Cron dọn rác không
-- được xoá chúng cho tới khi job hết hạn lưu trữ.
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
      or (j.status in ('failed', 'done') and j.expires_at > now())
    );
$$;

-- ----------------------------------------------------------------- quyền
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.claim_next_task(text[], int)',
    'public.claim_task(uuid, int)',
    'public.heartbeat_task(uuid, uuid, int)',
    'public.complete_task(uuid, uuid, jsonb)',
    'public.fail_task(uuid, uuid, text)',
    'public.reclaim_expired_tasks(int)',
    'public.complete_media_probe(uuid, uuid, numeric, int, int, boolean, text)',
    'public.put_artifact(uuid, text, jsonb)',
    'public.create_clip_drafts(uuid, jsonb)',
    'public.live_source_paths()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
