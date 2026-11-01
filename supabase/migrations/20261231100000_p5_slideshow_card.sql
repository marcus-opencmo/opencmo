-- 20261231100000: P5 for B3, the slideshow card (docs/plans/cmo/2026-10-28-p5-sessions/A.md, Requests from B).
--
-- The Slideshow squad builds the edit, queues the MP4 (`render_document`) and the PNG set (`render_stills`), then
-- records one step that waits on both (`studio_slideshow_rendering`). When both renders are done for the document as it
-- is, the step becomes the card (`studio_steps_sync` raises it) and the order waits on the founder. Approving runs
-- nothing: the order finishes and the MP4's edit becomes the `slideshow` deliverable. Writer's slides reach the
-- order through the brief rule, as the video brief does.

begin;

-- Settles a slideshow step once its renders end: a failed render fails the order; two done renders of the document
-- as it is now raise the card; renders of an older document (edited meanwhile) fail it, and the replan builds again.
create or replace function public.studio_slideshow_settle(p_step uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_step public.studio_steps;
  v_mp4 public.tasks;
  v_stills public.tasks;
  v_hash text;
begin
  select * into v_step from public.studio_steps where id = p_step and kind = 'slideshow' and status = 'running' for update;
  if not found then
    return;
  end if;
  select * into v_mp4 from public.tasks where id = (v_step.input->>'mp4_task')::uuid;
  select * into v_stills from public.tasks where id = (v_step.input->>'stills_task')::uuid;
  if v_mp4.status in ('failed', 'cancelled') or v_stills.status in ('failed', 'cancelled') then
    update public.studio_steps set status = 'failed',
      error = left(coalesce(nullif(case when v_mp4.status in ('failed', 'cancelled') then v_mp4.error else v_stills.error end, ''),
        'The slideshow render failed.'), 500)
    where id = v_step.id;
    if v_step.order_id is not null then
      perform public.work_order_move(v_step.order_id, 'failed', null, jsonb_build_object('code', 'render_failed',
        'message', left(coalesce(nullif(case when v_mp4.status in ('failed', 'cancelled') then v_mp4.error else v_stills.error end, ''),
          'The slideshow render failed.'), 200), 'retryable', true));
    end if;
    return;
  end if;
  if v_mp4.status <> 'done' or v_stills.status <> 'done' then
    return;
  end if;
  select public.editor_document_hash(document) into v_hash from public.editor_projects where clip_id = v_step.clip_id;
  if v_mp4.settings_hash is distinct from v_hash or v_stills.settings_hash is distinct from v_hash then
    update public.studio_steps set status = 'failed', error = 'The slideshow changed while it was rendering.' where id = v_step.id;
    if v_step.order_id is not null then
      perform public.work_order_move(v_step.order_id, 'failed', null, jsonb_build_object('code', 'document_changed',
        'message', 'The slideshow changed while it was rendering.', 'retryable', true));
    end if;
    return;
  end if;
  -- `studio_steps_sync` raises the card when the step turns `waiting`.
  update public.studio_steps set status = 'waiting' where id = v_step.id;
  if v_step.order_id is not null then
    perform public.work_order_wait_founder(v_step.order_id, 'Your slideshow is rendered');
  end if;
end;
$$;
revoke all on function public.studio_slideshow_settle(uuid) from public, anon, authenticated;

-- The squad's step for one slideshow (B3), recorded right after it queued both renders. Brain calls only: the founder
-- makes slideshows in the Slides view and exports them like any edit.
create or replace function public.studio_slideshow_rendering(p_order_id uuid, p_clip_id uuid, p_input jsonb, p_card jsonb,
  p_mp4_task uuid, p_stills_task uuid)
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
    raise exception 'Only a slideshow gets a slideshow card.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user and kind = 'build_slideshow'
                 and status not in ('done', 'failed', 'cancelled')) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or p_card is null or jsonb_typeof(p_card) <> 'object'
     or jsonb_typeof(p_card->'slides') is distinct from 'array' or jsonb_array_length(p_card->'slides') not between 1 and 20 then
    raise exception 'This step is malformed.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tasks where id = p_mp4_task and user_id = v_user and clip_id = p_clip_id and kind = 'render_document')
     or not exists (select 1 from public.tasks where id = p_stills_task and user_id = v_user and clip_id = p_clip_id and kind = 'render_stills') then
    raise exception 'Queue the MP4 and the PNG set of this slideshow first.' using errcode = '22023';
  end if;
  if (select count(*) from public.studio_steps where user_id = v_user and status = 'waiting') >= 20 then
    raise exception 'Too many Studio cards are waiting. Decide some first.' using errcode = 'P0001';
  end if;
  insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status)
  values (v_user, p_clip_id, 'make_slideshow', 'slideshow',
    p_input || jsonb_build_object('mp4_task', p_mp4_task, 'stills_task', p_stills_task), p_card, 0, p_order_id, 'running')
  returning id into v_id;
  -- Both renders may already have ended (a fast worker): settle now rather than wait for a status change.
  perform public.studio_slideshow_settle(v_id);
  return v_id;
end;
$$;
revoke all on function public.studio_slideshow_rendering(uuid, uuid, jsonb, jsonb, uuid, uuid) from public, anon;
grant execute on function public.studio_slideshow_rendering(uuid, uuid, jsonb, jsonb, uuid, uuid) to authenticated;

-- Renders end: a slideshow step first, then the shorts and long-video rules as before.
create or replace function public.tasks_studio_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_short public.shorts;
  v_order uuid;
  v_user uuid;
  v_step uuid;
begin
  if new.kind not in ('render_document', 'render_stills') or new.status not in ('done', 'failed') or old.status = new.status
     or new.clip_id is null then
    return new;
  end if;
  -- A slideshow step waiting on its two renders (P5 S3): its card is raised once both are done.
  select s.id into v_step from public.studio_steps s
  where s.kind = 'slideshow' and s.status = 'running' and s.clip_id = new.clip_id
    and (s.input->>'mp4_task' = new.id::text or s.input->>'stills_task' = new.id::text);
  if v_step is not null then
    begin
      perform public.studio_slideshow_settle(v_step);
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

-- Approving or sending back a slideshow card.
create or replace function public.approval_decide(p_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS public.approvals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_row public.approvals;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_via text := coalesce(nullif(v_payload->>'via', ''), 'app');
  v_target integer;
  v_step public.studio_steps;
  v_batch public.short_batches;
  v_order uuid;
  v_n integer;
  v_text text;
  v_reason text := left(nullif(trim(coalesce(v_payload->>'reason', '')), ''), 400);
  v_caption public.content_items;
  v_title text;
  v_slot public.schedule_slots;
begin
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'The decision is malformed.' using errcode = '22023';
  end if;
  if v_via not in ('app', 'mcp') then
    raise exception 'Cards are decided in the app or through MCP.' using errcode = '22023';
  end if;
  select * into v_row from public.approvals where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Card not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'waiting' then
    raise exception 'This card was already decided.' using errcode = 'P0001';
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    raise exception 'This card expired. A new one will ask again.' using errcode = 'P0001';
  end if;
  if v_payload->>'content_hash' is distinct from v_row.content_hash
     or public.approval_hash(public.approval_snapshot(v_row.ref_kind, v_row.ref_id)) is distinct from v_row.content_hash then
    raise exception 'This card changed. Look at it again before deciding.' using errcode = 'P0001';
  end if;

  -- Words on a finished video or a shorts batch: one caption changes, nothing is decided.
  if p_action = 'edit_caption' then
    if v_row.kind not in ('finished_video', 'shorts_batch') then
      raise exception 'Only a video''s or a batch''s captions are edited here.' using errcode = '22023';
    end if;
    if coalesce(v_payload->>'caption', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Say which caption to change.' using errcode = '22023';
    end if;
    select * into v_caption from public.content_items
    where id = (v_payload->>'caption')::uuid and user_id = v_user and department = 'video' and clip_id is not null
      and v_row.snapshot->'captions' @> jsonb_build_array(jsonb_build_object('caption_id', (v_payload->>'caption')))
    for update;
    if not found then
      raise exception 'That caption is not on this card.' using errcode = '22023';
    end if;
    v_text := trim(coalesce(v_payload->>'text', ''));
    v_title := case when v_caption.platform = 'youtube' then nullif(trim(coalesce(v_payload->>'title', v_caption.body->>'title', '')), '') end;
    perform public.caption_check(v_caption.platform, v_text, v_title);
    update public.content_items
    set body = jsonb_strip_nulls(body || jsonb_build_object('text', v_text, 'title', v_title, 'edited_at', now())),
        updated_at = now()
    where id = v_caption.id;
    perform public.approval_refresh(v_row.ref_kind, v_row.ref_id);
    select * into v_row from public.approvals where id = p_id;
    return v_row;
  end if;

  perform set_config('opencmo.decided_via', v_via, true);
  case v_row.kind
    when 'post' then
      if p_action not in ('approve', 'skip') then
        raise exception 'Choose approve or skip.' using errcode = '22023';
      end if;
      perform public.cmo_decide_post(v_row.ref_id, p_action, v_payload->>'text', v_payload->>'reason');
    when 'reply' then
      if p_action not in ('replied', 'dismissed') then
        raise exception 'Choose replied or dismissed.' using errcode = '22023';
      end if;
      perform public.cmo_decide_opportunity(v_row.ref_id, p_action, v_payload->>'reason');
    when 'goal' then
      if p_action not in ('approve', 'reject') then
        raise exception 'Choose approve or reject.' using errcode = '22023';
      end if;
      if v_payload ? 'target' then
        if jsonb_typeof(v_payload->'target') <> 'number'
           or (v_payload->>'target')::numeric <> trunc((v_payload->>'target')::numeric) then
          raise exception 'The target must be a whole number.' using errcode = '22023';
        end if;
        v_target := (v_payload->>'target')::numeric::integer;
      end if;
      perform public.cmo_decide_goal(v_row.ref_id, p_action, v_payload->>'goal', v_target);
    when 'correction' then
      perform public.cmo_decide_correction(v_row.ref_id, p_action, v_payload->>'text');
    when 'script', 'price' then
      if (v_row.kind = 'script' and p_action not in ('approve', 'edit', 'cancel'))
         or (v_row.kind = 'price' and p_action not in ('approve', 'redo', 'cancel')) then
        raise exception '%', case v_row.kind when 'script' then 'Choose approve, edit a beat or cancel.'
          else 'Choose approve, redo a keyframe or cancel.' end using errcode = '22023';
      end if;
      select * into v_step from public.studio_steps where id = v_row.ref_id and user_id = v_user and kind in ('script', 'price') for update;
      if not found or v_step.status <> 'waiting' then
        raise exception 'This card was already decided.' using errcode = 'P0001';
      end if;
      if p_action = 'edit' then
        if jsonb_typeof(v_payload->'beat') is distinct from 'number'
           or (v_payload->>'beat')::numeric <> trunc((v_payload->>'beat')::numeric) then
          raise exception 'Say which beat to change.' using errcode = '22023';
        end if;
        v_n := (v_payload->>'beat')::numeric::integer;
        v_text := trim(coalesce(v_payload->>'text', ''));
        if v_n < 0 or v_n >= jsonb_array_length(v_row.snapshot->'beats') then
          raise exception 'That beat is not in the script.' using errcode = '22023';
        end if;
        if char_length(v_text) not between 1 and 300 then
          raise exception 'A beat''s words are 1 to 300 characters.' using errcode = '22023';
        end if;
        -- The order runner plans the storyboard again with these words (`next`, added in 20261228120000): queued
        -- like any other Studio step, so it waits while the founder's CMO is paused and is retried.
        update public.studio_steps set status = 'cancelled', decision = 'edit', decided_at = now(),
          decision_payload = jsonb_build_object('beat', v_n, 'text', v_text),
          next = '{"tool": "replan"}'::jsonb, next_done_at = null
        where id = v_step.id;
      elsif p_action = 'redo' then
        if jsonb_typeof(v_payload->'index') is distinct from 'number'
           or (v_payload->>'index')::numeric <> trunc((v_payload->>'index')::numeric) then
          raise exception 'Say which keyframe to make again.' using errcode = '22023';
        end if;
        v_n := (v_payload->>'index')::numeric::integer;
        if not exists (select 1 from jsonb_array_elements(v_row.snapshot->'keyframes') k
                       where jsonb_typeof(k->'index') = 'number' and (k->>'index')::numeric = v_n) then
          raise exception 'That keyframe is not on the sheet.' using errcode = '22023';
        end if;
        update public.studio_steps set status = 'approved', decision = 'redo', decided_at = now(),
          decision_payload = jsonb_build_object('index', v_n)
        where id = v_step.id;
      elsif p_action = 'cancel' then
        update public.studio_steps set status = 'cancelled', decision = 'cancel', decided_at = now() where id = v_step.id;
        if v_step.order_id is not null and exists (select 1 from public.work_orders
            where id = v_step.order_id and status not in ('done', 'failed', 'cancelled')) then
          perform public.work_order_move(v_step.order_id, 'cancelled', 'You cancelled the video');
        end if;
      else
        update public.studio_steps set status = 'approved', decision = 'approve', decided_at = now() where id = v_step.id;
      end if;
    when 'finished_video' then
      if p_action not in ('approve', 'send_back') then
        raise exception 'Choose approve or send back.' using errcode = '22023';
      end if;
      if p_action = 'approve' then
        -- Closes the card and finishes a video order making this edit (mark_finished owns both).
        perform public.mark_finished(v_row.ref_id, v_row.snapshot->>'document_hash');
      else
        perform public.approval_close(v_row.ref_kind, v_row.ref_id, 'skipped');
        -- A failure is data: the order fails with the founder's reason and the progress check replans it.
        select s.order_id into v_order from public.studio_steps s join public.work_orders o on o.id = s.order_id
        where s.clip_id = v_row.ref_id and o.kind = 'build_video' and o.status not in ('done', 'failed', 'cancelled')
        order by s.created_at desc limit 1;
        if v_order is not null then
          perform public.work_order_move(v_order, 'failed', null, jsonb_build_object('code', 'sent_back',
            'message', coalesce(v_reason, 'The founder sent the video back.'), 'retryable', true,
            'repair_hint', 'Change what the founder asked, then render the video again.'));
        end if;
      end if;
    when 'shorts_batch' then
      if p_action not in ('approve', 'send_back') then
        raise exception 'Choose approve or send back.' using errcode = '22023';
      end if;
      select * into v_batch from public.short_batches where id = v_row.ref_id and user_id = v_user for update;
      if not found or v_batch.status <> 'waiting_founder' then
        raise exception 'This card was already decided.' using errcode = 'P0001';
      end if;
      if p_action = 'approve' then
        update public.short_batches set status = 'approved', decided_at = now() where id = v_batch.id;
        update public.shorts set status = 'approved' where batch_id = v_batch.id and status = 'ready';
        -- Each short is its own deliverable, ready for Schedule (P4).
        if v_batch.order_id is not null then
          insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status)
          select v_user, v_batch.order_id, 'short', 'clip', s.short_clip_id, 'ready'
          from public.shorts s where s.batch_id = v_batch.id and s.status = 'approved' and s.short_clip_id is not null
          on conflict (ref_kind, ref_id) do nothing;
          if exists (select 1 from public.work_orders where id = v_batch.order_id and status not in ('done', 'failed', 'cancelled')) then
            perform public.work_order_move(v_batch.order_id, 'done', 'Shorts approved');
          end if;
        end if;
        perform public.approval_close('short_batch', v_batch.id, 'approved');
      else
        update public.short_batches set status = 'sent_back', decided_at = now() where id = v_batch.id;
        update public.shorts set status = 'sent_back' where batch_id = v_batch.id and status = 'ready';
        -- A failure is data: the replan reads the reason and may not cut the same shorts again (brain.md §6).
        if v_batch.order_id is not null and exists (select 1 from public.work_orders
            where id = v_batch.order_id and status not in ('done', 'failed', 'cancelled')) then
          perform public.work_order_move(v_batch.order_id, 'failed', null, jsonb_build_object('code', 'sent_back',
            'message', coalesce(v_reason, 'The founder sent the shorts back.'), 'retryable', true,
            'repair_hint', 'Cut different ranges from the same finished edit.'));
        end if;
        perform public.approval_close('short_batch', v_batch.id, 'skipped');
      end if;
    when 'slideshow' then
      -- Rendered before the card was raised, so approving runs nothing: the step and its order finish here and the
      -- MP4 becomes the slideshow deliverable Schedule picks up (A3). Text edits happen in the Slides view, which
      -- changes the document and raises a new card.
      if p_action not in ('approve', 'send_back') then
        raise exception 'Choose approve or send back.' using errcode = '22023';
      end if;
      select * into v_step from public.studio_steps where id = v_row.ref_id and user_id = v_user and kind = 'slideshow' for update;
      if not found or v_step.status <> 'waiting' then
        raise exception 'This card was already decided.' using errcode = 'P0001';
      end if;
      if p_action = 'approve' then
        update public.studio_steps set status = 'done', decision = 'approve', decided_at = now() where id = v_step.id;
        if v_step.order_id is not null then
          insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status)
          values (v_user, v_step.order_id, 'slideshow', 'clip', v_step.clip_id, 'ready')
          on conflict (ref_kind, ref_id) do nothing;
          if exists (select 1 from public.work_orders where id = v_step.order_id and status not in ('done', 'failed', 'cancelled')) then
            perform public.work_order_move(v_step.order_id, 'done', 'Slideshow approved');
          end if;
        end if;
      else
        update public.studio_steps set status = 'cancelled', decision = 'cancel', decided_at = now() where id = v_step.id;
        -- A failure is data: the order fails with the founder's reason and the progress check replans it.
        if v_step.order_id is not null and exists (select 1 from public.work_orders
            where id = v_step.order_id and status not in ('done', 'failed', 'cancelled')) then
          perform public.work_order_move(v_step.order_id, 'failed', null, jsonb_build_object('code', 'sent_back',
            'message', coalesce(v_reason, 'The founder sent the slideshow back.'), 'retryable', true,
            'repair_hint', 'Change what the founder asked, then build the slideshow again.'));
        end if;
      end if;
    when 'schedule' then
      -- Time, account and platform fields change through schedule_change, which raises the card again; the
      -- answer is the new card, so the founder looks at what they now approve.
      if p_action in ('change_time', 'change_account', 'set_options') then
        perform set_config('opencmo.decided_via', '', true);
        return public.schedule_change(v_row.ref_id, p_action, v_payload);
      end if;
      if p_action not in ('approve', 'retry', 'cancel') then
        raise exception 'Choose approve, change the time or account, or cancel.' using errcode = '22023';
      end if;
      select * into v_slot from public.schedule_slots where id = v_row.ref_id and user_id = v_user for update;
      if not found or v_slot.status not in ('proposed', 'failed') then
        raise exception 'This card was already decided.' using errcode = 'P0001';
      end if;
      if p_action = 'cancel' then
        update public.schedule_slots set status = 'cancelled', updated_at = now() where id = v_slot.id;
        perform public.approval_close(v_row.ref_kind, v_row.ref_id, 'skipped');
      elsif v_slot.status = 'failed' and now() >= v_slot.window_ends_at then
        -- Too late for this time: never post late. The founder's Retry asks for a new time instead.
        perform public.approval_close(v_row.ref_kind, v_row.ref_id, 'approved');
        perform public.schedule_propose(v_slot.deliverable_id);
      else
        if p_action = 'retry' and v_slot.status <> 'failed' then
          raise exception 'There is nothing to retry.' using errcode = '22023';
        end if;
        perform public.schedule_ready_check(v_slot);
        begin
          update public.schedule_slots set status = 'waiting', updated_at = now() where id = v_slot.id;
        exception when unique_violation then
          raise exception 'This post already has another time on %.', public.schedule_platform_label(v_slot.platform)
            using errcode = 'P0001';
        end;
        perform public.approval_close(v_row.ref_kind, v_row.ref_id, 'approved');
      end if;
    else
      raise exception 'This card cannot be decided yet.' using errcode = 'P0001';
  end case;
  perform set_config('opencmo.decided_via', '', true);

  select * into v_row from public.approvals where id = p_id;
  if v_reason is not null and v_row.status in ('skipped', 'edited') then
    update public.approvals set reason = v_reason where id = p_id returning * into v_row;
  end if;
  return v_row;
end;
$_$;

-- A slideshow step never reaches the runner: it is rendered before its card and finished by the decision.
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
    where s.status = 'approved' and s.kind <> 'slideshow' and o.status not in ('done', 'failed', 'cancelled') and not public.cmo_paused(s.user_id)
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

-- Writer's slides into the slideshow order waiting on them.
create or replace function public.work_orders_brief_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_brief jsonb;
  v_video public.work_orders;
begin
  if new.kind not in ('write_video_brief', 'write_slides') or new.status = old.status or new.status not in ('done', 'failed', 'cancelled') then
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
      select r.output->'brief' into v_brief from public.cmo_runs r where r.id = new.run_id;
      if jsonb_typeof(v_brief) is distinct from 'object' or char_length(coalesce(v_brief->>'objective', '')) not between 3 and 300 then
        v_brief := null;
      end if;
    end if;
    for v_video in
      select * from public.work_orders where user_id = new.user_id and new.id = any(depends_on) and status = 'queued' for update
    loop
      if v_brief is not null then
        update public.work_orders
        set brief = (brief - array['objective', 'angle', 'hooks', 'key_points', 'cta', 'seconds', 'aspect'])
              || jsonb_strip_nulls(jsonb_build_object('objective', v_brief->'objective', 'angle', v_brief->'angle',
                   'hooks', v_brief->'hooks', 'key_points', coalesce(v_brief->'keyPoints', v_brief->'key_points'),
                   'cta', v_brief->'cta', 'seconds', v_brief->'seconds', 'aspect', v_brief->'aspect', 'brief_from', 'writer')),
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

-- A still export's zip and PNGs are deleted with its job or its task (B's request).
create or replace function public.enqueue_job_objects(p_job_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    -- A browser upload exists before the worker writes its output manifest; until then the payload is the
    -- only lasting reference to it.
    select coalesce(t.payload->>'bucket', 'exports'), t.payload->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where (t.job_id = p_job_id or c.job_id = p_job_id)
       and t.kind in ('client_export', 'finalize', 'render_document', 'render_stills')
    union
    -- A still export's PNGs (P5 B2): a crashed attempt has no output manifest, so they are found by the prefix.
    select 'exports', o.name
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
      join storage.objects o on o.bucket_id = 'exports' and o.name like (t.payload->>'still_prefix') || '-%'
     where (t.job_id = p_job_id or c.job_id = p_job_id)
       and t.kind = 'render_stills' and t.payload->>'still_prefix' ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$'
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

create or replace function public.record_task_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
      where old.kind in ('client_export', 'finalize', 'render_document', 'render_stills')
    union
    select 'exports', o.name from storage.objects o
     where old.kind = 'render_stills' and old.payload->>'still_prefix' ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}$'
       and o.bucket_id = 'exports' and o.name like (old.payload->>'still_prefix') || '-%'
  ) as source
  where source.path is not null and source.path <> '' and source.path not like '%..%'
    and source.bucket in ('clips', 'sources', 'renders', 'media', 'exports')
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;

commit;
