-- Bucket riêng cho MP4 do Diffusion Studio encode trong browser.
--
-- `exports` không dùng chung `renders`: browser được INSERT vào bucket này qua
-- reservation, còn `renders` là worker-write-only. Tách bucket giữ policy dễ
-- audit và không mở nhầm cửa ghi vào preview/export cũ.

begin;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('exports', 'exports', false, 2147483648, array['video/*'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.upload_reservations
  drop constraint upload_reservations_bucket_check;
alter table public.upload_reservations
  add constraint upload_reservations_bucket_check
  check (bucket in ('sources', 'media', 'exports'));

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
  if p_bucket not in ('sources', 'media', 'exports') or p_size is null or p_size <= 0
     or p_size > 2147483648 or coalesce(p_content_type, '') not like 'video/%' then
    raise exception 'That video cannot be uploaded.' using errcode = '22023';
  end if;
  if v_parts[1] is distinct from v_user::text
     or (p_bucket = 'sources' and array_length(v_parts, 1) <> 2)
     or (p_bucket in ('media', 'exports') and array_length(v_parts, 1) <> 3) then
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
  if p_bucket = 'exports' and (
    p_project_id is null or not exists(
      select 1 from public.clips c
      join public.jobs j on j.id = c.job_id
      where c.id::text = v_parts[2]
        and c.job_id = p_project_id
        and j.user_id = v_user
        and j.purging_at is null
    )
  ) then
    raise exception 'Clip not found.' using errcode = 'P0002';
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
    where o.bucket_id in ('sources', 'media', 'exports')
      and (storage.foldername(o.name))[1] = v_user::text;
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

create or replace function public.validate_reserved_upload_object()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_size bigint := coalesce((new.metadata->>'size')::bigint, 0); v_res public.upload_reservations;
begin
  if new.bucket_id not in ('sources','media','exports') or v_size <= 0 then return new; end if;
  select * into v_res from public.upload_reservations
    where bucket=new.bucket_id and object_name=new.name and status='reserved' and expires_at>now();
  if not found then return new; end if;
  if v_size > v_res.declared_size
     or coalesce(new.metadata->>'mimetype',new.metadata->>'contentType','') not like 'video/%' then
    raise exception 'Upload does not match its reservation.' using errcode='22023';
  end if;
  return new;
end;
$$;

drop policy if exists "ghi export browser vào thư mục của mình" on storage.objects;
create policy "ghi export browser vào thư mục của mình"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'exports'
    and public.upload_reservation_allows(bucket_id, name, metadata)
  );

drop policy if exists "đọc export browser trong thư mục của mình" on storage.objects;
create policy "đọc export browser trong thư mục của mình"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

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
    where bucket_id in ('sources','media','exports')
      and (storage.foldername(name))[1] = v_user::text;
  return jsonb_build_object('bytes', v_bytes, 'limit', v_limits.stored_bytes,
    'objects', v_objects, 'objectLimit', v_limits.stored_objects);
end;
$$;

alter table public.storage_deletions
  drop constraint storage_deletions_bucket_check;
alter table public.storage_deletions
  add constraint storage_deletions_bucket_check
  check (bucket in ('clips', 'sources', 'renders', 'media', 'exports'));

-- Chép bản Phase 3 rồi thêm payload `exports`: create-or-replace thay toàn bộ
-- thân hàm, nên bỏ hai nhánh masters ở đây sẽ làm rò master/transcript.
create or replace function public.enqueue_job_objects(p_job_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_rows int;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then return 0; end if;

  insert into public.storage_deletions (bucket, path, job_id, user_id)
  select found_path.bucket, found_path.path, p_job_id, v_job.user_id
  from (
    select 'clips'::text as bucket, c.storage_path as path
      from public.clips c where c.job_id = p_job_id
    union
    select 'clips', c.preview_path from public.clips c where c.job_id = p_job_id
    union
    select coalesce(entry.value->>'bucket', 'renders'), entry.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_each(
        case when jsonb_typeof(t.output->'manifest'->'files') = 'object'
             then t.output->'manifest'->'files' else '{}'::jsonb end) entry
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t.output->'manifest'->'sections') = 'array'
             then t.output->'manifest'->'sections' else '[]'::jsonb end) section
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    select 'renders', t.output_path
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where t.job_id = p_job_id or c.job_id = p_job_id
    union
    -- Browser upload tồn tại trước khi worker có output manifest; payload là
    -- tham chiếu bền vững duy nhất trong khe đó.
    select coalesce(t.payload->>'bucket', 'exports'), t.payload->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where (t.job_id = p_job_id or c.job_id = p_job_id)
       and t.kind in ('client_export', 'finalize')
    union
    select 'media', substring(m.storage_path from 7)
      from public.media_assets m
     where m.job_id = p_job_id and m.storage_path like 'media/%'
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from jsonb_array_elements(
        case when jsonb_typeof(v_job.media_manifest->'sections') = 'array'
             then v_job.media_manifest->'sections' else '[]'::jsonb end) section
    union
    select coalesce(proxy.value->>'bucket', 'sources'), proxy.value->>'object'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'proxies') = 'object'
             then v_job.media_manifest->'proxies' else '{}'::jsonb end) proxy
    union
    select coalesce(master.value->>'bucket', 'renders'), master.value->>'object'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'masters') = 'object'
             then v_job.media_manifest->'masters' else '{}'::jsonb end) master
    union
    select coalesce(master.value->>'bucket', 'renders'), master.value->>'transcript'
      from jsonb_each(
        case when jsonb_typeof(v_job.media_manifest->'masters') = 'object'
             then v_job.media_manifest->'masters' else '{}'::jsonb end) master
    union
    select 'sources', substring(v_job.source_url from 11)
     where v_job.source_url like 'storage://%'
  ) as found_path
  where found_path.path is not null
    and found_path.path <> ''
    and found_path.path not like '%..%'
    and found_path.bucket in ('clips', 'sources', 'renders', 'media', 'exports')
  on conflict (bucket, path) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.record_task_storage_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_job uuid;
begin
  if public.purge_in_progress() then return old; end if;
  v_job := old.job_id;
  if v_job is null and old.clip_id is not null then
    select c.job_id into v_job from public.clips c where c.id = old.clip_id;
  end if;

  insert into public.storage_deletions (bucket, path, job_id, user_id)
  select source.bucket, source.path, v_job, old.user_id
  from (
    select coalesce(entry.value->>'bucket', 'renders') as bucket, entry.value->>'object' as path
      from jsonb_each(
        case when jsonb_typeof(old.output->'manifest'->'files') = 'object'
             then old.output->'manifest'->'files' else '{}'::jsonb end) entry
    union
    select coalesce(section.value->>'bucket', 'sources'), section.value->>'object'
      from jsonb_array_elements(
        case when jsonb_typeof(old.output->'manifest'->'sections') = 'array'
             then old.output->'manifest'->'sections' else '[]'::jsonb end) section
    union
    select 'renders', old.output_path
    union
    select coalesce(old.payload->>'bucket', 'exports'), old.payload->>'object'
      where old.kind in ('client_export', 'finalize')
  ) as source
  where source.path is not null and source.path <> '' and source.path not like '%..%'
    and source.bucket in ('clips', 'sources', 'renders', 'media', 'exports')
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;

revoke execute on function public.reserve_upload(text,text,bigint,text,uuid) from public, anon;
grant execute on function public.reserve_upload(text,text,bigint,text,uuid) to authenticated;
revoke execute on function public.upload_usage() from public, anon;
grant execute on function public.upload_usage() to authenticated;
revoke execute on function public.validate_reserved_upload_object() from public, anon, authenticated;
revoke execute on function public.enqueue_job_objects(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_job_objects(uuid) to service_role;
revoke execute on function public.record_task_storage_deletions() from public, anon, authenticated;

commit;
