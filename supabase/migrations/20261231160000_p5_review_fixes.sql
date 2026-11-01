-- P5 review fixes (PR #127, code review 2026-10-31). Each block names the finding it fixes.

-- #1 A slideshow edited after its card was raised: nothing rendered it again, so the card stayed undecidable
-- ("This card changed") and its order waited forever. The founder (or the card, after a quick text edit) queues a
-- new MP4 and PNG set of the document as it is, and this puts the step back to rendering on them: the waiting card
-- closes, and `studio_slideshow_settle` raises a new one when both are done. The order keeps waiting on the
-- founder meanwhile; it is not handed back to the runner, which would build a second slideshow.
create function public.studio_slideshow_rerender(p_step uuid, p_mp4_task uuid, p_stills_task uuid, p_card jsonb)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_step public.studio_steps;
  v_hash text;
begin
  select * into v_step from public.studio_steps where id = p_step and user_id = v_user and kind = 'slideshow' for update;
  if not found then
    raise exception 'Slideshow not found.' using errcode = 'P0002';
  end if;
  if v_step.status <> 'waiting' then
    raise exception 'This slideshow is not waiting on you, so there is nothing to render again.' using errcode = 'P0001';
  end if;
  if p_card is null or jsonb_typeof(p_card) <> 'object' or jsonb_typeof(p_card->'slides') is distinct from 'array'
     or jsonb_array_length(p_card->'slides') not between 1 and 20 then
    raise exception 'This step is malformed.' using errcode = '22023';
  end if;
  select public.editor_document_hash(document) into v_hash from public.editor_projects where clip_id = v_step.clip_id;
  if not exists (select 1 from public.tasks where id = p_mp4_task and user_id = v_user and clip_id = v_step.clip_id
                   and kind = 'render_document' and settings_hash = v_hash)
     or not exists (select 1 from public.tasks where id = p_stills_task and user_id = v_user and clip_id = v_step.clip_id
                   and kind = 'render_stills' and settings_hash = v_hash) then
    raise exception 'Queue the MP4 and the PNG set of the slideshow as it is now first.' using errcode = '22023';
  end if;
  -- Leaving `waiting` closes the old card (`studio_steps_sync`); the new card keeps its captions from the clip.
  update public.studio_steps
  set status = 'running',
      input = input || jsonb_build_object('mp4_task', p_mp4_task, 'stills_task', p_stills_task),
      card = p_card
  where id = v_step.id;
  perform public.studio_slideshow_settle(v_step.id);
  return v_step.id;
end;
$$;
revoke all on function public.studio_slideshow_rerender(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.studio_slideshow_rerender(uuid, uuid, uuid, jsonb) to authenticated;

-- #2 A waiting slideshow card refreshed after an edit (new captions call approval_refresh) took the new document
-- hash while its MP4 and stills still showed the old words. Approving finishes only renders of the document as it is.
create function public.studio_slideshow_fresh() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.kind = 'slideshow' and old.status = 'waiting' and new.status = 'done' and new.input ? 'mp4_task'
     and (select settings_hash from public.tasks where id = (new.input->>'mp4_task')::uuid)
       is distinct from (select public.editor_document_hash(document) from public.editor_projects where clip_id = new.clip_id) then
    raise exception 'The slideshow changed since it was rendered. Render it again.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.studio_slideshow_fresh() from public, anon, authenticated;
create trigger studio_slideshow_fresh before update of status on public.studio_steps
for each row execute function public.studio_slideshow_fresh();

-- #3 A cancelled MP4 or still (the founder cancels the export, or the job is cancelled) never settled its slideshow or
-- post image step, though both settle functions handle `cancelled`: the step stayed running, the order stuck.
create or replace function public.tasks_studio_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_short public.shorts;
  v_order uuid;
  v_user uuid;
  v_step uuid;
  v_kind text;
begin
  if new.kind not in ('render_document', 'render_stills') or new.status not in ('done', 'failed', 'cancelled') or old.status = new.status
     or new.clip_id is null then
    return new;
  end if;
  -- A slideshow step waiting on its two renders (P5 S3): its card is raised once both are done. A post image step
  -- (P5 S3, B4) waits on its still only and needs no card: its post's card shows it.
  select s.id, s.kind into v_step, v_kind from public.studio_steps s
  where s.kind in ('slideshow', 'post_image') and s.status = 'running' and s.clip_id = new.clip_id
    and (s.input->>'mp4_task' = new.id::text or s.input->>'stills_task' = new.id::text);
  if v_step is not null then
    begin
      if v_kind = 'post_image' then
        perform public.studio_post_image_settle(v_step);
      else
        perform public.studio_slideshow_settle(v_step);
      end if;
    exception when others then
      raise warning 'slideshow render rule failed for task %: %', new.id, sqlerrm;
    end;
    return new;
  end if;
  -- A cancelled render settles a slideshow or post image step (above); shorts and long videos keep their rules.
  if new.kind <> 'render_document' or new.status = 'cancelled' then
    return new;
  end if;
  begin
    select * into v_short from public.shorts where short_clip_id = new.clip_id;
    if found then
      if v_short.status = 'rendering' then
        update public.shorts set status = case new.status when 'done' then 'ready' else 'failed' end where id = v_short.id;
      end if;
      perform public.short_batch_settle(v_short.batch_id);
      return new;
    end if;

    -- A long video an order is making, once the order has reached its render (a step whose next is the render):
    -- the founder's own exports of the edit before that neither raise card 3 nor fail the order.
    select s.order_id, s.user_id into v_order, v_user from public.studio_steps s
    join public.work_orders o on o.id = s.order_id
    where s.clip_id = new.clip_id and o.kind = 'build_video' and o.status not in ('done', 'failed', 'cancelled')
      and s.next->>'tool' = 'render'
    order by s.created_at desc limit 1;
    if v_order is null then
      return new;
    end if;
    if new.status = 'done' then
      if new.settings_hash = (select public.editor_document_hash(document) from public.editor_projects where clip_id = new.clip_id) then
        perform public.approval_raise(v_user, 'editor_project', new.clip_id);
        perform public.work_order_wait_founder(v_order, 'Your video is rendered');
      end if;
    else
      perform public.work_order_move(v_order, 'failed', null, jsonb_build_object('code', 'render_failed',
        'message', left(coalesce(nullif(new.error, ''), 'The render failed.'), 200), 'retryable', true));
    end if;
  exception when others then
    raise warning 'studio render rule failed for task %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- #4 Renaming a post image edit (a `slideshow` clip inside the upload's job) renamed the upload itself.
create or replace function public.rename_blank_edit(p_clip_id uuid, p_name text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := left(btrim(coalesce(p_name, '')), 120);
  v_clip public.clips;
begin
  if v_name = '' then
    raise exception 'Give the edit a name.' using errcode = '22023';
  end if;
  v_clip := public.owned_clip(p_clip_id, v_user);
  if v_clip.kind not in ('blank', 'slideshow') then
    raise exception 'Only edits started from a blank canvas can be renamed here.' using errcode = '22023';
  end if;
  update public.clips set hook = v_name where id = v_clip.id;
  -- A post image edit lives in the job of the video it was cut from: its name must not rename the founder's upload.
  if not exists (select 1 from public.clips where job_id = v_clip.job_id and id <> v_clip.id) then
    update public.jobs set title = v_name where id = v_clip.job_id;
  end if;
  return v_name;
end;
$$;

-- #5 The Slideshow and Post image squads spent the founder's daily export limit (5 a day on the free plan), so the
-- founder's own Export could be refused (owner, 2026-10-31: CMO renders do not count; the in-progress cap does).
-- #10 The document export now counts still exports in the 20-in-progress cap, as the still export already did.
create or replace function public.request_document_export(p_clip_id uuid, p_revision_id uuid, p_request_id uuid, p_resolution integer DEFAULT 1080) RETURNS public.tasks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  v_counted boolean := false;
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
        and kind in ('preview', 'export', 'client_export', 'finalize', 'render_document', 'render_stills')
        and status in ('awaiting_upload', 'queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  -- Renders OpenCMO orders itself (its Studio squads) do not spend the founder's daily exports; the cap above holds.
  if not public.studio_brain_call() then
    select coalesce(plan, 'free') into v_plan
    from public.profiles where id = v_user;
    select * into v_quota from public.plan_quota(v_plan);
    if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
      raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
    end if;
    v_counted := true;
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
    if v_counted then
      perform public.release_rate_limit_for(v_user, 'export', now());
    end if;
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

create or replace function public.request_stills_export(p_clip_id uuid, p_revision_id uuid, p_request_id uuid) RETURNS public.tasks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_plan text;
  v_quota record;
  v_revision public.editor_revisions;
  v_manifest jsonb;
  v_job_id uuid;
  v_task public.tasks;
  v_task_id uuid := gen_random_uuid();
  v_prefix text;
  v_counted boolean := false;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  perform public.owned_clip(p_clip_id, v_user);
  select r.* into v_revision from public.editor_revisions r where r.id = p_revision_id and r.clip_id = p_clip_id;
  if not found then
    raise exception 'Save the project before exporting it.' using errcode = 'P0002';
  end if;
  select c.job_id into v_job_id from public.clips c where c.id = p_clip_id;
  select p.manifest into v_manifest from public.editor_projects p where p.clip_id = p_clip_id;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1701));
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'render_stills'
       or v_task.clip_id is distinct from p_clip_id or v_task.editor_revision_id is distinct from p_revision_id then
      raise exception 'This export request was already used for another clip or revision.' using errcode = '22023';
    end if;
    return v_task;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1702));
  if (select count(*) from public.tasks
      where user_id = v_user
        and kind in ('preview', 'export', 'client_export', 'finalize', 'render_document', 'render_stills')
        and status in ('awaiting_upload', 'queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.' using errcode = 'P0001';
  end if;
  if not public.studio_brain_call() then
    select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
    select * into v_quota from public.plan_quota(v_plan);
    if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
      raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
    end if;
    v_counted := true;
  end if;

  v_prefix := v_user::text || '/' || p_clip_id::text || '/' || v_task_id::text;
  insert into public.tasks (id, user_id, kind, clip_id, editor_revision_id, settings_hash, job_id, payload, status, request_id)
  values (v_task_id, v_user, 'render_stills', p_clip_id, p_revision_id, v_revision.source_hash, v_job_id,
    jsonb_build_object('bucket', 'exports', 'object', v_prefix || '.zip', 'still_prefix', v_prefix,
      'editor_revision_id', p_revision_id, 'source_hash', v_revision.source_hash,
      'manifest', coalesce(v_manifest, '{"version":1,"folders":[],"assets":[]}'::jsonb)),
    'queued', p_request_id)
  on conflict do nothing
  returning * into v_task;
  if not found then
    if v_counted then
      perform public.release_rate_limit_for(v_user, 'export', now());
    end if;
    raise exception 'Could not start the export. Please try again.' using errcode = 'P0001';
  end if;
  return v_task;
end;
$$;

-- #8 buildSlideshow was not idempotent: every retry after a failure made another slideshow job and clip.
drop function public.create_slideshow(text, text);
create function public.create_slideshow(p_name text DEFAULT NULL::text, p_aspect text DEFAULT '9:16'::text, p_order uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_job uuid;
  v_clip uuid;
begin
  -- One edit per Slideshow order: a retry after a failed render reuses it instead of making another slideshow.
  if p_order is not null then
    if not public.studio_brain_call() then
      raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
    end if;
    select c.id into v_clip
    from public.work_orders o
    join public.clips c on c.kind = 'slideshow'
      and c.id = case when o.brief->>'clip_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (o.brief->>'clip_id')::uuid end
    join public.jobs j on j.id = c.job_id and j.user_id = v_user
    where o.id = p_order and o.user_id = v_user and o.kind = 'build_slideshow';
    if v_clip is not null then
      return v_clip;
    end if;
    if not exists (select 1 from public.work_orders where id = p_order and user_id = v_user and kind = 'build_slideshow'
                   and status not in ('done', 'failed', 'cancelled')) then
      raise exception 'Order not found.' using errcode = 'P0002';
    end if;
  end if;
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
  if p_order is not null then
    -- The brief is capped at 4 KB: a full one keeps working, without the reuse.
    update public.work_orders set brief = brief || jsonb_build_object('clip_id', v_clip), updated_at = now()
    where id = p_order and octet_length((brief || jsonb_build_object('clip_id', v_clip))::text) <= 4096;
  end if;
  return v_clip;
end;
$$;
revoke all on function public.create_slideshow(text, text, uuid) from public, anon;
grant execute on function public.create_slideshow(text, text, uuid) to authenticated;
