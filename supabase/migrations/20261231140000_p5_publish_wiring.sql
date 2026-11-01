-- 20261231140000: P5 A3, publish wiring for slideshows and post images (plan F10–F12).
--
-- A slideshow card now gets captions per platform like a finished video (ordered when the card is raised, shown and
-- edited on it, approved with it), and the approved slideshow is scheduled like a short. A post's image is part of
-- what goes out for the post: its schedule card shows it, a new image sends an approved card back to the founder,
-- and the publish step uploads the PNG like it uploads a video.

begin;

-- A post's image changed: waiting cards take it, approved slots go back to the founder with it.
create or replace function public.schedule_image_changed(p_post uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_slot public.schedule_slots;
begin
  for v_slot in
    select s.* from public.schedule_slots s join public.deliverables d on d.id = s.deliverable_id
    where d.ref_kind = 'content_item' and d.ref_id = p_post and s.status in ('proposed', 'waiting')
    for update of s
  loop
    if v_slot.status = 'waiting' then
      update public.schedule_slots set status = 'proposed', updated_at = now() where id = v_slot.id;
    end if;
    perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
  end loop;
end;
$$;
revoke all on function public.schedule_image_changed(uuid) from public, anon, authenticated;

-- A slideshow card orders its captions per platform, like a finished video (P5 F12).
create or replace function public.approvals_caption_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_clips uuid[];
  v_root public.work_orders;
  v_order public.work_orders;
  v_free integer;
  v_profiles text[];
  -- The cut the captions describe: a finished video's document (sent back, edited and raised again, it is a new
  -- cut that needs new words; raised again for its render alone, it is not); a shorts batch is its own cut.
  v_cut text := case when new.kind in ('finished_video', 'slideshow') then new.snapshot->>'document_hash' end;
begin
  if new.kind not in ('finished_video', 'shorts_batch', 'slideshow') or new.status <> 'waiting' then
    return new;
  end if;
  begin
    if exists (select 1 from public.work_orders where user_id = new.user_id and kind = 'write_caption'
               and brief->>'ref_id' = new.ref_id::text and brief->>'document_hash' is not distinct from v_cut
               and status not in ('failed', 'cancelled'))
       or public.cmo_paused(new.user_id) then
      return new;
    end if;
    v_clips := case new.kind
      when 'finished_video' then array[new.ref_id]
      when 'slideshow' then array[(new.snapshot->>'clip_id')::uuid]
      else array(select s.short_clip_id from public.shorts s where s.batch_id = new.ref_id and s.status = 'ready'
                   and s.short_clip_id is not null order by s.source_start, s.id) end;
    if cardinality(v_clips) = 0 then
      return new;
    end if;
    v_profiles := public.caption_targets(new.user_id);
    v_root := public.work_order_week_root(new.user_id);
    v_free := v_root.budget_credits - v_root.spent_credits - coalesce((
      select sum(budget_credits - spent_credits) from public.work_orders
      where parent_id = v_root.id and status not in ('done', 'failed', 'cancelled')), 0);
    v_order := public.work_order_create(new.user_id, v_root.week, v_root.id, 'write_caption',
      left('Captions for “' || coalesce(nullif(new.snapshot->>'title', ''), 'your video') || '”', 200),
      jsonb_build_object('objective', 'Write the captions for each platform.', 'ref_kind', new.ref_kind, 'ref_id', new.ref_id,
        'clip_ids', to_jsonb(v_clips), 'profiles', to_jsonb(v_profiles), 'done_when', 'The captions are on the card.')
        || case when v_cut is not null then jsonb_build_object('document_hash', v_cut) else '{}'::jsonb end,
      least(public.cmo_job_price('write_caption'), greatest(v_free, 0)), null, '{}', 'event');
    perform public.writer_order_start(v_order, jsonb_build_object('clip_ids', to_jsonb(v_clips), 'profiles', to_jsonb(v_profiles),
      'ref_kind', new.ref_kind, 'ref_id', new.ref_id));
  exception when others then
    raise warning 'caption rule for card % failed: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- The slideshow card carries its captions, as a finished video's does.
create or replace function public.approval_snapshot(p_ref_kind text, p_ref_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v jsonb;
  v_captions jsonb;
begin
  case p_ref_kind
    when 'content_item' then
      select jsonb_build_object('kind', 'post', 'platform', platform, 'day', day, 'idea', idea,
        'text', coalesce(body->>'text', ''),
        'alternates', case when jsonb_typeof(body->'alternates') = 'array' then body->'alternates' else '[]'::jsonb end,
        'rationale', coalesce(body->>'rationale', reason))
      into v from public.content_items where id = p_ref_id;
    when 'opportunity' then
      select jsonb_build_object('kind', 'reply', 'url', url, 'community', community, 'title', title,
        'reply', reply, 'score', score, 'score_parts', score_parts)
        || case when rule is not null then jsonb_build_object('rule', rule, 'rule_why', coalesce(rule_why, '')) else '{}'::jsonb end
      into v from public.opportunities where id = p_ref_id and (rule is distinct from 'skip');
    when 'goal' then
      select jsonb_build_object('kind', 'goal', 'week', week, 'goal', goal, 'metric', metric, 'target', target)
      into v from public.cmo_goals where id = p_ref_id;
    when 'correction' then
      select jsonb_build_object('kind', 'correction', 'rule', rule, 'source_edits', source_edits)
        || case when edit_mode is not null then jsonb_build_object('edit_mode', edit_mode, 'times', times) else '{}'::jsonb end
      into v from public.cmo_corrections where id = p_ref_id;
    when 'studio_step' then
      select case s.kind
        when 'script' then jsonb_build_object('kind', 'script', 'step_id', s.id, 'clip_id', s.clip_id, 'tool', s.tool,
          'title', coalesce(s.card->>'title', ''), 'seconds', s.card->'seconds', 'aspect', s.card->'aspect',
          'beats', case when jsonb_typeof(s.card->'beats') = 'array' then s.card->'beats' else '[]'::jsonb end,
          'price_credits', s.price_credits)
        -- The slideshow as built (B3): its slides, the MP4 and the PNG set of this exact document. Any edit to the
        -- document changes `document_hash` and supersedes the card.
        when 'slideshow' then jsonb_build_object('kind', 'slideshow', 'step_id', s.id, 'clip_id', s.clip_id,
          'title', coalesce(s.card->>'title', ''), 'aspect', s.card->'aspect',
          'slides', case when jsonb_typeof(s.card->'slides') = 'array' then s.card->'slides' else '[]'::jsonb end,
          'document_hash', (select public.editor_document_hash(p.document) from public.editor_projects p where p.clip_id = s.clip_id),
          'mp4_path', s.card->'mp4_path', 'png_set_path', s.card->'png_set_path')
        else jsonb_build_object('kind', 'price', 'step_id', s.id, 'clip_id', s.clip_id, 'tool', s.tool,
          'title', coalesce(s.card->>'title', ''), 'what', coalesce(s.card->>'what', ''), 'seconds', s.card->'seconds',
          'wait_minutes', s.card->'wait_minutes',
          'keyframes', case when jsonb_typeof(s.card->'keyframes') = 'array' then s.card->'keyframes' else '[]'::jsonb end,
          'shots', coalesce(s.card->'shots', '0'::jsonb), 'price_credits', s.price_credits)
        end
      into v from public.studio_steps s where s.id = p_ref_id;
      if v->>'kind' = 'slideshow' then
        v_captions := public.caption_snapshots(array[(v->>'clip_id')::uuid]);
      end if;
    when 'editor_project' then
      select jsonb_build_object('kind', 'finished_video', 'clip_id', c.id, 'title', coalesce(c.hook, ''),
        'document_hash', public.editor_document_hash(p.document),
        'render_task_id', r.id, 'render_path', r.output_path, 'seconds', r.duration)
      into v
      from public.editor_projects p
      join public.clips c on c.id = p.clip_id
      left join lateral (
        select t.id, t.output_path, t.duration from public.tasks t
        where t.clip_id = p.clip_id and t.kind = 'render_document' and t.status = 'done'
          and t.settings_hash = public.editor_document_hash(p.document)
        order by t.finished_at desc nulls last, t.created_at desc
        limit 1
      ) r on true
      where p.clip_id = p_ref_id;
      v_captions := public.caption_snapshots(array[p_ref_id]);
    when 'short_batch' then
      select jsonb_build_object('kind', 'shorts_batch', 'batch_id', b.id, 'parent_clip_id', b.parent_clip_id,
        'title', coalesce(c.hook, ''), 'parent_hash', b.parent_hash,
        'shorts', coalesce((
          select jsonb_agg(jsonb_build_object('short_id', s.id, 'short_clip_id', s.short_clip_id,
            'start', s.source_start, 'end', s.source_end, 'hook', s.hook, 'reason', s.reason)
            order by s.source_start, s.id)
          from public.shorts s where s.batch_id = b.id and s.status <> 'failed'), '[]'::jsonb))
      into v
      from public.short_batches b
      left join public.clips c on c.id = b.parent_clip_id
      where b.id = p_ref_id;
      v_captions := public.caption_snapshots(array(
        select s.short_clip_id from public.shorts s
        where s.batch_id = p_ref_id and s.status <> 'failed' and s.short_clip_id is not null
        order by s.source_start, s.id));
    when 'schedule_slot' then
      -- Content, time, account and the platform's fields: everything the founder approves before it posts
      -- (approval.md rule 1). `content_hash` covers the words and the edit, so a change to either supersedes it.
      select jsonb_build_object('kind', 'schedule', 'slot_id', s.id, 'deliverable_id', s.deliverable_id,
        'deliverable_kind', d.kind, 'platform', s.platform, 'mode', s.mode, 'account_id', s.account_id,
        'handle', a.handle, 'publish_at', to_char(s.publish_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'options', s.options, 'last_error', s.error->>'message')
        || public.schedule_content(s.deliverable_id, s.platform)
      into v
      from public.schedule_slots s
      join public.deliverables d on d.id = s.deliverable_id
      left join public.social_accounts a on a.id = s.account_id
      where s.id = p_ref_id;
    else
      raise exception 'Unknown card source.' using errcode = '22023';
  end case;
  if v is not null and v_captions is not null then
    v := v || jsonb_build_object('captions', v_captions);
  end if;
  return v;
end;
$$;

-- Captions Writer saves show on the slideshow card too.
create or replace function public.caption_cards_refresh(p_clip uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_batch uuid;
begin
  perform public.approval_refresh('editor_project', p_clip);
  for v_batch in select distinct s.batch_id from public.shorts s where s.short_clip_id = p_clip loop
    perform public.approval_refresh('short_batch', v_batch);
  end loop;
  for v_batch in select st.id from public.studio_steps st where st.clip_id = p_clip and st.kind = 'slideshow' and st.status = 'waiting' loop
    perform public.approval_refresh('studio_step', v_batch);
  end loop;
end;
$$;

-- Approving a slideshow card approves its captions.
create or replace function public.approvals_caption_approve() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
begin
  if new.kind not in ('finished_video', 'shorts_batch', 'slideshow') or new.status <> 'approved' or old.status <> 'waiting'
     or coalesce(jsonb_typeof(new.snapshot->'captions'), '') <> 'array' then
    return new;
  end if;
  update public.content_items c set status = 'approved', decided_at = coalesce(c.decided_at, now()), updated_at = now()
  where c.user_id = new.user_id and c.department = 'video' and c.status = 'in_review'
    and c.id in (select (e->>'caption_id')::uuid from jsonb_array_elements(new.snapshot->'captions') e
                 where e->>'caption_id' ~ '^[0-9a-f-]{36}$');
  return new;
end;
$_$;

-- A slideshow card's captions are edited on the card.
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
    if v_row.kind not in ('finished_video', 'shorts_batch', 'slideshow') then
      raise exception 'Only a video''s, a batch''s or a slideshow''s captions are edited here.' using errcode = '22023';
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

-- A slideshow's captions are delivered with it.
create or replace function public.caption_deliver(p_caption public.content_items) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_parent public.deliverables;
begin
  select * into v_parent from public.deliverables
  where ref_kind = 'clip' and ref_id = p_caption.clip_id and kind in ('video', 'short', 'slideshow') and user_id = p_caption.user_id
  order by created_at limit 1;
  if not found then
    return;
  end if;
  insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status, parent_id)
  values (p_caption.user_id, v_parent.order_id, 'caption', 'content_item', p_caption.id, 'ready', v_parent.id)
  on conflict (ref_kind, ref_id) do nothing;
  update public.content_items set status = 'approved', decided_at = coalesce(decided_at, now()), updated_at = now()
  where id = p_caption.id and status = 'in_review';
end;
$$;

-- Approved slideshows are scheduled like shorts; a post's new image refreshes its schedule cards.
create or replace function public.schedule_follow_deliverable() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if (new.kind = 'post' and new.status = 'decided' and (tg_op = 'INSERT' or old.status is distinct from 'decided'))
     or (new.kind in ('short', 'slideshow') and tg_op = 'INSERT') then
    begin
      perform public.schedule_propose(new.id);
    exception when others then
      -- Scheduling is never a reason to undo the founder's approval of the work itself.
      raise warning 'schedule rule for deliverable % failed: %', new.id, sqlerrm;
    end;
  end if;
  -- A post's image arrived (P5 B4): the post's schedule cards change. One still waiting is refreshed; one already
  -- approved goes back to the founder, so nothing posts with an image they did not see.
  if new.kind = 'image' and tg_op = 'INSERT' and new.post_id is not null then
    begin
      perform public.schedule_image_changed(new.post_id);
    exception when others then
      raise warning 'image rule for deliverable % failed: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

-- A slideshow caption approved later proposes its platform, like a short's.
create or replace function public.schedule_follow_content() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_deliverable uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  begin
    if new.status = 'approved' and new.department = 'video' and new.clip_id is not null then
      select id into v_deliverable from public.deliverables
      where ref_kind = 'clip' and ref_id = new.clip_id and kind in ('short', 'slideshow') and user_id = new.user_id;
      if v_deliverable is not null then
        perform public.schedule_propose(v_deliverable);
      end if;
    elsif new.status = 'published' and new.department = 'post' then
      -- Posted by hand (copy and open, or marked posted): what still waits for its time is dropped with its card.
      update public.approvals a set status = 'cancelled', decided_at = now()
      from public.schedule_slots s join public.deliverables d on d.id = s.deliverable_id
      where a.ref_kind = 'schedule_slot' and a.ref_id = s.id and a.status = 'waiting'
        and d.ref_kind = 'content_item' and d.ref_id = new.id and s.status in ('proposed', 'waiting');
      update public.schedule_slots s set status = 'cancelled', updated_at = now()
      from public.deliverables d
      where d.id = s.deliverable_id and d.ref_kind = 'content_item' and d.ref_id = new.id
        and s.status in ('proposed', 'waiting');
    end if;
  exception when others then
    raise warning 'schedule rule for content item % failed: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- A slideshow goes to the platforms it has approved captions for, like a short.
create or replace function public.schedule_propose(p_deliverable uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_d public.deliverables;
  v_rules jsonb := public.schedule_rules();
  v_platform text;
  v_platforms text[];
  v_at timestamptz;
  v_account uuid;
  v_slot uuid;
  v_n integer := 0;
begin
  select * into v_d from public.deliverables where id = p_deliverable;
  if not found then
    return 0;
  end if;
  if v_d.kind = 'post' and v_d.ref_kind = 'content_item' then
    -- Writer stores the calendar's label ("X", "Threads", "LinkedIn"); slots use the platform's id.
    select array_agg(public.platform_profile_id(platform)) into v_platforms from public.content_items
    where id = v_d.ref_id and status = 'approved' and public.platform_profile_id(platform) in ('x', 'threads', 'linkedin');
  elsif v_d.kind in ('short', 'slideshow') and v_d.ref_kind = 'clip' then
    select array_agg(p) into v_platforms from unnest(array['tiktok', 'instagram', 'youtube']) p
    where exists (select 1 from public.content_items c
      where c.clip_id = v_d.ref_id and c.department = 'video' and c.status = 'approved'
        and c.platform = public.platform_profile_id(p));
  end if;
  foreach v_platform in array coalesce(v_platforms, '{}') loop
    continue when exists (select 1 from public.schedule_slots where deliverable_id = v_d.id and platform = v_platform
      and status in ('proposed', 'waiting', 'due', 'reminded', 'publishing', 'published'));
    -- A failure still in its window waits on its Retry card; an unconfirmed one may have gone out. Neither gets a twin.
    continue when exists (select 1 from public.schedule_slots where deliverable_id = v_d.id and platform = v_platform
      and status = 'failed' and (window_ends_at > now() or error->>'code' = 'unconfirmed'));
    continue when (select count(*) from public.schedule_slots where deliverable_id = v_d.id and platform = v_platform)
      >= (v_rules->>'maxProposals')::integer;
    v_at := public.schedule_pick_time(v_d.user_id, v_platform, v_d.id);
    continue when v_at is null;
    select id into v_account from public.social_accounts
    where user_id = v_d.user_id and platform = v_platform and status = 'connected';
    -- TikTok's posting guidelines: the founder picks the audience and turns on each interaction and disclosure;
    -- nothing starts on.
    insert into public.schedule_slots (user_id, deliverable_id, platform, account_id, mode, publish_at, jitter_seconds,
      window_ends_at, options)
    values (v_d.user_id, v_d.id, v_platform, v_account, case when v_account is null then 'intent' else 'publish' end,
      v_at, public.schedule_jitter(), v_at + make_interval(mins => (v_rules->>'windowMinutes')::integer),
      case when v_platform = 'tiktok' then '{"allow_comment": false, "allow_duet": false, "allow_stitch": false,
        "brand_organic": false, "brand_content": false}'::jsonb else '{}'::jsonb end)
    returning id into v_slot;
    perform public.approval_raise(v_d.user_id, 'schedule_slot', v_slot);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- What goes out for a post includes its image.
create or replace function public.schedule_content(p_deliverable uuid, p_platform text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_d public.deliverables;
  v_text text;
  v_title text;
  v_doc text;
  v_image_clip uuid;
  v_image jsonb;
begin
  select * into v_d from public.deliverables where id = p_deliverable;
  if not found then
    return null;
  end if;
  if v_d.ref_kind = 'content_item' then
    select coalesce(body->>'text', '') into v_text from public.content_items where id = v_d.ref_id;
    -- The post's newest image (P5 B4), as its cover still of the image's document as it is now. Only a post with an
    -- image carries the key, so the hash of a post without one is what it was before P5.
    select i.ref_id into v_image_clip from public.deliverables i
    where i.post_id = v_d.ref_id and i.kind = 'image' order by i.created_at desc limit 1;
    if v_image_clip is not null then
      select jsonb_build_object('clip_id', v_image_clip,
          'object', t.output->'stills'->coalesce((t.output->>'cover_index')::integer, 0)->>'object',
          'bytes', t.output->'stills'->coalesce((t.output->>'cover_index')::integer, 0)->'bytes')
        into v_image
      from public.tasks t join public.editor_projects p on p.clip_id = t.clip_id
      where t.clip_id = v_image_clip and t.kind = 'render_stills' and t.status = 'done'
        and t.settings_hash = public.editor_document_hash(p.document)
      order by t.finished_at desc nulls last limit 1;
      if v_image->>'object' is null then
        v_image := null;
      end if;
    end if;
    return jsonb_build_object('clip_id', null, 'text', v_text, 'title', null,
      'content_hash', public.approval_hash(jsonb_build_object('text', v_text)
        || case when v_image is not null then jsonb_build_object('image', v_image->>'object') else '{}'::jsonb end))
      || case when v_image is not null then jsonb_build_object('image', v_image) else '{}'::jsonb end;
  elsif v_d.ref_kind = 'clip' then
    select public.editor_document_hash(document) into v_doc from public.editor_projects where clip_id = v_d.ref_id;
    select body->>'text', body->>'title' into v_text, v_title
    from public.content_items
    where clip_id = v_d.ref_id and department = 'video' and platform = public.platform_profile_id(p_platform)
      and status in ('approved', 'published');
    return jsonb_build_object('clip_id', v_d.ref_id, 'text', v_text, 'title', v_title,
      'content_hash', public.approval_hash(jsonb_strip_nulls(jsonb_build_object('document_hash', v_doc, 'text', v_text,
        'title', v_title))));
  end if;
  return null;
end;
$$;

-- The publish step reads a post's image as its media.
create or replace function public.publish_slot_read(p_slot uuid, p_user uuid, p_order uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_slot public.schedule_slots := public.publish_slot_guard(p_slot, p_user, p_order);
  v_account public.social_accounts;
  v_approval public.approvals;
  v_current jsonb := public.schedule_content(v_slot.deliverable_id, v_slot.platform);
  v_export jsonb;
  v_task public.tasks;
  v_media jsonb := '{"state": "none"}'::jsonb;
begin
  select * into v_account from public.social_accounts where id = v_slot.account_id;
  select * into v_approval from public.approvals where id = v_slot.approval_id;
  if v_current->>'clip_id' is not null then
    select jsonb_build_object('object', t.output_path, 'bytes', t.bytes, 'contentType', 'video/mp4') into v_export
    from public.tasks t join public.editor_projects p on p.clip_id = t.clip_id
    where t.clip_id = (v_current->>'clip_id')::uuid and t.kind = 'render_document' and t.status = 'done'
      and t.settings_hash = public.editor_document_hash(p.document) and t.output_path is not null
    order by t.finished_at desc nulls last limit 1;
  elsif v_current->'image'->>'object' is not null then
    v_export := jsonb_build_object('object', v_current->'image'->>'object', 'bytes', v_current->'image'->'bytes', 'contentType', 'image/png');
  end if;
  select * into v_task from public.tasks where id = v_slot.media_task_id;
  if v_task.id is not null then
    v_media := case v_task.status
      when 'done' then jsonb_build_object('state', 'done', 'publicUrl', v_task.payload->>'public_url',
        'contentType', coalesce(v_task.payload->>'content_type', 'video/mp4'))
      when 'failed' then jsonb_build_object('state', 'failed', 'error', coalesce(v_task.error, 'The video could not be uploaded.'))
      when 'cancelled' then jsonb_build_object('state', 'failed', 'error', 'The video upload was cancelled.')
      else jsonb_build_object('state', 'running', 'startedAt', to_jsonb(coalesce(v_task.started_at, v_task.created_at))) end;
  end if;
  return jsonb_build_object('id', v_slot.id, 'status', v_slot.status, 'platform', v_slot.platform, 'mode', v_slot.mode,
    'accountId', v_slot.account_id, 'zernioAccountId', v_account.zernio_account_id, 'accountStatus', v_account.status,
    'publishAt', to_jsonb(v_slot.publish_at), 'windowEndsAt', to_jsonb(v_slot.window_ends_at), 'options', v_slot.options,
    -- One key per attempt: a re-run inside an attempt repeats safely; a Retry is a new post, not Zernio's cached answer.
    'idempotencyKey', v_slot.idempotency_key || ':' || v_slot.attempts, 'approvalStatus', v_approval.status, 'snapshot', v_approval.snapshot,
    'current', v_current, 'export', v_export, 'media', v_media);
end;
$$;

-- A post's PNG goes up to Zernio through the same streamed upload as a video.
create or replace function public.publish_media_queue(p_slot uuid, p_user uuid, p_order uuid, p_object text, p_upload_url text, p_public_url text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_slot public.schedule_slots := public.publish_slot_guard(p_slot, p_user, p_order);
  v_task uuid;
begin
  if v_slot.status <> 'publishing' then
    raise exception 'This post is not being published.' using errcode = 'P0001';
  end if;
  if p_object is null or p_object !~ ('^' || p_user::text || '/[0-9a-f-]{36}/[0-9a-f-]{36}(\.mp4|-[0-9]{2}\.png)$') then
    raise exception 'That export is not this founder''s.' using errcode = '22023';
  end if;
  if p_upload_url !~ '^https://' or char_length(p_upload_url) > 2048
     or p_public_url !~ '^https://' or char_length(p_public_url) > 2048 then
    raise exception 'The upload address is not valid.' using errcode = '22023';
  end if;
  insert into public.tasks (user_id, kind, clip_id, payload, request_id, status)
  values (p_user, 'publish_media', coalesce(public.approval_snapshot('schedule_slot', p_slot)->>'clip_id',
      public.approval_snapshot('schedule_slot', p_slot)->'image'->>'clip_id')::uuid,
    jsonb_build_object('bucket', 'exports', 'object', p_object, 'upload_url', p_upload_url, 'public_url', p_public_url,
      'content_type', case when p_object like '%.png' then 'image/png' else 'video/mp4' end, 'slot_id', p_slot),
    gen_random_uuid(), 'queued')
  returning id into v_task;
  update public.schedule_slots set media_task_id = v_task, updated_at = now() where id = p_slot;
  return v_task;
end;
$_$;

commit;
