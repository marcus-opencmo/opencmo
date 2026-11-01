-- 20261231120000: P5 for B4, the post image (docs/plans/cmo/2026-10-28-p5-sessions/A.md, Requests from B).
--
-- The Post image squad makes a small edit (kind `slideshow`, one slide) in the job of the founder's video it takes a
-- frame from, because library files are bound to their job. It queues the still, then records one step that waits on
-- it. When the still is done for the document as it is, the step writes the `image` deliverable for its post and the
-- order is done; no card of its own, the post's card shows the image. The link to the post is
-- `deliverables.post_id`: a post has no deliverable before it is approved, so `parent_id` cannot carry it.

begin;

alter table public.deliverables add column post_id uuid references public.content_items(id) on delete cascade;
alter table public.deliverables add constraint deliverables_post_image_check check ((post_id is not null) = (kind = 'image'));
create index deliverables_post_idx on public.deliverables (post_id) where post_id is not null;

alter table public.studio_steps drop constraint studio_steps_kind_check;
alter table public.studio_steps add constraint studio_steps_kind_check check (kind in ('script', 'price', 'slideshow', 'post_image'));

-- The squad's edit for one post image. In the source video's job when it takes a frame from it (owner checked), else
-- in a job of its own like `create_slideshow`. Brain calls only: the founder makes images in the editor.
create or replace function public.create_post_image_edit(p_name text, p_aspect text, p_source_clip uuid default null)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
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
    insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at)
    values (v_user, 'edit', 'editor://blank', v_name, 'done', p_aspect, 0, 0, now())
    returning id into v_job;
  end if;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, v_idx, v_name, 0, 0, null, null, 'slideshow')
  returning id into v_clip;
  return v_clip;
end;
$$;
revoke all on function public.create_post_image_edit(text, text, uuid) from public, anon;
grant execute on function public.create_post_image_edit(text, text, uuid) to authenticated;

-- Settles a post image step once its still ends: done for the document as it is → the `image` deliverable of its
-- post, and the order is done; failed, or rendered from an older document → the order fails with the reason.
create or replace function public.studio_post_image_settle(p_step uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_step public.studio_steps;
  v_stills public.tasks;
  v_hash text;
  v_why text;
begin
  select * into v_step from public.studio_steps where id = p_step and kind = 'post_image' and status = 'running' for update;
  if not found then
    return;
  end if;
  select * into v_stills from public.tasks where id = (v_step.input->>'stills_task')::uuid;
  if v_stills.status not in ('done', 'failed', 'cancelled') then
    return;
  end if;
  select public.editor_document_hash(document) into v_hash from public.editor_projects where clip_id = v_step.clip_id;
  if v_stills.status <> 'done' then
    v_why := left(coalesce(nullif(v_stills.error, ''), 'The post image could not be drawn.'), 200);
  elsif v_stills.settings_hash is distinct from v_hash then
    v_why := 'The post image changed while it was rendering.';
  end if;
  if v_why is not null then
    update public.studio_steps set status = 'failed', error = v_why where id = v_step.id;
    if exists (select 1 from public.work_orders where id = v_step.order_id and status not in ('done', 'failed', 'cancelled')) then
      perform public.work_order_move(v_step.order_id, 'failed', null, jsonb_build_object('code',
        case when v_stills.status = 'done' then 'document_changed' else 'render_failed' end, 'message', v_why, 'retryable', true));
    end if;
    return;
  end if;
  update public.studio_steps set status = 'done', decided_at = now() where id = v_step.id;
  -- A post may get a new image later; the publish step takes its newest (`created_at`).
  insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status, post_id)
  values (v_step.user_id, v_step.order_id, 'image', 'clip', v_step.clip_id, 'ready', (v_step.input->>'post_id')::uuid)
  on conflict (ref_kind, ref_id) do nothing;
  if exists (select 1 from public.work_orders where id = v_step.order_id and status = 'queued') then
    perform public.work_order_move(v_step.order_id, 'running');
  end if;
  if exists (select 1 from public.work_orders where id = v_step.order_id and status not in ('done', 'failed', 'cancelled')) then
    perform public.work_order_move(v_step.order_id, 'done', 'Post image ready');
  end if;
end;
$$;
revoke all on function public.studio_post_image_settle(uuid) from public, anon, authenticated;

-- The squad's step for one post image (B4), recorded right after it queued the still.
create or replace function public.studio_post_image_rendering(p_order_id uuid, p_clip_id uuid, p_post_id uuid, p_stills_task uuid)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_id uuid;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  v_clip := public.owned_clip(p_clip_id, v_user);
  if v_clip.kind <> 'slideshow' then
    raise exception 'A post image is made in its own edit.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user and kind = 'build_post_image'
                 and status not in ('done', 'failed', 'cancelled')) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.content_items where id = p_post_id and user_id = v_user and department = 'post') then
    raise exception 'Post not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.tasks where id = p_stills_task and user_id = v_user and clip_id = p_clip_id and kind = 'render_stills') then
    raise exception 'Queue the image of this edit first.' using errcode = '22023';
  end if;
  insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status)
  values (v_user, p_clip_id, 'make_post_image', 'post_image',
    jsonb_build_object('post_id', p_post_id, 'stills_task', p_stills_task), '{}', 0, p_order_id, 'running')
  returning id into v_id;
  perform public.studio_post_image_settle(v_id);
  return v_id;
end;
$$;
revoke all on function public.studio_post_image_rendering(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.studio_post_image_rendering(uuid, uuid, uuid, uuid) to authenticated;

-- Renders end: a post image step now settles too.
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
  if new.kind not in ('render_document', 'render_stills') or new.status not in ('done', 'failed') or old.status = new.status
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
  if new.kind <> 'render_document' then
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

-- The runner never takes a post image step either.
create or replace function public.studio_steps_claim(p_limit integer DEFAULT 5) RETURNS SETOF public.studio_steps
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.studio_steps;
begin
  for v_row in
    select s.* from public.studio_steps s
    join public.work_orders o on o.id = s.order_id
    where s.status = 'approved' and s.kind not in ('slideshow', 'post_image') and o.status not in ('done', 'failed', 'cancelled') and not public.cmo_paused(s.user_id)
      and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes')
    order by s.decided_at
    limit greatest(1, least(coalesce(p_limit, 5), 10))
    for update of s skip locked
  loop
    if v_row.claimed_at is not null then
      update public.studio_steps set status = 'failed', error = 'Studio stopped while starting this step.' where id = v_row.id;
      perform public.studio_order_move(v_row.order_id, 'failed', null, jsonb_build_object('code', 'step_interrupted',
        'message', 'Studio stopped while starting a step. Nothing more will run for it.', 'retryable', true));
      continue;
    end if;
    update public.studio_steps set claimed_at = now() where id = v_row.id returning * into v_row;
    perform public.studio_order_move(v_row.order_id, 'running');
    return next v_row;
  end loop;
end;
$$;

commit;
