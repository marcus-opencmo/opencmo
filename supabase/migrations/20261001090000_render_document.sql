-- Export trên server (spec editor-rewrite §7, giai đoạn A4): worker vẽ document
-- bằng `packages/clip-export` thay vì trình duyệt encode rồi upload.
--
-- Task `render_document` xếp hàng NGAY (`queued`), không qua `awaiting_upload`.
-- Cùng quota, cùng trần 20 việc đang chạy, cùng object canonical trong bucket
-- `exports` như export phía trình duyệt: hai đường là hai cách làm ra CÙNG một
-- file giao khách, nên chúng đếm chung.
--
-- Payload chụp luôn manifest thư viện của project lúc bấm Export: B-roll và
-- media sinh bằng AI được document tham chiếu qua manifest, và người dùng sửa
-- thư viện sau khi bấm không được đổi thứ đang xuất.

begin;

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check
  check (kind in ('preview', 'export', 'probe_media', 'zip', 'client_export', 'finalize', 'generate',
                  'render_document'));

create or replace function public.request_document_export(
  p_clip_id uuid,
  p_revision_id uuid,
  p_request_id uuid,
  p_resolution int default 1080
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
  v_manifest jsonb;
  v_job_id uuid;
  v_task public.tasks;
  v_task_id uuid := gen_random_uuid();
  v_object text;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_resolution is null or p_resolution not in (720, 1080) then
    raise exception 'Choose 720p or 1080p.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);
  select r.* into v_revision
  from public.editor_revisions r
  where r.id = p_revision_id and r.clip_id = p_clip_id;
  if not found then
    raise exception 'Save the project before exporting it.' using errcode = 'P0002';
  end if;
  select c.job_id into v_job_id from public.clips c where c.id = p_clip_id;
  select p.manifest into v_manifest from public.editor_projects p where p.clip_id = p_clip_id;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user
       or v_task.kind <> 'render_document'
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
        and kind in ('preview', 'export', 'client_export', 'finalize', 'render_document')
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
    v_task_id, v_user, 'render_document', p_clip_id, p_revision_id,
    v_revision.source_hash, v_job_id,
    jsonb_build_object(
      'bucket', 'exports',
      'object', v_object,
      'editor_revision_id', p_revision_id,
      'source_hash', v_revision.source_hash,
      'resolution', p_resolution,
      'manifest', coalesce(v_manifest, '{"version":1,"folders":[],"assets":[]}'::jsonb)
    ),
    'queued', p_request_id
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
     or v_task.kind <> 'render_document'
     or v_task.clip_id is distinct from p_clip_id
     or v_task.editor_revision_id is distinct from p_revision_id then
    raise exception 'This request id was already used for something else.' using errcode = '22023';
  end if;
  return v_task;
end;
$$;

revoke execute on function public.request_document_export(uuid, uuid, uuid, int) from public, anon;
grant execute on function public.request_document_export(uuid, uuid, uuid, int) to authenticated;

-- Retention: object trong `exports` của task mới cũng phải được dọn theo job
-- và khi xoá task — y như hai kind export phía trình duyệt.
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
       and t.kind in ('client_export', 'finalize', 'render_document')
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
      where old.kind in ('client_export', 'finalize', 'render_document')
  ) as source
  where source.path is not null and source.path <> '' and source.path not like '%..%'
    and source.bucket in ('clips', 'sources', 'renders', 'media', 'exports')
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;

commit;
