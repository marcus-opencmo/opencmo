-- D3 security completion: DB-enforced compute/storage quotas, upload
-- reservations, tenant-safe idempotency, and persistent project favorites.

create table public.upload_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null check (bucket in ('sources', 'media')),
  object_name text not null,
  declared_size bigint not null check (declared_size > 0 and declared_size <= 2147483648),
  content_type text not null check (content_type like 'video/%'),
  project_id uuid references public.jobs(id) on delete cascade,
  status text not null default 'reserved' check (status in ('reserved', 'consumed')),
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  unique (bucket, object_name)
);

create index upload_reservations_user_status_idx
  on public.upload_reservations(user_id, status, expires_at);
alter table public.upload_reservations enable row level security;
revoke all on public.upload_reservations from public, anon, authenticated;

create or replace function public.plan_usage_limits(p_plan text)
returns table(preview_daily int, export_daily int, stored_bytes bigint, stored_objects int)
language sql
immutable
security definer
set search_path = public
as $$
  select case coalesce(p_plan, 'free')
    when 'creator' then 300 when 'starter' then 100 else 20 end,
  case coalesce(p_plan, 'free')
    when 'creator' then 100 when 'starter' then 30 else 5 end,
  case coalesce(p_plan, 'free')
    when 'creator' then 26843545600::bigint when 'starter' then 10737418240::bigint else 2147483648::bigint end,
  case coalesce(p_plan, 'free')
    when 'creator' then 2500 when 'starter' then 1000 else 200 end;
$$;

create or replace function public.reserve_upload(
  p_bucket text,
  p_object_name text,
  p_size bigint,
  p_content_type text,
  p_project_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, storage
as $$
declare
  v_user uuid := public.require_user();
  v_plan text;
  v_limits record;
  v_bytes bigint;
  v_objects bigint;
  v_existing public.upload_reservations;
  v_row public.upload_reservations;
  v_parts text[] := string_to_array(coalesce(p_object_name, ''), '/');
begin
  if p_bucket not in ('sources', 'media') or p_size is null or p_size <= 0
     or p_size > 2147483648 or coalesce(p_content_type, '') not like 'video/%' then
    raise exception 'That video cannot be uploaded.' using errcode = '22023';
  end if;
  if v_parts[1] is distinct from v_user::text
     or (p_bucket = 'sources' and array_length(v_parts, 1) <> 2)
     or (p_bucket = 'media' and array_length(v_parts, 1) <> 3) then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if p_bucket = 'sources' and p_project_id is not null then
    raise exception 'A source upload cannot belong to an existing project.' using errcode = '22023';
  end if;
  if p_bucket = 'media' and (
    p_project_id is null or v_parts[2] is distinct from p_project_id::text or
    not exists(select 1 from public.jobs where id = p_project_id and user_id = v_user)
  ) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':upload', 1703));
  delete from public.upload_reservations
    where user_id = v_user and status = 'reserved' and expires_at <= now();

  select * into v_existing from public.upload_reservations
    where bucket = p_bucket and object_name = p_object_name;
  if found then
    if v_existing.user_id = v_user and v_existing.declared_size = p_size
       and v_existing.content_type = p_content_type
       and v_existing.project_id is not distinct from p_project_id
       and v_existing.status = 'reserved' and v_existing.expires_at > now() then
      return jsonb_build_object('bucket', v_existing.bucket, 'object_name', v_existing.object_name,
        'expires_at', v_existing.expires_at);
    end if;
    raise exception 'That upload path is already in use.' using errcode = '22023';
  end if;

  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0), count(*)
    into v_bytes, v_objects
    from storage.objects o
    where o.bucket_id in ('sources', 'media') and (storage.foldername(o.name))[1] = v_user::text;
  select v_bytes + coalesce(sum(r.declared_size), 0), v_objects + count(*)
    into v_bytes, v_objects
    from public.upload_reservations r
    where r.user_id = v_user and r.status = 'reserved' and r.expires_at > now()
      and not exists(select 1 from storage.objects o where o.bucket_id = r.bucket and o.name = r.object_name);
  if v_bytes + p_size > v_limits.stored_bytes or v_objects + 1 > v_limits.stored_objects then
    raise exception 'You have reached your storage limit for this plan.' using errcode = 'P0001';
  end if;

  insert into public.upload_reservations(user_id, bucket, object_name, declared_size, content_type, project_id)
    values(v_user, p_bucket, p_object_name, p_size, p_content_type, p_project_id)
    returning * into v_row;
  return jsonb_build_object('bucket', v_row.bucket, 'object_name', v_row.object_name,
    'expires_at', v_row.expires_at);
end;
$$;

create or replace function public.upload_reservation_allows(
  p_bucket text, p_name text, p_metadata jsonb
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.upload_reservations r
    where r.user_id = auth.uid() and r.bucket = p_bucket and r.object_name = p_name
      and r.status = 'reserved' and r.expires_at > now()
  );
$$;

-- TUS inserts a placeholder row before object size exists, then updates metadata
-- after the final chunk. RLS gates the path at INSERT; this trigger gates the
-- actual bytes at finalize so a caller cannot reserve 1 byte and upload 2 GiB.
create or replace function public.validate_reserved_upload_object()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_size bigint := coalesce((new.metadata->>'size')::bigint, 0); v_res public.upload_reservations;
begin
  if new.bucket_id not in ('sources','media') or v_size <= 0 then return new; end if;
  select * into v_res from public.upload_reservations
    where bucket=new.bucket_id and object_name=new.name and status='reserved' and expires_at>now();
  -- Worker/service-role objects (proxy/sections) do not have browser reservations.
  -- Their writes bypass RLS and must remain valid.
  if not found then return new; end if;
  if v_size > v_res.declared_size
     or coalesce(new.metadata->>'mimetype',new.metadata->>'contentType','') not like 'video/%' then
    raise exception 'Upload does not match its reservation.' using errcode='22023';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_reserved_upload_object on storage.objects;
create trigger validate_reserved_upload_object
before insert or update of metadata on storage.objects
for each row execute function public.validate_reserved_upload_object();

drop policy if exists "ghi file nguồn vào thư mục của mình" on storage.objects;
create policy "ghi file nguồn vào thư mục của mình"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'sources' and public.upload_reservation_allows(bucket_id, name, metadata));

drop policy if exists "ghi B-roll vào thư mục của mình" on storage.objects;
create policy "ghi B-roll vào thư mục của mình"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.upload_reservation_allows(bucket_id, name, metadata));

create or replace function public.consume_upload_reservation(
  p_bucket text, p_object_name text, p_project_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, storage
as $$
declare
  v_user uuid := public.require_user();
  v_res public.upload_reservations;
  v_size bigint;
begin
  select * into v_res from public.upload_reservations
    where user_id = v_user and bucket = p_bucket and object_name = p_object_name
    for update;
  if not found or v_res.status <> 'reserved' or v_res.expires_at <= now()
     or v_res.project_id is distinct from p_project_id then
    raise exception 'That upload is not ready. Please upload it again.' using errcode = 'P0001';
  end if;
  select coalesce((metadata->>'size')::bigint, 0) into v_size from storage.objects
    where bucket_id = p_bucket and name = p_object_name;
  if not found or v_size <= 0 or v_size > v_res.declared_size then
    raise exception 'That upload is not ready. Please upload it again.' using errcode = 'P0001';
  end if;
  update public.upload_reservations set status = 'consumed' where id = v_res.id;
end;
$$;

create or replace function public.upload_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  v_user uuid := public.require_user(); v_plan text; v_limits record;
  v_bytes bigint; v_objects bigint;
begin
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0), count(*)
    into v_bytes, v_objects from storage.objects
    where bucket_id in ('sources','media') and (storage.foldername(name))[1] = v_user::text;
  return jsonb_build_object('bytes', v_bytes, 'limit', v_limits.stored_bytes,
    'objects', v_objects, 'objectLimit', v_limits.stored_objects);
end;
$$;

create or replace function public.consume_daily_task_quota(p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_user uuid := public.require_user(); v_plan text; v_limits record; v_limit int;
begin
  if p_kind not in ('preview','export') then raise exception 'Invalid task quota.' using errcode='22023'; end if;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  v_limit := case when p_kind = 'preview' then v_limits.preview_daily else v_limits.export_daily end;
  if not public.rate_limit_hit('daily_' || p_kind, v_limit, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.request_preview(p_clip_id uuid, p_settings jsonb, p_settings_hash text, p_request_id uuid)
returns public.tasks language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid := public.require_user(); v_task public.tasks;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'Clip settings must be an object.' using errcode='22023'; end if;
  if pg_column_size(p_settings) >= 65536 then raise exception 'These clip settings are too large to save.' using errcode='22023'; end if;
  if p_settings_hash is null or p_settings_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid settings fingerprint.' using errcode='22023'; end if;
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  perform public.owned_clip(p_clip_id, v_user);
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,1701));
  select * into v_task from public.tasks where request_id=p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'preview' or v_task.clip_id is distinct from p_clip_id
      or v_task.settings_hash is distinct from p_settings_hash or v_task.payload->'settings' is distinct from p_settings
    then raise exception 'This request id was already used for something else.' using errcode='22023'; end if;
    return v_task;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,1702));
  select * into v_task from public.tasks where kind='preview' and clip_id=p_clip_id and settings_hash=p_settings_hash
    and status in ('queued','running','done') limit 1;
  if found then
    if v_task.user_id is distinct from v_user or v_task.payload->'settings' is distinct from p_settings
    then raise exception 'This request id was already used for something else.' using errcode='22023'; end if;
    return v_task;
  end if;
  if (select count(*) from public.tasks where user_id=v_user and kind in ('preview','export') and status in ('queued','running')) >= 20
    then raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.' using errcode='P0001'; end if;
  perform public.consume_daily_task_quota('preview');
  insert into public.tasks(user_id,kind,clip_id,settings_hash,payload,request_id)
    values(v_user,'preview',p_clip_id,p_settings_hash,jsonb_build_object('settings',p_settings),p_request_id)
    on conflict do nothing returning * into v_task;
  if not found then select * into v_task from public.tasks where request_id=p_request_id; end if;
  if not found then raise exception 'Could not start the preview. Please try again.' using errcode='P0001'; end if;
  if v_task.user_id is distinct from v_user or v_task.kind <> 'preview' or v_task.clip_id is distinct from p_clip_id
    or v_task.settings_hash is distinct from p_settings_hash or v_task.payload->'settings' is distinct from p_settings
  then raise exception 'This request id was already used for something else.' using errcode='22023'; end if;
  return v_task;
end; $$;

create or replace function public.request_export(p_clip_id uuid,p_revision_id uuid,p_request_id uuid)
returns public.tasks language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid := public.require_user(); v_hash text; v_task public.tasks;
begin
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  perform public.owned_clip(p_clip_id,v_user);
  select settings_hash into v_hash from public.clip_revisions where id=p_revision_id and clip_id=p_clip_id;
  if not found then raise exception 'Save the clip before exporting it.' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,1701));
  select * into v_task from public.tasks where request_id=p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'export' or v_task.clip_id is distinct from p_clip_id or v_task.revision_id is distinct from p_revision_id
    then raise exception 'This export request was already used for another clip or revision.' using errcode='22023'; end if;
    return v_task;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,1702));
  select * into v_task from public.tasks where kind='export' and clip_id=p_clip_id and revision_id=p_revision_id and status in ('queued','running','done') limit 1;
  if found then return v_task; end if;
  if (select count(*) from public.tasks where user_id=v_user and kind in ('preview','export') and status in ('queued','running')) >= 20
    then raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.' using errcode='P0001'; end if;
  perform public.consume_daily_task_quota('export');
  insert into public.tasks(user_id,kind,clip_id,revision_id,settings_hash,request_id)
    values(v_user,'export',p_clip_id,p_revision_id,v_hash,p_request_id) on conflict do nothing returning * into v_task;
  if not found then select * into v_task from public.tasks where request_id=p_request_id; end if;
  if not found then raise exception 'Could not start the export. Please try again.' using errcode='P0001'; end if;
  if v_task.user_id is distinct from v_user or v_task.kind <> 'export' or v_task.clip_id is distinct from p_clip_id or v_task.revision_id is distinct from p_revision_id
    then raise exception 'This request id was already used for something else.' using errcode='22023'; end if;
  return v_task;
end; $$;

-- Require a successfully uploaded object before either media-registration RPC can proceed.
create or replace function public.register_media_asset(p_job_id uuid,p_storage_path text,p_name text)
returns public.media_assets language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid := public.require_user(); v_segments text[]; v_name text:=trim(coalesce(p_name,'')); v_count int; v_asset public.media_assets; v_object text;
begin
  perform 1 from public.jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Project not found.' using errcode='P0002'; end if;
  v_segments:=string_to_array(coalesce(p_storage_path,''),'/');
  if array_length(v_segments,1) is distinct from 4 or v_segments[1]<>'media' or v_segments[2]<>v_user::text or v_segments[3]<>p_job_id::text or v_segments[4]!~'^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{2,5}$'
    then raise exception 'That media file is no longer available. Please try again.' using errcode='22023'; end if;
  if v_name='' then raise exception 'This media file needs a name.' using errcode='22023'; end if;
  v_name:=left(v_name,200);
  select * into v_asset from public.media_assets where storage_path=p_storage_path and user_id=v_user and job_id=p_job_id;
  if found then return v_asset; end if;
  select count(*) into v_count from public.media_assets where job_id=p_job_id;
  if v_count>=50 then raise exception 'This project already has 50 media files.' using errcode='P0001'; end if;
  v_object:=substring(p_storage_path from 7);
  perform public.consume_upload_reservation('media',v_object,p_job_id);
  insert into public.media_assets(user_id,job_id,storage_path,name) values(v_user,p_job_id,p_storage_path,v_name)
    on conflict(storage_path) do nothing returning * into v_asset;
  if not found then select * into v_asset from public.media_assets where storage_path=p_storage_path and user_id=v_user and job_id=p_job_id; end if;
  if not found then raise exception 'That media file is no longer available. Please try again.' using errcode='22023'; end if;
  return v_asset;
end; $$;

create or replace function public.register_media_asset(p_job_id uuid,p_storage_path text,p_name text,p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid:=public.require_user(); v_asset public.media_assets; v_task public.tasks;
begin
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_request_id::text,1704));
  v_asset:=public.register_media_asset(p_job_id,p_storage_path,p_name);
  select * into v_task from public.tasks where asset_id=v_asset.id and kind='probe_media' order by created_at desc limit 1;
  if not found then
    perform 1 from public.tasks where request_id=p_request_id;
    if found then
      raise exception 'That request id was already used for a different media file.' using errcode='22023';
    end if;
    insert into public.tasks(user_id,kind,asset_id,job_id,request_id)
      values(v_user,'probe_media',v_asset.id,p_job_id,p_request_id) returning * into v_task;
  end if;
  if v_task.user_id is distinct from v_user or v_task.kind<>'probe_media' or v_task.asset_id is distinct from v_asset.id or v_task.job_id is distinct from p_job_id
    then raise exception 'That request id was already used for a different media file.' using errcode='22023'; end if;
  return jsonb_build_object('asset',to_jsonb(v_asset),'task_id',v_task.id);
end; $$;

create or replace function public.set_project_pinned(p_job_id uuid,p_pinned boolean)
returns public.jobs language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid:=public.require_user(); v_job public.jobs;
begin
  update public.jobs set pinned=coalesce(p_pinned,false) where id=p_job_id and user_id=v_user returning * into v_job;
  if not found then raise exception 'Project not found.' using errcode='P0002'; end if;
  return v_job;
end; $$;

create or replace function public.create_job(p_source_url text,p_clips int default 5,p_length text default 'auto')
returns public.jobs language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid:=public.require_user(); v_hold int:=public.job_hold_credits(); v_balance int;
  v_plan text; v_length text:=coalesce(p_length,'auto'); v_job public.jobs; v_source text:=trim(coalesce(p_source_url,''));
begin
  if v_source='' then raise exception 'Missing video link.' using errcode='22023'; end if;
  if p_clips<1 or p_clips>10 then raise exception 'Clip count must be between 1 and 10.' using errcode='22023'; end if;
  if v_length not in ('auto','short','medium','long') then raise exception 'Choose a clip length.' using errcode='22023'; end if;
  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources',substring(v_source from 11),null);
  end if;
  perform 1 from public.profiles where id=v_user for update;
  select coalesce(sum(delta),0)::int into v_balance from public.credit_ledger where user_id=v_user;
  if v_balance<v_hold then raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',v_hold,v_balance using errcode='P0001'; end if;
  select plan into v_plan from public.profiles where id=v_user;
  insert into public.jobs(user_id,source_url,clips_requested,clip_length,watermark)
    values(v_user,v_source,p_clips,v_length,coalesce(v_plan,'free')='free') returning * into v_job;
  insert into public.credit_ledger(user_id,delta,reason,job_id) values(v_user,-v_hold,'Hold for new job',v_job.id);
  return v_job;
end; $$;

create or replace function public.account_summary()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_user uuid:=public.require_user(); v_email text; v_plan text; v_limits record;
  v_preview int:=0; v_export int:=0; v_storage jsonb;
begin
  select email into v_email from auth.users where id=v_user;
  select coalesce(plan,'free') into v_plan from public.profiles where id=v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(max(count),0) into v_preview from public.rate_limits
    where user_id=v_user and bucket='daily_preview' and window_start=to_timestamp(floor(extract(epoch from now())/86400)*86400);
  select coalesce(max(count),0) into v_export from public.rate_limits
    where user_id=v_user and bucket='daily_export' and window_start=to_timestamp(floor(extract(epoch from now())/86400)*86400);
  v_storage:=public.upload_usage();
  return jsonb_build_object('email',v_email,'plan',v_plan,
    'credits',(select coalesce(sum(delta),0)::int from public.credit_ledger where user_id=v_user),
    'job_hold_credits',public.job_hold_credits(),
    'quota',jsonb_build_object(
      'previews',jsonb_build_object('used',least(v_preview,v_limits.preview_daily),'limit',v_limits.preview_daily),
      'exports',jsonb_build_object('used',least(v_export,v_limits.export_daily),'limit',v_limits.export_daily),
      'storage',v_storage),
    'resets_at',to_timestamp((floor(extract(epoch from now())/86400)+1)*86400));
end; $$;

revoke execute on function public.plan_usage_limits(text) from public,anon,authenticated;
revoke execute on function public.consume_upload_reservation(text,text,uuid) from public,anon,authenticated;
revoke execute on function public.consume_daily_task_quota(text) from public,anon,authenticated;
revoke execute on function public.upload_reservation_allows(text,text,jsonb) from public,anon;
grant execute on function public.upload_reservation_allows(text,text,jsonb) to authenticated;
revoke execute on function public.validate_reserved_upload_object() from public,anon,authenticated;

do $$ declare f text; begin
  foreach f in array array[
    'public.reserve_upload(text,text,bigint,text,uuid)',
    'public.upload_usage()',
    'public.set_project_pinned(uuid,boolean)',
    'public.request_preview(uuid,jsonb,text,uuid)',
    'public.request_export(uuid,uuid,uuid)',
    'public.register_media_asset(uuid,text,text,uuid)'
  ] loop
    execute format('revoke execute on function %s from public,anon',f);
    execute format('grant execute on function %s to authenticated',f);
  end loop;
end $$;
