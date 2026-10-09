-- Fencing cho artifact và draft: attempt cũ không được xuất bản dữ liệu mới.
alter table public.artifacts add column attempt_id uuid;
create unique index artifacts_attempt_idx on public.artifacts(job_id, kind, attempt_id);

-- Biên nhận riêng giữ nguyên đầu vào khi retry sau khi mất response.
create table public.worker_draft_initializations (
  job_id uuid not null references public.jobs(id) on delete cascade,
  attempt_id uuid not null,
  revisions jsonb not null,
  primary key (job_id, attempt_id)
);
alter table public.worker_draft_initializations enable row level security;
revoke all on public.worker_draft_initializations from public, anon, authenticated;
grant all on public.worker_draft_initializations to service_role;

drop function public.put_artifact(uuid, text, jsonb);
create function public.put_artifact(p_job_id uuid, p_attempt_id uuid, p_kind text, p_data jsonb)
returns public.artifacts language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
  v_artifact public.artifacts;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null or v_job.attempt_id is distinct from p_attempt_id
     or v_job.status not in ('running', 'done') then
    raise exception 'This processing attempt is no longer active.' using errcode = 'P0001';
  end if;
  select * into v_artifact from public.artifacts
  where job_id = p_job_id and kind = p_kind and attempt_id = p_attempt_id;
  if found then
    if v_artifact.data is distinct from p_data then
      raise exception 'This artifact was already saved with different content.' using errcode = '22023';
    end if;
    return v_artifact;
  end if;
  insert into public.artifacts(job_id, kind, version, data, attempt_id)
  select p_job_id, p_kind, coalesce(max(version), 0) + 1, p_data, p_attempt_id
  from public.artifacts where job_id = p_job_id and kind = p_kind
  returning * into v_artifact;
  return v_artifact;
end;
$$;

drop function public.create_clip_drafts(uuid, jsonb);
create function public.create_clip_drafts(p_job_id uuid, p_attempt_id uuid, p_revisions jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
  v_previous jsonb;
  v_created int;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null or v_job.attempt_id is distinct from p_attempt_id
     or v_job.status not in ('running', 'done') then
    raise exception 'This processing attempt is no longer active.' using errcode = 'P0001';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be an array.' using errcode = '22023';
  end if;
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found then
    if v_previous is distinct from p_revisions then
      raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
    end if;
    return 0;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_revisions) item
    where not exists (select 1 from public.clips c
      where c.id = (item ->> 'clip_id')::uuid and c.job_id = p_job_id)
  ) then
    raise exception 'A clip does not belong to this project.' using errcode = '22023';
  end if;
  with wanted as (
    select (item ->> 'clip_id')::uuid clip_id, item -> 'settings' settings,
      item ->> 'settings_hash' settings_hash from jsonb_array_elements(p_revisions) item
  ), made as (
    insert into public.clip_revisions(clip_id, number, settings, settings_hash)
    select w.clip_id, 1, w.settings, w.settings_hash from wanted w
    where not exists (select 1 from public.clip_drafts d where d.clip_id = w.clip_id)
    returning id, clip_id
  )
  insert into public.clip_drafts(clip_id, revision_id) select clip_id, id from made;
  get diagnostics v_created = row_count;
  insert into public.worker_draft_initializations values(p_job_id, p_attempt_id, p_revisions);
  return v_created;
end;
$$;

-- Chốt probe lặp lại chỉ hợp lệ với cùng attempt và cùng kết quả đã lưu.
create or replace function public.complete_media_probe(
  p_asset_id uuid, p_attempt_id uuid, p_duration numeric, p_width int,
  p_height int, p_ok boolean, p_error text default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_task public.tasks;
  v_error text := case when p_ok then null
    else left(coalesce(p_error, 'We could not read this media file.'), 2000) end;
begin
  if p_attempt_id is null or p_ok is null then return false; end if;
  select * into v_task from public.tasks
  where kind = 'probe_media' and asset_id = p_asset_id and attempt_id = p_attempt_id
  for update;
  if not found then return false; end if;
  if v_task.status in ('done', 'failed') then
    return v_task.status = case when p_ok then 'done' else 'failed' end
      and v_task.duration is not distinct from p_duration
      and v_task.width is not distinct from p_width
      and v_task.height is not distinct from p_height
      and v_task.error is not distinct from v_error;
  end if;
  if v_task.status <> 'running' then return false; end if;
  update public.tasks set status = case when p_ok then 'done' else 'failed' end,
    duration = p_duration, width = p_width, height = p_height, error = v_error,
    finished_at = now(), lease_until = null where id = v_task.id;
  update public.media_assets set status = case when p_ok then 'ready' else 'rejected' end,
    duration = p_duration, width = p_width, height = p_height, error = left(v_error, 500)
  where id = p_asset_id;
  return true;
end;
$$;
revoke execute on function public.put_artifact(uuid, uuid, text, jsonb),
  public.create_clip_drafts(uuid, uuid, jsonb),
  public.complete_media_probe(uuid, uuid, numeric, int, int, boolean, text)
  from public, anon, authenticated;
grant execute on function public.put_artifact(uuid, uuid, text, jsonb),
  public.create_clip_drafts(uuid, uuid, jsonb),
  public.complete_media_probe(uuid, uuid, numeric, int, int, boolean, text)
  to service_role;
