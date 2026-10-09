-- OpenCMO — RPC còn thiếu cho tầng API `/api/v1` (D3).
--
-- Bốn thứ D3 cần mà D1 chưa có, cộng một cột. Cùng quy ước với
-- `20260914092000_web_rpc_user.sql`: `security definer`, `set search_path`,
-- dòng đầu là `require_user()`, message tiếng Anh, cuối file revoke rồi grant.
--
-- Vì sao không sửa migration D1: nó đã merge và đã chạy ở máy khác. Migration
-- nối tiếp là cách duy nhất giữ `supabase migration list` khớp nhau.

-- ------------------------------------------------------- attempt_started_at
--
-- Trang "đang xử lý" đếm thời gian đã trôi của LẦN CHẠY HIỆN TẠI, không phải từ
-- lúc tạo job: job nằm trong hàng đợi 10 phút rồi mới chạy thì "đã 10 phút" là
-- một câu nói dối. `heartbeat_at` không thay được — nó nhích mỗi 15 giây nên
-- đồng hồ sẽ đứng yên ở 0.
alter table public.jobs add column if not exists attempt_started_at timestamptz;

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
      attempt_started_at = now(),
      call_id = null
  where id = p_job_id and status = 'queued'
  returning *;
$$;

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
      attempt_started_at = now(),
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

-- --------------------------------------------------------------- clip_length
--
-- Ô "Clip length" đã có sẵn trong UI của bản local (`CLIP_LENGTHS`), nhưng trên
-- web nó không có chỗ nào để sống: `jobs` chỉ lưu số clip. Thêm cột rồi cho
-- `create_job` nhận nó — không thì lựa chọn của người dùng biến mất giữa đường
-- và worker vẫn cắt theo mặc định, im lặng.
alter table public.jobs
  add column if not exists clip_length text not null default 'auto';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_clip_length_check') then
    alter table public.jobs
      add constraint jobs_clip_length_check
      check (clip_length in ('auto', 'short', 'medium', 'long'));
  end if;
end;
$$;

-- Bản hai tham số bị thay hẳn: giữ cả hai thì PostgREST gọi bằng tên tham số sẽ
-- nhập nhằng giữa `(text, int)` và `(text, int, text default)`.
drop function if exists public.create_job(text, int);

create or replace function public.create_job(
  p_source_url text,
  p_clips int default 5,
  p_length text default 'auto'
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_length text := coalesce(p_length, 'auto');
  v_job public.jobs;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  if p_source_url is null or length(trim(p_source_url)) = 0 then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;

  if p_clips < 1 or p_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;

  if v_length not in ('auto', 'short', 'medium', 'long') then
    raise exception 'Choose a clip length.' using errcode = '22023';
  end if;

  -- Khoá hàng của người dùng này để hai tab bấm cùng lúc không tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  select coalesce(sum(delta), 0)::int into v_balance
  from public.credit_ledger where user_id = v_user;

  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;

  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs (user_id, source_url, clips_requested, clip_length, watermark)
  values (v_user, trim(p_source_url), p_clips, v_length, coalesce(v_plan, 'free') = 'free')
  returning * into v_job;

  insert into public.credit_ledger (user_id, delta, reason, job_id)
  values (v_user, -v_hold, 'Hold for new job', v_job.id);

  return v_job;
end;
$$;

-- ---------------------------------------------------------------- retry_job
--
-- Chạy lại một project đã hỏng. Ba thứ phải nằm trong CÙNG một giao dịch, nếu
-- không thì có lúc job chạy mà chưa ai trả tiền (hoặc ngược lại): khoá người
-- dùng, giữ lại credit, đưa job về hàng đợi.
--
-- Chỉ nhận job `failed` hoặc `cancelled`. `done` chạy lại là tạo project mới —
-- người dùng vẫn còn clip cũ và không ai muốn mất chúng vì một cú bấm nhầm.
create or replace function public.retry_job(p_job_id uuid)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_spent int;
  v_balance int;
  v_status public.job_status;
  v_job public.jobs;
begin
  -- Khoá hồ sơ TRƯỚC khi đọc số dư, đúng thứ tự của `create_job`: hai tab bấm
  -- Retry cùng lúc không được tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  select status into v_status
  from public.jobs
  where id = p_job_id and user_id = v_user
  for update;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_status not in ('failed', 'cancelled') then
    raise exception 'Only a failed project can be run again.' using errcode = '22023';
  end if;

  -- Lần chạy trước có thể đã được hoàn credit (`finalize_job_failure`). Giữ lại
  -- đúng phần còn thiếu để một job không bao giờ bị tính tiền hai lần.
  v_spent := public.job_credits_spent(p_job_id);
  if v_spent < v_hold then
    select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;

    if v_balance < v_hold - v_spent then
      raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
        v_hold - v_spent, v_balance using errcode = 'P0001';
    end if;

    insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (v_user, -(v_hold - v_spent), 'Hold for retry', p_job_id);
  end if;

  update public.jobs
  set status = 'queued',
      stage = 'queued',
      error = null,
      finished_at = null,
      -- attempt_id để null: worker của lần chạy cũ (nếu còn sống) ghi bằng
      -- attempt_id cũ sẽ bị mọi RPC có fence từ chối.
      attempt_id = null,
      lease_until = null,
      heartbeat_at = null,
      attempt_started_at = null,
      call_id = null
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

-- -------------------------------------------------------------- request_zip
--
-- Gói các bản export đã xong của nhiều clip thành một file. CHỐT DANH SÁCH ngay
-- tại đây: worker chạy sau vài phút, và "export mới nhất" lúc đó có thể là một
-- bản khác với bản người dùng đang nhìn khi bấm nút.
create or replace function public.request_zip(
  p_job_id uuid,
  p_clip_ids uuid[],
  p_request_id uuid
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_count int;
  v_items jsonb;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_clip_ids is null or array_length(p_clip_ids, 1) is null then
    raise exception 'Choose at least one clip.' using errcode = '22023';
  end if;
  -- Trần 10: `opencmo/worker/zip_task.py` từ chối payload dài hơn thế, và một
  -- ZIP 10 clip 1080p đã là vài trăm MB.
  if array_length(p_clip_ids, 1) > 10 then
    raise exception 'Choose at most 10 clips.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.jobs where id = p_job_id and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  -- Gọi lại cùng request_id (mạng gửi lại, bấm hai lần) trả đúng task cũ.
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.kind <> 'zip' or v_task.job_id is distinct from p_job_id then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  -- Ảnh chụp: export ĐÃ XONG mới nhất của từng clip, và chỉ clip thuộc đúng
  -- project + đúng người dùng. Không lọc ở đây thì worker chạy bằng service
  -- role sẽ gói cả clip của người khác vào file người này tải về.
  -- Hình dạng payload là HỢP ĐỒNG với `opencmo/worker/zip_task.py`: nó đọc
  -- `export_task_ids` và từ chối mọi thứ khác. Mỗi id ở đây đã được kiểm chủ sở
  -- hữu + project ngay trong câu dưới, và worker kiểm lại lần nữa.
  select count(*), jsonb_agg(to_jsonb(t.id::text) order by t.idx)
    into v_count, v_items
  from (
    select distinct on (c.id)
      c.id as clip_id, c.idx, k.id, k.revision_id, r.number
    from public.clips c
    join public.jobs j on j.id = c.job_id
    join public.tasks k on k.clip_id = c.id
    join public.clip_revisions r on r.id = k.revision_id
    where c.id = any(p_clip_ids)
      and c.job_id = p_job_id
      and j.user_id = v_user
      and k.kind = 'export'
      and k.status = 'done'
    order by c.id, k.finished_at desc nulls last, k.created_at desc
  ) t;

  if v_count = 0 then
    raise exception 'Export these clips before downloading them together.'
      using errcode = 'P0002';
  end if;

  insert into public.tasks (user_id, kind, job_id, payload, request_id)
  values (v_user, 'zip', p_job_id, jsonb_build_object('export_task_ids', v_items), p_request_id)
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
    if not found then
      raise exception 'Could not start the download. Please try again.' using errcode = 'P0001';
    end if;
  end if;
  return v_task;
end;
$$;

-- ------------------------------------------------- register_media_asset (v2)
--
-- Giống bản D1, thêm ĐÚNG MỘT việc: tạo luôn task `probe_media` trong cùng giao
-- dịch. Tách làm hai lượt gọi từ route handler là mở một cửa sổ để asset nằm
-- `pending` vĩnh viễn — không ai probe nó, và UI quay mãi "Checking video…".
--
-- Trả về jsonb chứ không phải `public.media_assets` để route handler lấy được
-- cả id task mà không phải hỏi thêm một vòng.
create or replace function public.register_media_asset(
  p_job_id uuid,
  p_storage_path text,
  p_name text,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_asset public.media_assets;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  v_asset := public.register_media_asset(p_job_id, p_storage_path, p_name);

  -- Asset đã có task probe (gọi lại cùng đường dẫn) thì dùng lại, không xếp
  -- hàng lần hai cho cùng một file.
  select * into v_task from public.tasks
  where asset_id = v_asset.id and kind = 'probe_media'
  order by created_at desc
  limit 1;

  if not found then
    insert into public.tasks (user_id, kind, asset_id, job_id, request_id)
    values (v_user, 'probe_media', v_asset.id, p_job_id, p_request_id)
    on conflict do nothing
    returning * into v_task;

    if not found then
      select * into v_task from public.tasks where request_id = p_request_id;
    end if;
  end if;

  return jsonb_build_object(
    'asset', to_jsonb(v_asset),
    'task_id', v_task.id
  );
end;
$$;

-- ----------------------------------------------------------------- account
--
-- Email + gói + số dư trong một lượt gọi. Quota theo gói là việc của D4; hôm
-- nay trả đúng những gì đã có thật trong database.
create or replace function public.account_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_email text;
  v_plan text;
begin
  select email into v_email from auth.users where id = v_user;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;

  return jsonb_build_object(
    'email', v_email,
    'plan', coalesce(v_plan, 'free'),
    'credits', (
      select coalesce(sum(delta), 0)::int
      from public.credit_ledger where user_id = v_user
    ),
    'job_hold_credits', public.job_hold_credits()
  );
end;
$$;

-- ----------------------------------------------------------------- quyền
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.retry_job(uuid)',
    'public.request_zip(uuid, uuid[], uuid)',
    'public.register_media_asset(uuid, text, text, uuid)',
    'public.account_summary()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- Bản ba tham số giờ chỉ là phần thân của bản bốn tham số: người dùng gọi
  -- thẳng nó sẽ tạo asset mà không có task probe nào.
  execute 'revoke execute on function public.register_media_asset(uuid, text, text)'
       || ' from public, anon, authenticated';
end;
$$;
