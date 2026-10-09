-- Vòng đời export mới: browser encode -> TUS -> worker finalize.
-- Task đứng ở `awaiting_upload` nên worker không claim trước khi object hoàn tất.

begin;

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check
  check (kind in ('preview', 'export', 'probe_media', 'zip', 'client_export', 'finalize'));

alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check
  check (status in ('awaiting_upload', 'queued', 'running', 'done', 'failed', 'cancelled'));

alter table public.tasks
  add column editor_revision_id uuid references public.editor_revisions(id);
create index tasks_editor_revision_idx
  on public.tasks(editor_revision_id, created_at desc)
  where editor_revision_id is not null;

-- Hàm nội bộ nhận cả user + mốc task để cleanup trả đúng cửa sổ quota, kể cả
-- task sinh trước nửa đêm và hết hạn sau nửa đêm.
create or replace function public.release_rate_limit_for(
  p_user_id uuid,
  p_bucket text,
  p_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_window_seconds int;
  v_window_start timestamptz;
begin
  if p_user_id is null or p_bucket not in ('preview', 'export') or p_at is null then
    raise exception 'Invalid rate limit release.' using errcode = '22023';
  end if;
  v_window_seconds := 86400;
  v_window_start := to_timestamp(
    floor(extract(epoch from p_at) / v_window_seconds) * v_window_seconds
  );
  update public.rate_limits
  set count = greatest(count - 1, 0)
  where user_id = p_user_id
    and bucket = p_bucket
    and window_start = v_window_start
    and count > 0;
  return found;
end;
$$;

create or replace function public.release_rate_limit(p_bucket text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  return public.release_rate_limit_for(public.require_user(), p_bucket, now());
end;
$$;

create or replace function public.request_client_export(
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
  v_revision public.editor_revisions;
  v_job_id uuid;
  v_task public.tasks;
  v_task_id uuid := gen_random_uuid();
  v_object text;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);
  select r.* into v_revision
  from public.editor_revisions r
  where r.id = p_revision_id and r.clip_id = p_clip_id;
  if not found then
    raise exception 'Save the project before exporting it.' using errcode = 'P0002';
  end if;
  select c.job_id into v_job_id from public.clips c where c.id = p_clip_id;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.kind not in ('client_export', 'finalize')
       or v_task.clip_id is distinct from p_clip_id
       or v_task.editor_revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  if (select count(*) from public.tasks
      where user_id = v_user
        and kind in ('preview', 'export', 'client_export', 'finalize')
        and status in ('awaiting_upload', 'queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  select coalesce(plan, 'free') into v_plan
  from public.profiles where id = v_user;
  select * into v_quota from public.plan_quota(v_plan);
  if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;

  v_object := v_user::text || '/' || p_clip_id::text || '/' || v_task_id::text || '.mp4';
  insert into public.tasks(
    id, user_id, kind, clip_id, editor_revision_id, settings_hash, job_id,
    payload, status, request_id
  ) values (
    v_task_id, v_user, 'client_export', p_clip_id, p_revision_id,
    v_revision.source_hash, v_job_id,
    jsonb_build_object(
      'bucket', 'exports',
      'object', v_object,
      'editor_revision_id', p_revision_id,
      'source_hash', v_revision.source_hash
    ),
    'awaiting_upload', p_request_id
  )
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
  end if;
  if not found then
    perform public.release_rate_limit_for(v_user, 'export', now());
    raise exception 'Could not start the export. Please try again.' using errcode = 'P0001';
  end if;
  if v_task.user_id is distinct from v_user
     or v_task.kind not in ('client_export', 'finalize')
     or v_task.clip_id is distinct from p_clip_id
     or v_task.editor_revision_id is distinct from p_revision_id then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

create or replace function public.complete_client_export(
  p_task_id uuid,
  p_bytes bigint,
  p_duration numeric
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public, storage
as $$
declare
  v_user uuid := public.require_user();
  v_task public.tasks;
  v_res public.upload_reservations;
  v_size bigint;
  v_bucket text;
  v_object text;
begin
  if p_bytes is null or p_bytes <= 0 or p_duration is null or p_duration <= 0
     or p_duration > 600 then
    raise exception 'Uploaded file details do not match this export.' using errcode = '22023';
  end if;

  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or v_task.user_id is distinct from v_user then
    raise exception 'Export not found.' using errcode = 'P0002';
  end if;

  -- Response thất lạc: cùng số đo trả lại hàng canonical. Sau khi worker chạy,
  -- `tasks.bytes` là kích thước FINAL nên số đo browser nằm bền vững trong payload.
  if v_task.kind = 'finalize' and v_task.status in ('queued', 'running', 'done') then
    if (v_task.payload->>'uploaded_bytes')::bigint is distinct from p_bytes
       or (v_task.payload->>'uploaded_duration')::numeric is distinct from p_duration then
      raise exception 'Uploaded file details do not match this export.' using errcode = '22023';
    end if;
    return v_task;
  end if;
  if v_task.kind <> 'client_export' or v_task.status <> 'awaiting_upload' then
    raise exception 'This export is not waiting for an upload.' using errcode = '22023';
  end if;

  v_bucket := v_task.payload->>'bucket';
  v_object := v_task.payload->>'object';
  if v_bucket <> 'exports' or v_object is null then
    raise exception 'This export has no upload destination.' using errcode = '22023';
  end if;

  select * into v_res from public.upload_reservations
  where user_id = v_user and bucket = v_bucket and object_name = v_object
  for update;
  if not found or v_res.status <> 'reserved' or v_res.expires_at <= now()
     or v_res.project_id is distinct from v_task.job_id then
    raise exception 'That upload is not ready. Please upload it again.' using errcode = 'P0001';
  end if;
  select coalesce((metadata->>'size')::bigint, 0) into v_size
  from storage.objects where bucket_id = v_bucket and name = v_object;
  if not found or v_size <= 0 or v_size <> p_bytes or v_size > v_res.declared_size then
    raise exception 'Uploaded file details do not match this export.' using errcode = '22023';
  end if;

  update public.upload_reservations set status = 'consumed' where id = v_res.id;
  update public.tasks
  set kind = 'finalize',
      status = 'queued',
      bytes = p_bytes,
      duration = p_duration,
      payload = payload || jsonb_build_object(
        'uploaded_bytes', p_bytes,
        'uploaded_duration', p_duration
      ),
      error = null
  where id = p_task_id
  returning * into v_task;
  return v_task;
end;
$$;

create or replace function public.cancel_client_export(p_task_id uuid)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or v_task.user_id is distinct from v_user then
    raise exception 'Export not found.' using errcode = 'P0002';
  end if;
  if v_task.status = 'cancelled' then return v_task; end if;
  if v_task.kind <> 'client_export' or v_task.status <> 'awaiting_upload' then
    raise exception 'This export can no longer be cancelled.' using errcode = '22023';
  end if;

  update public.tasks
  set status = 'cancelled',
      error = null,
      finished_at = now()
  where id = p_task_id
  returning * into v_task;
  perform public.release_rate_limit_for(v_user, 'export', v_task.created_at);
  return v_task;
end;
$$;

create or replace function public.expire_abandoned_client_exports()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r record;
  v_rows int := 0;
begin
  for r in
    select id, user_id, created_at
    from public.tasks
    where kind = 'client_export'
      and status = 'awaiting_upload'
      and created_at < now() - interval '30 minutes'
    order by created_at
    limit 200
    for update skip locked
  loop
    update public.tasks
    set status = 'failed',
        error = 'The browser upload timed out. Export again to retry.',
        finished_at = now()
    where id = r.id and kind = 'client_export' and status = 'awaiting_upload';
    if found then
      perform public.release_rate_limit_for(r.user_id, 'export', r.created_at);
      v_rows := v_rows + 1;
    end if;
  end loop;
  return v_rows;
end;
$$;

-- Cron đã gọi hàm này mỗi lượt; expire task ở cùng chỗ để không cần scheduler
-- thứ hai chỉ cho một timeout 30 phút.
create or replace function public.purge_stale_rate_limits()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  perform public.expire_abandoned_client_exports();
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rows = row_count;
  delete from public.upload_reservations
   where status = 'reserved' and expires_at < now() - interval '1 day';
  delete from public.polar_webhook_receipts where received_at < now() - interval '90 days';
  return v_rows;
end;
$$;

revoke execute on function public.release_rate_limit_for(uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.release_rate_limit_for(uuid,text,timestamptz) to service_role;
-- Không cấp hàm refund trực tiếp cho browser: nếu authenticated tự gọi
-- được thì họ có thể xoá counter và vượt quota. Chỉ các RPC lifecycle
-- security-definer ở trên (và service role vận hành) được hoàn lượt.
revoke execute on function public.release_rate_limit(text) from public, anon, authenticated;
grant execute on function public.release_rate_limit(text) to service_role;

do $$ declare f text; begin
  foreach f in array array[
    'public.request_client_export(uuid,uuid,uuid)',
    'public.complete_client_export(uuid,bigint,numeric)',
    'public.cancel_client_export(uuid)'
  ] loop
    execute format('revoke execute on function %s from public,anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

revoke execute on function public.expire_abandoned_client_exports()
  from public, anon, authenticated;
grant execute on function public.expire_abandoned_client_exports() to service_role;
revoke execute on function public.purge_stale_rate_limits()
  from public, anon, authenticated;
grant execute on function public.purge_stale_rate_limits() to service_role;

commit;
