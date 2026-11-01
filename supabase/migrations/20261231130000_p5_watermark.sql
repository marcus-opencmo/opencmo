-- 20261231130000: P5 fix (from B's B4 run): a slideshow or post image made in a job of its own took the jobs table's
-- default watermark (on), so a paid founder's renders carried the free watermark. Their new job now takes it from the
-- plan, like an upload. A post image made in the source video's job keeps that job's flag. `create_blank_edit` has the
-- same gap from before P5; it is the owner's call and is left as is here.

begin;

create or replace function public.create_slideshow(p_name text DEFAULT NULL::text, p_aspect text DEFAULT '9:16'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_job uuid;
  v_clip uuid;
begin
  if p_aspect is null or p_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Choose a frame: 9:16, 1:1 or 16:9.' using errcode = '22023';
  end if;
  -- Same ceiling as every other way of creating a project.
  if (select count(*) from public.jobs where user_id = v_user and kind = 'edit' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'You have created many edits in the last hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at, watermark)
  values (v_user, 'edit', 'editor://blank', coalesce(v_name, 'Untitled slideshow'), 'done', p_aspect, 0, 0, now(),
    (select coalesce(plan, 'free') = 'free' from public.profiles where id = v_user))
  returning id into v_job;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, -1, coalesce(v_name, 'Untitled slideshow'), 0, 0, null, null, 'slideshow')
  returning id into v_clip;
  return v_clip;
end;
$$;

create or replace function public.create_post_image_edit(p_name text, p_aspect text, p_source_clip uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := coalesce(nullif(left(btrim(coalesce(p_name, '')), 120), ''), 'Post image');
  v_source public.clips;
  v_job uuid;
  v_idx integer := -1;
  v_clip uuid;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  if p_aspect is null or p_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Choose a frame: 9:16, 1:1 or 16:9.' using errcode = '22023';
  end if;
  if (select count(*) from public.jobs where user_id = v_user and kind = 'edit' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'You have created many edits in the last hour. Try again later.' using errcode = 'P0001';
  end if;
  if p_source_clip is not null then
    v_source := public.owned_clip(p_source_clip, v_user);
    v_job := v_source.job_id;
    -- Another edit in the same job: the lowest free index below the job's own clips.
    perform pg_advisory_xact_lock(hashtextextended(v_job::text, 1731));
    select least(-1, min(idx) - 1) into v_idx from public.clips where job_id = v_job;
  else
    insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at, watermark)
    values (v_user, 'edit', 'editor://blank', v_name, 'done', p_aspect, 0, 0, now(),
      (select coalesce(plan, 'free') = 'free' from public.profiles where id = v_user))
    returning id into v_job;
  end if;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, v_idx, v_name, 0, 0, null, null, 'slideshow')
  returning id into v_clip;
  return v_clip;
end;
$$;

commit;
