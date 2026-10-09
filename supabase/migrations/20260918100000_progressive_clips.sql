-- Công bố từng clip bất biến ngay sau upload; editor tiếp tục chuẩn bị sau đó.
create or replace function public.publish_job_clip(p_job_id uuid, p_attempt_id uuid, p_clip jsonb)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_job public.jobs;
  v_clip public.clips;
  v_old public.clips;
  v_path text;
begin
  select * into v_job from public.jobs where id=p_job_id for update;
  if not found or p_attempt_id is null or v_job.status <> 'running'
     or v_job.attempt_id is distinct from p_attempt_id then return false; end if;
  if p_clip is null or jsonb_typeof(p_clip) <> 'object'
     or coalesce(p_clip->>'id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(p_clip->'idx') is distinct from 'number'
     or (p_clip->>'idx') !~ '^[0-9]{1,6}$'
     or jsonb_typeof(p_clip->'start_seconds') is distinct from 'number'
     or jsonb_typeof(p_clip->'end_seconds') is distinct from 'number'
     or (p_clip ? 'score' and p_clip->'score' <> 'null'::jsonb and jsonb_typeof(p_clip->'score') <> 'number') then
    raise exception 'A clip is missing required fields.' using errcode='22023';
  end if;
  if (p_clip->>'start_seconds')::numeric < 0 or (p_clip->>'end_seconds')::numeric <= (p_clip->>'start_seconds')::numeric then
    raise exception 'A clip must end after it starts.' using errcode='22023';
  end if;
  -- Bucket clips: chỉ nhận key tương đối thuộc đúng chủ sở hữu và project.
  if p_clip->>'storage_path' is null then
    raise exception 'Invalid clip storage path.' using errcode='22023';
  end if;
  foreach v_path in array array[p_clip->>'storage_path',p_clip->>'preview_path'] loop
    if v_path is not null and v_path !~ ('^'||v_job.user_id::text||'/'||p_job_id::text||'/[A-Za-z0-9_-]+/[A-Za-z0-9][A-Za-z0-9._-]*$') then
      raise exception 'Invalid clip storage path.' using errcode='22023';
    end if;
  end loop;
  v_clip.id := (p_clip->>'id')::uuid; v_clip.job_id := p_job_id;
  v_clip.idx := (p_clip->>'idx')::int; v_clip.hook := p_clip->>'hook';
  v_clip.start_seconds := (p_clip->>'start_seconds')::numeric;
  v_clip.end_seconds := (p_clip->>'end_seconds')::numeric;
  v_clip.source_start := v_clip.start_seconds; v_clip.source_end := v_clip.end_seconds;
  v_clip.score := (p_clip->>'score')::numeric; v_clip.reason := p_clip->>'reason';
  v_clip.storage_path := p_clip->>'storage_path'; v_clip.preview_path := p_clip->>'preview_path';
  select * into v_old from public.clips where id=v_clip.id;
  if found then
    if row(v_old.job_id,v_old.idx,v_old.hook,v_old.start_seconds,v_old.end_seconds,v_old.score,v_old.reason,v_old.storage_path,v_old.preview_path,v_old.source_start,v_old.source_end)
      is distinct from row(v_clip.job_id,v_clip.idx,v_clip.hook,v_clip.start_seconds,v_clip.end_seconds,v_clip.score,v_clip.reason,v_clip.storage_path,v_clip.preview_path,v_clip.source_start,v_clip.source_end) then
      raise exception 'This clip was already published with different content.' using errcode='22023';
    end if;
    return true;
  end if;
  if exists(select 1 from public.clips where job_id=p_job_id and idx=v_clip.idx) then
    raise exception 'A different clip already exists at this position.' using errcode='22023';
  end if;
  insert into public.clips(id,job_id,idx,hook,start_seconds,end_seconds,score,reason,storage_path,preview_path,source_start,source_end)
    values(v_clip.id,v_clip.job_id,v_clip.idx,v_clip.hook,v_clip.start_seconds,v_clip.end_seconds,v_clip.score,v_clip.reason,v_clip.storage_path,v_clip.preview_path,v_clip.source_start,v_clip.source_end);
  return true;
end; $$;
revoke execute on function public.publish_job_clip(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_job_clip(uuid,uuid,jsonb) to service_role;

-- Chốt danh sách clip gốc tại thời điểm yêu cầu, không cần export trong editor.
create or replace function public.request_original_zip(p_job_id uuid,p_clip_ids uuid[],p_request_id uuid)
returns public.tasks language plpgsql volatile security definer set search_path=public as $$
declare
  v_user uuid := public.require_user();
  v_items jsonb;
  v_task public.tasks;
  v_count int;
begin
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  if p_clip_ids is null or cardinality(p_clip_ids)=0 then raise exception 'Choose at least one clip.' using errcode='22023'; end if;
  if cardinality(p_clip_ids)>10 then raise exception 'Choose at most 10 clips.' using errcode='22023'; end if;
  if (select count(distinct id) from unnest(p_clip_ids) id) <> cardinality(p_clip_ids) then
    raise exception 'Choose each clip only once.' using errcode='22023';
  end if;
  if not exists(select 1 from public.jobs where id=p_job_id and user_id=v_user) then
    raise exception 'Project not found.' using errcode='P0002';
  end if;
  select count(*),jsonb_agg(c.id::text order by c.id) into v_count,v_items
    from public.clips c join public.jobs j on j.id=c.job_id
    where c.id=any(p_clip_ids) and c.job_id=p_job_id and j.user_id=v_user and c.storage_path is not null;
  if v_count <> cardinality(p_clip_ids) then
    raise exception 'One or more clips are not ready to download.' using errcode='P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,1701));
  select * into v_task from public.tasks where request_id=p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'zip' or v_task.job_id is distinct from p_job_id
       or v_task.payload is distinct from jsonb_build_object('clip_ids',v_items) then
      raise exception 'This request id was already used for something else.' using errcode='22023';
    end if;
    return v_task;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,1702));
  if (select count(*) from public.tasks where user_id=v_user and kind in ('preview','export','zip') and status in ('queued','running')) >= 20 then
    raise exception 'You already have 20 downloads or renders in progress. Please wait for one to finish.' using errcode='P0001';
  end if;
  perform public.consume_daily_task_quota('export');
  insert into public.tasks(user_id,kind,job_id,payload,request_id)
    values(v_user,'zip',p_job_id,jsonb_build_object('clip_ids',v_items),p_request_id) returning * into v_task;
  return v_task;
end; $$;
revoke execute on function public.request_original_zip(uuid,uuid[],uuid) from public,anon;
grant execute on function public.request_original_zip(uuid,uuid[],uuid) to authenticated;
