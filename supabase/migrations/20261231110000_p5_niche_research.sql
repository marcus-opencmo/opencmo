-- 20261231110000: P5 A2 (R2), niche video research (docs/plans/cmo/2026-10-28-p5-research-sales-slides-plan.md F7, F8).
--
-- A Research job, priced and limited like competitor research. The week plan orders it once a week when it has a
-- new video item and no research from the last six days, and that week's video briefs wait on it; when it ends (done or not) the briefs start, and Writer's
-- brief carries the links of the niche videos it learned from into the video order (`brief.sources`).

begin;

alter table public.cmo_runs drop constraint cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan', 'competitor_research', 'pull_metrics', 'summarize_memory', 'review_week', 'write_caption', 'write_video_brief', 'write_slides', 'publish_post', 'niche_video_research'));

create or replace function public.cmo_job_daily_limit(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 when 'review_week' then 1
    when 'write_caption' then 20 when 'write_video_brief' then 5 when 'write_slides' then 10 when 'publish_post' then 100 when 'niche_video_research' then 2
    else 0 end
$$;

create or replace function public.cmo_job_price(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 when 'review_week' then 0
    when 'write_caption' then 1 when 'write_video_brief' then 1 when 'write_slides' then 1 when 'publish_post' then 0 when 'niche_video_research' then 2
    else 0 end
$$;

create or replace function public.work_order_for_run(p_run public.cmo_runs) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_row public.work_orders;
  v_root public.work_orders;
  v_source text := p_run.input->>'source';
begin
  select * into v_row from public.work_orders where run_id = p_run.id limit 1;
  if found or p_run.kind in ('onboard', 'plan_week') then
    return v_row;
  end if;
  if coalesce(p_run.input->>'order_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.work_orders set run_id = p_run.id, updated_at = now()
    where id = (p_run.input->>'order_id')::uuid and user_id = p_run.user_id and kind = p_run.kind
      and run_id is null and status in ('queued', 'deferred')
    returning * into v_row;
    if found then
      return v_row;
    end if;
  end if;
  select * into v_root from public.work_orders
  where user_id = p_run.user_id and parent_id is null and week = date_trunc('week', current_date)::date;
  if not found then
    return null;
  end if;
  select * into v_row from public.work_orders
  where root_id = v_root.id and kind = p_run.kind and run_id is null and status in ('queued', 'deferred')
  order by due_at nulls last, created_at
  limit 1
  for update skip locked;
  if not found then
    v_row := public.work_order_create(p_run.user_id, v_root.week, v_root.id, p_run.kind,
      case p_run.kind
        when 'post_draft' then 'Draft a post' when 'sales_scan' then coalesce(p_run.input->>'brief', 'Scan Reddit')
        when 'competitor_research' then 'Competitor research' when 'niche_video_research' then 'What works on video in your niche' when 'pull_metrics' then 'Pull post metrics'
        when 'summarize_memory' then 'Weekly memory' when 'review_week' then 'Sunday review' else p_run.kind end,
      jsonb_build_object('objective', coalesce(p_run.input->>'brief', p_run.kind)), 0, null, '{}',
      case when v_source in ('chat', 'mcp') then v_source when v_source = 'schedule' then 'loop' else 'founder' end);
  end if;
  update public.work_orders set run_id = p_run.id, updated_at = now() where id = v_row.id returning * into v_row;
  return v_row;
end;
$_$;

create or replace function public.work_orders_plan_week(p_user uuid, p_run uuid) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_week date := date_trunc('week', current_date)::date;
  v_root public.work_orders;
  v_item record;
  v_free integer;
  v_price integer;
  v_brief public.work_orders;
  v_due timestamptz;
  v_run public.cmo_runs;
  v_niche public.work_orders;
begin
  v_root := public.work_order_week_root(p_user);
  update public.work_orders set run_id = coalesce(run_id, p_run), updated_at = now() where id = v_root.id returning * into v_root;
  if v_root.status = 'queued' then
    v_root := public.work_order_move(v_root.id, 'running', 'Planned the week');
  end if;

  -- Posts and Reddit scans whose calendar item the new plan deleted.
  for v_item in
    select id from public.work_orders where root_id = v_root.id and item_id is null and run_id is null
      and kind in ('post_draft', 'sales_scan') and status = 'queued' and created_by = 'loop' and id <> v_root.id
  loop
    perform public.work_order_move(v_item.id, 'cancelled', 'Dropped from the new plan');
  end loop;
  -- The replan deleted the item of a video already ordered (its order lost `item_id`, whether under way or still
  -- waiting on its brief): a new video item is that same video, not a second one this week.
  for v_item in
    select c.id from public.content_items c
    where c.user_id = p_user and c.run_id = p_run and c.status = 'planned' and c.department = 'video'
      and c.clip_id is null and not exists (select 1 from public.work_orders o where o.item_id = c.id)
    order by c.day, c.created_at
  loop
    update public.work_orders set item_id = v_item.id, updated_at = now()
    where id = (select id from public.work_orders where root_id = v_root.id and kind = 'build_video' and item_id is null
                  and status not in ('done', 'failed', 'cancelled') order by created_at limit 1);
  end loop;
  -- Videos the new plan dropped that have not started.
  for v_item in
    select id from public.work_orders where root_id = v_root.id and item_id is null and run_id is null
      and kind = 'build_video' and status = 'queued' and created_by = 'loop'
  loop
    perform public.work_order_move(v_item.id, 'cancelled', 'Dropped from the new plan');
  end loop;
  -- A brief not started yet whose every video was dropped, and its run, which would still run and charge.
  for v_item in
    select b.id from public.work_orders b
    where b.root_id = v_root.id and b.kind = 'write_video_brief' and b.status in ('queued', 'deferred')
      and not exists (select 1 from public.work_orders v where v.root_id = v_root.id and b.id = any(v.depends_on)
                      and v.status not in ('done', 'failed', 'cancelled'))
  loop
    perform public.work_order_move(v_item.id, 'cancelled', 'Its video was dropped from the new plan');
    for v_run in
      update public.cmo_runs set status = 'failed', error = 'Its video was dropped from the new plan.', finished_at = now(),
        lease_until = null
      where user_id = p_user and kind = 'write_video_brief' and status = 'queued' and input->>'order_id' = v_item.id::text
      returning *
    loop
      perform public.cmo_refund_run(v_run);
    end loop;
  end loop;

  -- Niche video research (P5 R2): once a week, when the plan has a new video item. Its briefs wait on it, so Writer
  -- cites what works on video in the founder's niche; a research run that cannot start leaves them to go on alone.
  if exists (select 1 from public.content_items c
             where c.user_id = p_user and c.run_id = p_run and c.status = 'planned' and c.department = 'video'
               and c.clip_id is null and not exists (select 1 from public.work_orders o where o.item_id = c.id))
     and not exists (select 1 from public.work_orders where root_id = v_root.id and kind = 'niche_video_research'
                     and status not in ('failed', 'cancelled'))
     -- Research from the last six days is still fresh: the briefs read it, nothing is paid twice.
     and not exists (select 1 from public.cmo_insights where user_id = p_user and kind = 'niche_video'
                     and created_at > now() - interval '6 days') then
    v_free := v_root.budget_credits - v_root.spent_credits - coalesce((
      select sum(budget_credits - spent_credits) from public.work_orders
      where parent_id = v_root.id and status not in ('done', 'failed', 'cancelled')), 0);
    v_price := public.cmo_job_price('niche_video_research');
    v_niche := public.work_order_create(p_user, v_week, v_root.id, 'niche_video_research', 'What works on video in your niche',
      jsonb_build_object('objective', 'Find what works on short video in the founder''s niche.',
        'done_when', 'The week''s video briefs can cite standout videos.'),
      least(v_price, greatest(v_free, 0)), null, '{}', 'loop');
    perform public.writer_order_start(v_niche, '{}'::jsonb);
  end if;
  select * into v_niche from public.work_orders where root_id = v_root.id and kind = 'niche_video_research'
    and status not in ('done', 'failed', 'cancelled') order by created_at desc limit 1;

  for v_item in
    select c.id, c.department, c.idea, c.reason, c.platform, c.day from public.content_items c
    where c.user_id = p_user and c.run_id = p_run and c.status = 'planned' and c.department in ('post', 'sales', 'video')
      and c.clip_id is null and not exists (select 1 from public.work_orders o where o.item_id = c.id)
    order by c.day, c.created_at
  loop
    v_free := v_root.budget_credits - v_root.spent_credits - coalesce((
      select sum(budget_credits - spent_credits) from public.work_orders
      where parent_id = v_root.id and status not in ('done', 'failed', 'cancelled')), 0);
    v_due := (v_item.day + interval '23 hours 59 minutes') at time zone 'UTC';
    if v_item.department = 'video' then
      -- Videos that took over an order were matched above and have their order now; this one is new.
      v_price := public.cmo_job_price('write_video_brief');
      v_brief := public.work_order_create(p_user, v_week, v_root.id, 'write_video_brief',
        left('Brief for “' || v_item.idea || '”', 200),
        jsonb_build_object('objective', v_item.idea, 'reason', coalesce(v_item.reason, ''), 'platform', v_item.platform,
          'done_when', 'Studio has the brief for this video.'),
        least(v_price, greatest(v_free, 0)), v_due, case when v_niche.id is null then '{}'::uuid[] else array[v_niche.id] end, 'loop');
      perform public.work_order_create(p_user, v_week, v_root.id, 'build_video', v_item.idea,
        jsonb_build_object('objective', v_item.idea, 'angle', coalesce(v_item.reason, ''), 'seconds', 30, 'aspect', '9:16',
          'platform', v_item.platform, 'done_when', 'The founder approved the finished video.'),
        least(public.studio_video_budget(), greatest(v_free - least(v_price, greatest(v_free, 0)), 0)), v_due,
        array[v_brief.id], 'loop', v_item.id);
      -- With research under way, the brief starts when it ends (`work_orders_brief_rules`).
      if v_niche.id is null then
        perform public.writer_order_start(v_brief, jsonb_build_object('idea', v_item.idea, 'reason', coalesce(v_item.reason, ''),
          'seconds', 30, 'aspect', '9:16', 'platform', v_item.platform));
      end if;
      continue;
    end if;
    v_price := public.cmo_job_price(case v_item.department when 'post' then 'post_draft' else 'sales_scan' end);
    -- Past the weekly budget the order is still planned, with nothing to spend: it shows as over budget.
    perform public.work_order_create(p_user, v_week, v_root.id,
      case v_item.department when 'post' then 'post_draft' else 'sales_scan' end, v_item.idea,
      jsonb_build_object('objective', v_item.idea, 'done_when',
        case v_item.department when 'post' then 'A draft waits on the founder''s card.' else 'Threads worth a reply wait on cards.' end),
      least(v_price, greatest(v_free, 0)), v_due, '{}', 'loop', v_item.id);
  end loop;

  if not exists (select 1 from public.work_orders where root_id = v_root.id and kind = 'review_week') then
    perform public.work_order_create(p_user, v_week, v_root.id, 'review_week', 'Sunday review',
      jsonb_build_object('objective', 'Measure the week against its goal and propose the next one.'),
      0, (v_week + 6)::timestamptz + interval '12 hours');
  end if;
  return v_root;
end;
$$;

create or replace function public.work_orders_brief_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_brief jsonb;
  v_sources jsonb;
  v_video public.work_orders;
begin
  if new.kind not in ('write_video_brief', 'write_slides', 'niche_video_research') or new.status = old.status or new.status not in ('done', 'failed', 'cancelled') then
    return new;
  end if;
  -- Niche research ended, however it ended: the video briefs waiting on it start now (P5 R2), with the plan's input.
  if new.kind = 'niche_video_research' then
    for v_video in
      select * from public.work_orders where user_id = new.user_id and new.id = any(depends_on) and status = 'queued'
        and kind = 'write_video_brief' for update
    loop
      update public.work_orders set depends_on = array_remove(depends_on, new.id), updated_at = now()
      where id = v_video.id returning * into v_video;
      perform public.writer_order_start(v_video, jsonb_build_object('idea', v_video.brief->>'objective',
        'reason', coalesce(v_video.brief->>'reason', ''), 'seconds', 30, 'aspect', '9:16', 'platform', v_video.brief->>'platform'));
    end loop;
    return new;
  end if;
  -- Writer's slides (P5 S3) go into the slideshow order waiting on them, as the video brief goes into its video.
  if new.kind = 'write_slides' then
    begin
      if new.status = 'done' then
        select r.output into v_brief from public.cmo_runs r where r.id = new.run_id;
        if jsonb_typeof(v_brief->'slides') is distinct from 'array' or jsonb_array_length(v_brief->'slides') not between 1 and 20
           or octet_length((v_brief->'slides')::text) > 16384 then
          v_brief := null;
        end if;
      end if;
      for v_video in
        select * from public.work_orders where user_id = new.user_id and new.id = any(depends_on) and status = 'queued'
          and kind = 'build_slideshow' for update
      loop
        if v_brief is not null then
          update public.work_orders
          set brief = (brief - array['slides', 'slides_reason'])
                || jsonb_strip_nulls(jsonb_build_object('slides', v_brief->'slides', 'slides_reason', v_brief->>'reason',
                     'brief_from', 'writer')),
              updated_at = now()
          where id = v_video.id;
          perform public.work_order_event(v_video, 'note', 'Writer wrote the slides for “' || v_video.title || '”');
        else
          update public.work_orders set depends_on = array_remove(depends_on, new.id), updated_at = now() where id = v_video.id;
          perform public.work_order_event(v_video, 'note', '“' || v_video.title || '” goes on without Writer''s slides');
        end if;
      end loop;
    exception when others then
      raise warning 'slides rule for order % failed: %', new.id, sqlerrm;
      update public.work_orders set depends_on = array_remove(depends_on, new.id), updated_at = now()
      where user_id = new.user_id and new.id = any(depends_on) and status = 'queued';
    end;
    return new;
  end if;
  begin
    if new.status = 'done' then
      select r.output->'brief', r.output->'sources' into v_brief, v_sources from public.cmo_runs r where r.id = new.run_id;
      -- The niche videos the brief learned from (P5 F8): links only, the job keeps only those its research read.
      if jsonb_typeof(v_sources) is distinct from 'array' or jsonb_array_length(v_sources) > 6
         or octet_length(v_sources::text) > 4096 then
        v_sources := null;
      end if;
      if jsonb_typeof(v_brief) is distinct from 'object' or char_length(coalesce(v_brief->>'objective', '')) not between 3 and 300 then
        v_brief := null;
      end if;
    end if;
    for v_video in
      select * from public.work_orders where user_id = new.user_id and new.id = any(depends_on) and status = 'queued' for update
    loop
      if v_brief is not null then
        update public.work_orders
        set brief = (brief - array['objective', 'angle', 'hooks', 'key_points', 'cta', 'seconds', 'aspect', 'sources'])
              || jsonb_strip_nulls(jsonb_build_object('objective', v_brief->'objective', 'angle', v_brief->'angle',
                   'hooks', v_brief->'hooks', 'key_points', coalesce(v_brief->'keyPoints', v_brief->'key_points'),
                   'cta', v_brief->'cta', 'seconds', v_brief->'seconds', 'aspect', v_brief->'aspect', 'brief_from', 'writer',
                   'sources', v_sources)),
            updated_at = now()
        where id = v_video.id;
        perform public.work_order_event(v_video, 'note', 'Writer wrote the brief for “' || v_video.title || '”');
      else
        update public.work_orders set depends_on = array_remove(depends_on, new.id), updated_at = now() where id = v_video.id;
        perform public.work_order_event(v_video, 'note', '“' || v_video.title || '” goes on with the plan''s own brief');
      end if;
    end loop;
  exception when others then
    -- The brief could not be taken (too long for the order, say): the video still goes on, with its own brief.
    raise warning 'brief rule for order % failed: %', new.id, sqlerrm;
    update public.work_orders set depends_on = array_remove(depends_on, new.id), updated_at = now()
    where user_id = new.user_id and new.id = any(depends_on) and status = 'queued';
  end;
  return new;
end;
$$;

commit;
