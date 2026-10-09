-- D4 billing: số dư materialized O(1), ledger append-only và quota theo gói.

begin;

-- =========================================================== credit balance
-- SHARE ROW EXCLUSIVE xung đột với ROW EXCLUSIVE của INSERT/UPDATE/DELETE.
-- Supabase chạy mỗi migration trong một transaction, nên khoá này được giữ từ
-- trước backfill cho tới sau khi trigger đã cài xong: không có dòng ledger nào
-- lọt vào khe giữa snapshot backfill và trigger.
lock table public.credit_ledger in share row exclusive mode;

alter table public.profiles
  add column credit_balance int not null default 0;

-- Migration giữ đúng số dư lịch sử trước khi trigger bắt đầu nhận dòng mới.
update public.profiles p
set credit_balance = coalesce((
  select sum(l.delta)::int
  from public.credit_ledger l
  where l.user_id = p.id
), 0);

-- `ON DELETE SET NULL` tự UPDATE ledger khi xoá project, trái với append-only.
-- Giữ UUID đối soát sau khi project bị xoá; trigger insert bên dưới thay FK
-- kiểm tra rằng mọi job_id mới vẫn trỏ tới project đang tồn tại.
alter table public.credit_ledger
  drop constraint credit_ledger_job_id_fkey;

-- Giữ ledger tài chính sau khi xoá tài khoản nhưng bỏ liên kết nhận diện. Chỉ
-- FK action này được trigger append-only bên dưới cho phép đổi một cột.
alter table public.credit_ledger
  drop constraint credit_ledger_user_id_fkey,
  alter column user_id drop not null,
  add constraint credit_ledger_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

create or replace function public.apply_credit_ledger_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    raise exception 'The credit account no longer exists.' using errcode = 'P0002';
  end if;
  if new.job_id is not null
     and not exists(select 1 from public.jobs where id = new.job_id) then
    raise exception 'No such project for credit entry.' using errcode = 'P0002';
  end if;

  update public.profiles
  set credit_balance = credit_balance + new.delta
  where id = new.user_id;

  if not found then
    raise exception 'The credit account no longer exists.' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

create trigger apply_credit_ledger_insert
after insert on public.credit_ledger
for each row execute function public.apply_credit_ledger_insert();

create or replace function public.reject_credit_ledger_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and old.user_id is not null
     and new.user_id is null
     and new.id is not distinct from old.id
     and new.delta is not distinct from old.delta
     and new.reason is not distinct from old.reason
     and new.job_id is not distinct from old.job_id
     and new.external_id is not distinct from old.external_id
     and new.created_at is not distinct from old.created_at
     and not exists(select 1 from auth.users where id = old.user_id) then
    return new;
  end if;
  raise exception 'Credit ledger entries cannot be changed or deleted.' using errcode = '55000';
end;
$$;

create trigger reject_credit_ledger_change
before update or delete on public.credit_ledger
for each row execute function public.reject_credit_ledger_change();

revoke execute on function public.apply_credit_ledger_insert() from public, anon, authenticated;
revoke execute on function public.reject_credit_ledger_change() from public, anon, authenticated;

create or replace function public.credit_balance(p_user_id uuid)
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((
    select p.credit_balance
    from public.profiles p
    where p.id = p_user_id
  ), 0);
$$;

revoke execute on function public.credit_balance(uuid) from public, anon;
grant execute on function public.credit_balance(uuid) to authenticated, service_role;

-- =============================================================== plan quota
create or replace function public.plan_quota(p_plan text)
returns table(previews_per_day int, exports_per_day int)
language sql
immutable
security invoker
set search_path = public
as $$
  select
    case coalesce(p_plan, 'free')
      when 'creator' then 300
      when 'starter' then 100
      else 20
    end,
    case coalesce(p_plan, 'free')
      when 'creator' then 100
      when 'starter' then 30
      else 5
    end;
$$;

revoke execute on function public.plan_quota(text) from public, anon, authenticated;
grant execute on function public.plan_quota(text) to service_role;

-- D3 dùng `daily_preview`/`daily_export`. Chuyển counter của cửa sổ UTC hiện
-- hành trước khi RPC D4 đổi tên bucket; lấy max nếu dữ liệu đích đã tồn tại để
-- không cấp thêm allowance cũng không đếm đôi cùng một thao tác.
insert into public.rate_limits(user_id, bucket, window_start, count)
select
  r.user_id,
  case r.bucket when 'daily_preview' then 'preview' else 'export' end,
  r.window_start,
  r.count
from public.rate_limits r
where r.bucket in ('daily_preview', 'daily_export')
  and r.window_start = to_timestamp(floor(extract(epoch from now()) / 86400) * 86400)
on conflict (user_id, bucket, window_start)
do update set count = greatest(public.rate_limits.count, excluded.count);

-- Public anti-spam callers giữ nguyên chữ ký nhưng chỉ được dùng các bộ tham số
-- đã audit. Preview/export chỉ nhận quota đúng plan; tuple 2/60 là contract D1
-- cũ và chỉ siết chặt hơn quota ngày, không thể tăng allowance.
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit int,
  p_window_seconds int
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_bucket text;
  v_plan text;
  v_quota record;
  v_expected int;
  v_window_start timestamptz;
  v_legacy_count int := 0;
  v_count int;
  v_allowed boolean := false;
begin
  -- D3 RPCs may still be in flight with the old daily_* names. Resolve both
  -- names before reading or writing so aliases cannot split one quota counter.
  v_bucket := case p_bucket
    when 'daily_preview' then 'preview'
    when 'daily_export' then 'export'
    else p_bucket
  end;

  if v_bucket in ('preview', 'export') then
    select coalesce(plan, 'free') into v_plan
    from public.profiles where id = v_user;
    select * into v_quota from public.plan_quota(v_plan);
    v_expected := case
      when v_bucket = 'preview' then v_quota.previews_per_day
      else v_quota.exports_per_day
    end;
    v_allowed := p_limit = v_expected and p_window_seconds = 86400;
    -- Hợp đồng test/anti-spam D1 cũ; chỉ làm quota preview chặt hơn.
    if p_bucket = 'preview' and p_limit = 2 and p_window_seconds = 60 then
      v_allowed := true;
    end if;
  else
    v_allowed := (p_bucket = 'presets' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'uploads' and p_limit = 30 and p_window_seconds = 3600)
      or (p_bucket = 'jobs' and p_limit = 10 and p_window_seconds = 3600)
      or (p_bucket = 'retry' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'draft' and p_limit = 120 and p_window_seconds = 60)
      or (p_bucket = 'project-write' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'zip' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'media' and p_limit = 60 and p_window_seconds = 3600);
  end if;

  if not v_allowed then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- Đọc legacy ngay trong RPC nữa: migration copy xử lý deploy bình thường;
  -- nhánh này giữ continuity nếu một restore/import đưa counter D3 trở lại.
  if v_bucket in ('preview', 'export') and p_window_seconds = 86400 then
    select coalesce(max(count), 0) into v_legacy_count
    from public.rate_limits
      where user_id = v_user
      and bucket = 'daily_' || v_bucket
      and window_start = v_window_start;
  end if;

  insert into public.rate_limits(user_id, bucket, window_start, count)
  values(v_user, v_bucket, v_window_start, v_legacy_count + 1)
  on conflict (user_id, bucket, window_start)
  do update set count = greatest(public.rate_limits.count, v_legacy_count) + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.rate_limit_hit(text, int, int) from public, anon;
grant execute on function public.rate_limit_hit(text, int, int) to authenticated;

-- Dedup nằm trước rate_limit_hit: retry cùng request hoặc cùng nội dung không
-- tiêu thêm quota. Khoá theo user tuần tự hoá cả kiểm tra dedup lẫn bộ đếm.
create or replace function public.request_preview(
  p_clip_id uuid,
  p_settings jsonb,
  p_settings_hash text,
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
  v_plan text;
  v_quota record;
  v_task public.tasks;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Clip settings must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(p_settings) >= 65536 then
    raise exception 'These clip settings are too large to save.' using errcode = '22023';
  end if;
  if p_settings_hash is null or p_settings_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid settings fingerprint.' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));

  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.kind <> 'preview'
       or v_task.clip_id is distinct from p_clip_id
       or v_task.settings_hash is distinct from p_settings_hash
       or v_task.payload->'settings' is distinct from p_settings then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  select * into v_task
  from public.tasks
  where kind = 'preview'
    and clip_id = p_clip_id
    and settings_hash = p_settings_hash
    and status in ('queued', 'running', 'done')
  limit 1;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.payload->'settings' is distinct from p_settings then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  if (select count(*) from public.tasks
      where user_id = v_user
        and kind in ('preview', 'export')
        and status in ('queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  select coalesce(plan, 'free') into v_plan
  from public.profiles where id = v_user;
  select * into v_quota from public.plan_quota(v_plan);
  if not public.rate_limit_hit('preview', v_quota.previews_per_day, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;

  insert into public.tasks(user_id, kind, clip_id, settings_hash, payload, request_id)
  values(v_user, 'preview', p_clip_id, p_settings_hash,
    jsonb_build_object('settings', p_settings), p_request_id)
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
  end if;
  if not found then
    raise exception 'Could not start the preview. Please try again.' using errcode = 'P0001';
  end if;
  if v_task.user_id is distinct from v_user
     or v_task.kind <> 'preview'
     or v_task.clip_id is distinct from p_clip_id
     or v_task.settings_hash is distinct from p_settings_hash
     or v_task.payload->'settings' is distinct from p_settings then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

create or replace function public.request_export(
  p_clip_id uuid,
  p_revision_id uuid,
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
  v_plan text;
  v_quota record;
  v_hash text;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);
  select settings_hash into v_hash
  from public.clip_revisions
  where id = p_revision_id and clip_id = p_clip_id;
  if not found then
    raise exception 'Save the clip before exporting it.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.kind <> 'export'
       or v_task.clip_id is distinct from p_clip_id
       or v_task.revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  select * into v_task
  from public.tasks
  where kind = 'export'
    and clip_id = p_clip_id
    and revision_id = p_revision_id
    and status in ('queued', 'running', 'done')
  limit 1;
  if found then
    return v_task;
  end if;

  if (select count(*) from public.tasks
      where user_id = v_user
        and kind in ('preview', 'export')
        and status in ('queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  select coalesce(plan, 'free') into v_plan
  from public.profiles where id = v_user;
  select * into v_quota from public.plan_quota(v_plan);
  if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;

  insert into public.tasks(user_id, kind, clip_id, revision_id, settings_hash, request_id)
  values(v_user, 'export', p_clip_id, p_revision_id, v_hash, p_request_id)
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
  end if;
  if not found then
    raise exception 'Could not start the export. Please try again.' using errcode = 'P0001';
  end if;
  if v_task.user_id is distinct from v_user
     or v_task.kind <> 'export'
     or v_task.clip_id is distinct from p_clip_id
     or v_task.revision_id is distinct from p_revision_id then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

revoke execute on function public.request_preview(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.request_preview(uuid, jsonb, text, uuid) to authenticated;
revoke execute on function public.request_export(uuid, uuid, uuid) from public, anon;
grant execute on function public.request_export(uuid, uuid, uuid) to authenticated;

-- Giữ toàn bộ validation/tuỳ chọn đầu ra hiện hành; chỉ thay phép SUM ledger
-- bằng lần đọc materialized balance sau khi đã khoá profile.
create or replace function public.create_job(
  p_source_url text,
  p_clips int default 5,
  p_length text default 'auto',
  p_segments jsonb default null,
  p_mode text default 'clip',
  p_aspect text default '9:16',
  p_layout text default 'auto',
  p_captions boolean default true,
  p_caption_preset text default 'bold'
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_length text := coalesce(p_length, 'auto');
  v_job public.jobs;
  v_source text := trim(coalesce(p_source_url, ''));
  v_segments jsonb := p_segments;
  v_clips int := p_clips;
  v_mode text := coalesce(p_mode, 'clip');
  v_aspect text := coalesce(p_aspect, '9:16');
  v_layout text := coalesce(p_layout, 'auto');
  v_captions boolean := coalesce(p_captions, true);
  v_preset text := coalesce(p_caption_preset, 'bold');
  v_prev numeric;
  v_item jsonb;
begin
  if v_source = '' then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;
  if v_mode not in ('clip', 'full') then
    raise exception 'Choose whether to clip the video or download it whole.' using errcode = '22023';
  end if;

  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
  end if;
  if v_mode = 'full' then
    if v_segments is not null then
      raise exception 'Picked moments only apply when we clip your video.' using errcode = '22023';
    end if;
    v_clips := 1;
  end if;

  if v_segments is not null then
    if jsonb_typeof(v_segments) <> 'array' then
      raise exception 'Pick the moments you want on the timeline.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_segments) > 10 then
      raise exception 'Pick at most 10 moments.' using errcode = '22023';
    end if;

    v_prev := null;
    for v_item in
      select value from jsonb_array_elements(v_segments)
      order by (value ->> 'start')::numeric
    loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or jsonb_typeof(v_item -> 'start') is distinct from 'number'
         or jsonb_typeof(v_item -> 'end') is distinct from 'number' then
        raise exception 'Each moment needs a start and end time.' using errcode = '22023';
      end if;
      if (v_item ->> 'start')::numeric < 0 then
        raise exception 'A moment cannot start before the video does.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric < 1 then
        raise exception 'Each moment must be at least 1 second long.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric > 180 then
        raise exception 'Each moment must be 3 minutes or shorter.' using errcode = '22023';
      end if;
      if v_prev is not null and (v_item ->> 'start')::numeric < v_prev then
        raise exception 'Your moments overlap. Move them apart and try again.' using errcode = '22023';
      end if;
      v_prev := (v_item ->> 'end')::numeric;
    end loop;

    select jsonb_agg(value order by (value ->> 'start')::numeric)
    into v_segments from jsonb_array_elements(v_segments);
    v_clips := jsonb_array_length(v_segments);
  end if;

  if v_clips < 1 or v_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;
  if v_length not in ('auto', 'short', 'medium', 'long') then
    raise exception 'Choose a clip length.' using errcode = '22023';
  end if;
  if v_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Unsupported aspect ratio.' using errcode = '22023';
  end if;
  if v_layout not in ('auto', 'fill', 'fit') then
    raise exception 'Unsupported frame layout.' using errcode = '22023';
  end if;
  if v_preset not in ('bold', 'clean', 'minimal') then
    raise exception 'Unsupported caption style.' using errcode = '22023';
  end if;

  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources', substring(v_source from 11), null);
  end if;

  -- Tất cả đường ghi credit giữ cùng thứ tự khoá: profile trước, job sau.
  perform 1 from public.profiles where id = v_user for update;
  v_balance := public.credit_balance(v_user);
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs(
    user_id, source_url, clips_requested, clip_length, watermark, segments,
    mode, aspect, layout, captions, caption_preset
  ) values(
    v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments,
    v_mode, v_aspect, v_layout, v_captions, v_preset
  ) returning * into v_job;

  insert into public.credit_ledger(user_id, delta, reason, job_id)
  values(v_user, -v_hold, 'Hold for new job', v_job.id);
  return v_job;
end;
$$;

revoke execute on function public.create_job(text, int, text, jsonb, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.create_job(text, int, text, jsonb, text, text, text, boolean, text)
  to authenticated;

-- Account summary là consumer hiện hữu của balance/quota; giữ nó O(1) và đọc
-- đúng bucket mới để route D4 không thấy usage bằng 0 giả.
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
  v_limits record;
  v_preview int := 0;
  v_export int := 0;
  v_storage jsonb;
begin
  select email into v_email from auth.users where id = v_user;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(max(count), 0) into v_preview
  from public.rate_limits
  where user_id = v_user and bucket in ('preview', 'daily_preview')
    and window_start = to_timestamp(floor(extract(epoch from now()) / 86400) * 86400);
  select coalesce(max(count), 0) into v_export
  from public.rate_limits
  where user_id = v_user and bucket in ('export', 'daily_export')
    and window_start = to_timestamp(floor(extract(epoch from now()) / 86400) * 86400);
  v_storage := public.upload_usage();
  return jsonb_build_object(
    'email', v_email,
    'plan', v_plan,
    'credits', public.credit_balance(v_user),
    'job_hold_credits', public.job_hold_credits(),
    'quota', jsonb_build_object(
      'previews', jsonb_build_object('used', least(v_preview, v_limits.preview_daily), 'limit', v_limits.preview_daily),
      'exports', jsonb_build_object('used', least(v_export, v_limits.export_daily), 'limit', v_limits.export_daily),
      'storage', v_storage
    ),
    'resets_at', to_timestamp((floor(extract(epoch from now()) / 86400) + 1) * 86400)
  );
end;
$$;

commit;
