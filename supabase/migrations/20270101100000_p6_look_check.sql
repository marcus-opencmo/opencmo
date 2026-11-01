-- 20270101100000: P6 S4, the look check waits between a finished Studio render and its card (B's request 1 in
-- docs/plans/cmo/2026-10-28-p6-sessions/A.md; contract in apps/web/lib/departments/studio/look-check.ts).
--
-- Cards are raised in SQL, so the wait lives here. Where a long take, a shorts batch or a slideshow used to raise its
-- card, a `look_check` task now reads the full-size export first. A pass raises the card as before. A failure in round
-- 0 raises nothing: the squad claims one send-back, redoes the work, and the next render is checked as round 1, whose
-- result always reaches the card. A look check that cannot run (task failed) raises the card without a note: the
-- check never blocks a card.

begin;

alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('probe_media', 'generate', 'render_document',
  'render_stills', 'transcribe_media', 'transcribe_asset', 'capture_page', 'publish_media', 'look_check'));

-- One row per check. `doc_key` is what the card's snapshot is pinned to (the edit's document hash, or a batch's parent
-- hash), so a note is shown only on the card of the render it was made for.
create table public.look_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ref_kind text not null check (ref_kind in ('editor_project', 'short_batch', 'studio_step')),
  ref_id uuid not null,
  order_id uuid references public.work_orders(id) on delete set null,
  round smallint not null check (round in (0, 1)),
  doc_key text not null check (char_length(doc_key) <= 100),
  task_id uuid references public.tasks(id) on delete set null,
  -- checking → passed | failed (round 1, the card shows the note) | sent_back (round 0) → claimed | error (no note);
  -- checking → superseded when a newer render of the same order starts its own check at the same round.
  status text not null default 'checking'
    check (status in ('checking', 'passed', 'failed', 'sent_back', 'claimed', 'error', 'superseded')),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 65536)),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  claimed_at timestamptz,
  -- Set once `look_check_raise` ran for a settled check; a settled check without it is raised again by the sweep in
  -- `studio_look_sendbacks_claim`, so an error while raising never loses the card.
  raised_at timestamptz
);
-- Rounds count per order: a squad's redo may make a new step or batch, and its check is still round 1.
create unique index look_checks_one_round on public.look_checks (ref_kind, coalesce(order_id, ref_id), round)
  where status <> 'superseded';
create index look_checks_task_idx on public.look_checks (task_id);
create index look_checks_sent_back_idx on public.look_checks (created_at) where status in ('sent_back', 'claimed');

alter table public.look_checks enable row level security;
create policy "read own look checks" on public.look_checks for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.look_checks from anon, authenticated;
grant select on public.look_checks to authenticated;
grant select, insert, update, delete on public.look_checks to service_role;

-- Starts a check where a card would be raised. True: a check runs (or already runs), so the caller raises nothing.
-- False: raise the card now, because the ref was already checked in both rounds (or passed), or there is no file.
create or replace function public.look_check_begin(p_user uuid, p_ref_kind text, p_ref_id uuid, p_order uuid,
  p_doc_key text, p_files jsonb)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_round smallint;
  v_prior public.look_checks;
  v_task uuid;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) not between 1 and 20
     or p_doc_key is null
     or exists (select 1 from jsonb_array_elements(p_files) f where coalesce(f->>'path', '') = '' or coalesce(f->>'clip_id', '') = '') then
    return false;
  end if;
  select * into v_prior from public.look_checks
  where ref_kind = p_ref_kind and coalesce(order_id, ref_id) = coalesce(p_order, p_ref_id) and status <> 'superseded'
  order by round desc limit 1 for update;
  if not found then
    v_round := 0;
  elsif v_prior.status = 'checking' then
    if v_prior.ref_id = p_ref_id and v_prior.doc_key = p_doc_key then
      return true;  -- the same render, already being checked
    end if;
    -- A newer render (an edit made during the check): the old check could only raise a card for a render that is no
    -- longer current, so this one takes its place at the same round. A running task that finishes later finds no
    -- `checking` row and changes nothing.
    update public.look_checks set status = 'superseded', settled_at = now() where id = v_prior.id;
    update public.tasks set status = 'cancelled' where id = v_prior.task_id and status = 'queued';
    v_round := v_prior.round;
  elsif v_prior.round = 0 and v_prior.status in ('sent_back', 'claimed') then
    v_round := 1;
  else
    -- Passed, failed in round 1, or could not run: a later render of the same order is not checked again.
    return false;
  end if;
  insert into public.tasks (user_id, kind, payload, status, request_id)
  values (p_user, 'look_check',
    jsonb_build_object('ref_kind', p_ref_kind, 'ref_id', p_ref_id, 'round', v_round, 'files', p_files),
    'queued', gen_random_uuid())
  returning id into v_task;
  insert into public.look_checks (user_id, ref_kind, ref_id, order_id, round, doc_key, task_id)
  values (p_user, p_ref_kind, p_ref_id, p_order, v_round, p_doc_key, v_task);
  return true;
end;
$$;
revoke all on function public.look_check_begin(uuid, text, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Raises the card the check was holding, as the render rules did before P6.
create or replace function public.look_check_raise(p_check public.look_checks)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  case p_check.ref_kind
    when 'editor_project' then
      -- Only for the edit that was rendered: an edit made during the check gets its own render and card.
      if p_check.doc_key = (select public.editor_document_hash(document) from public.editor_projects where clip_id = p_check.ref_id) then
        perform public.approval_raise(p_check.user_id, 'editor_project', p_check.ref_id);
        if p_check.order_id is not null then
          perform public.work_order_wait_founder(p_check.order_id, 'Your video is rendered');
        end if;
      end if;
    when 'short_batch' then
      update public.short_batches set status = 'waiting_founder' where id = p_check.ref_id and status = 'rendering';
      if found then
        perform public.approval_raise(p_check.user_id, 'short_batch', p_check.ref_id);
        if p_check.order_id is not null then
          perform public.work_order_wait_founder(p_check.order_id, 'Shorts are ready for you');
        end if;
      end if;
    when 'studio_step' then
      -- `studio_steps_sync` raises the card when the step turns `waiting`.
      update public.studio_steps set status = 'waiting' where id = p_check.ref_id and status = 'running';
      if found and p_check.order_id is not null then
        perform public.work_order_wait_founder(p_check.order_id, 'Your slideshow is rendered');
      end if;
  end case;
  update public.look_checks set raised_at = now() where id = p_check.id;
end;
$$;
revoke all on function public.look_check_raise(public.look_checks) from public, anon, authenticated;

-- `look_check_raise` in its own subtransaction: an error rolls back only the raise, logs it and returns false, so the
-- check's settled status stays and the sweep in `studio_look_sendbacks_claim` tries again.
create or replace function public.look_check_raise_safe(p_check public.look_checks)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public.look_check_raise(p_check);
  return true;
exception when others then
  raise warning 'look check % could not raise its card: %', p_check.id, sqlerrm;
  return false;
end;
$$;
revoke all on function public.look_check_raise_safe(public.look_checks) from public, anon, authenticated;

-- A `look_check` task finished: pass → card; round 0 failed → a send-back, no card; round 1 failed → card with note;
-- the task failed → card without a note.
create or replace function public.tasks_look_check_settle()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_check public.look_checks;
  v_pass boolean;
begin
  if new.kind <> 'look_check' or new.status not in ('done', 'failed', 'cancelled') or old.status = new.status then
    return new;
  end if;
  select * into v_check from public.look_checks where task_id = new.id and status = 'checking' for update;
  if not found then
    return new;
  end if;
  -- The status settles outside the raise's subtransaction: a failed raise must not leave the check `checking`.
  v_pass := case when new.status = 'done' and jsonb_typeof(new.output->'pass') = 'boolean' then (new.output->>'pass')::boolean end;
  update public.look_checks
  set status = case when v_pass is null then 'error' when v_pass then 'passed' when round = 0 then 'sent_back' else 'failed' end,
      result = case when new.status = 'done' and jsonb_typeof(new.output) = 'object' and octet_length(new.output::text) <= 65536
                    then new.output end,
      settled_at = now()
  where id = v_check.id
  returning * into v_check;
  if v_check.status <> 'sent_back' then
    perform public.look_check_raise_safe(v_check);
  end if;
  return new;
end;
$$;
revoke all on function public.tasks_look_check_settle() from public, anon, authenticated;
create trigger tasks_look_check_settle after update of status on public.tasks
  for each row execute function public.tasks_look_check_settle();

-- The squads' side (B1, service role): send-backs to redo, oldest first. A send-back claimed an hour ago whose redo
-- never came back is given up on: its card is raised with the round-0 note, so the founder is never left waiting.
-- It also sweeps up checks whose card was never raised: a raise that failed (settled, `raised_at` null) is tried
-- again, and a check left `checking` after its task ended or went away settles as `error` and raises its card.
create or replace function public.studio_look_sendbacks_claim(p_limit integer)
returns table (check_id uuid, ref_kind text, ref_id uuid, user_id uuid, order_id uuid, look jsonb)
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_stale public.look_checks;
begin
  for v_stale in
    select c.* from public.look_checks c
    where c.status = 'claimed' and c.claimed_at < now() - interval '1 hour'
      and not exists (select 1 from public.look_checks r where r.ref_kind = c.ref_kind
                      and coalesce(r.order_id, r.ref_id) = coalesce(c.order_id, c.ref_id) and r.round = 1
                      and r.status <> 'superseded')
    for update skip locked
  loop
    update public.look_checks set status = 'failed', settled_at = now() where id = v_stale.id returning * into v_stale;
    perform public.look_check_raise_safe(v_stale);
  end loop;
  -- Five minutes of grace, so a settle still in flight is never raced.
  for v_stale in
    select c.* from public.look_checks c
    where c.status = 'checking' and c.created_at < now() - interval '5 minutes'
      and (c.task_id is null or exists (select 1 from public.tasks t where t.id = c.task_id
                                        and t.status in ('done', 'failed', 'cancelled')))
    order by c.created_at limit 50
    for update skip locked
  loop
    update public.look_checks set status = 'error', settled_at = now() where id = v_stale.id returning * into v_stale;
    perform public.look_check_raise_safe(v_stale);
  end loop;
  for v_stale in
    select c.* from public.look_checks c
    where c.status in ('passed', 'failed', 'error') and c.raised_at is null and c.settled_at < now() - interval '5 minutes'
    order by c.settled_at limit 50
    for update skip locked
  loop
    perform public.look_check_raise_safe(v_stale);
  end loop;
  return query
  with picked as (
    select c.id from public.look_checks c
    where c.status = 'sent_back'
    order by c.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  update public.look_checks c set status = 'claimed', claimed_at = now()
  from picked where c.id = picked.id
  returning c.id, c.ref_kind, c.ref_id, c.user_id, c.order_id, c.result;
end;
$$;
revoke all on function public.studio_look_sendbacks_claim(integer) from public, anon, authenticated;
grant execute on function public.studio_look_sendbacks_claim(integer) to service_role;

-- The card's snapshot carries the look check's note when the check still found a problem on this exact render
-- (`look.note`, ≤ 200), so `content_hash` changes with it. The body is unchanged, as `approval_snapshot_base`.
alter function public.approval_snapshot(text, uuid) rename to approval_snapshot_base;
revoke all on function public.approval_snapshot_base(text, uuid) from public, anon, authenticated;

create or replace function public.approval_snapshot(p_ref_kind text, p_ref_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v jsonb := public.approval_snapshot_base(p_ref_kind, p_ref_id);
  v_look public.look_checks;
begin
  if v is null or p_ref_kind not in ('editor_project', 'short_batch', 'studio_step') then
    return v;
  end if;
  select * into v_look from public.look_checks c
  where c.ref_kind = p_ref_kind and c.ref_id = p_ref_id and c.status = 'failed'
    and c.doc_key = coalesce(v->>'document_hash', v->>'parent_hash')
  order by c.round desc, c.created_at desc limit 1;
  if found and coalesce(v_look.result->>'note', '') <> '' then
    v := v || jsonb_build_object('look', jsonb_build_object('pass', false, 'round', v_look.round,
      'note', left(v_look.result->>'note', 200)));
  end if;
  return v;
end;
$$;
revoke all on function public.approval_snapshot(text, uuid) from public, anon, authenticated;

-- The three render rules start a check where they raised the card. Bodies as in 20261231160000, except for that.
create or replace function public.tasks_studio_rules()
returns trigger language plpgsql security definer set search_path = public
as $$
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
        -- P6 S4: the look check reads the full-size export first; it raises card 3 when it is done.
        if not public.look_check_begin(v_user, 'editor_project', new.clip_id, v_order, new.settings_hash,
            jsonb_build_array(jsonb_build_object('path', new.output_path, 'clip_id', new.clip_id))) then
          perform public.approval_raise(v_user, 'editor_project', new.clip_id);
          perform public.work_order_wait_founder(v_order, 'Your video is rendered');
        end if;
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

create or replace function public.short_batch_settle(p_batch_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_batch public.short_batches;
  v_files jsonb;
begin
  select * into v_batch from public.short_batches where id = p_batch_id for update;
  if not found or v_batch.status <> 'rendering' or exists (
      select 1 from public.shorts where batch_id = v_batch.id and status in ('building', 'rendering')) then
    return;
  end if;
  if exists (select 1 from public.shorts where batch_id = v_batch.id and status = 'ready') then
    -- P6 S4: each ready short's full-size render of its edit as it is now; the batch stays `rendering` while checked.
    select jsonb_agg(jsonb_build_object('path', r.output_path, 'clip_id', s.short_clip_id) order by s.source_start, s.id)
    into v_files
    from public.shorts s
    left join public.editor_projects p on p.clip_id = s.short_clip_id
    left join lateral (
      select t.output_path from public.tasks t
      where t.clip_id = s.short_clip_id and t.kind = 'render_document' and t.status = 'done'
        and t.settings_hash = public.editor_document_hash(p.document)
      order by t.finished_at desc nulls last, t.created_at desc limit 1
    ) r on true
    where s.batch_id = v_batch.id and s.status = 'ready';
    if public.look_check_begin(v_batch.user_id, 'short_batch', v_batch.id, v_batch.order_id, v_batch.parent_hash, v_files) then
      return;
    end if;
    update public.short_batches set status = 'waiting_founder' where id = v_batch.id;
    perform public.approval_raise(v_batch.user_id, 'short_batch', v_batch.id);
    if v_batch.order_id is not null then
      perform public.work_order_wait_founder(v_batch.order_id, 'Shorts are ready for you');
    end if;
  else
    update public.short_batches set status = 'failed', error = 'Every short failed to render.' where id = v_batch.id;
    if v_batch.order_id is not null and exists (select 1 from public.work_orders
        where id = v_batch.order_id and status not in ('done', 'failed', 'cancelled')) then
      perform public.work_order_move(v_batch.order_id, 'failed', null,
        jsonb_build_object('code', 'render_failed', 'message', 'Every short failed to render.', 'retryable', true));
    end if;
  end if;
end;
$$;

create or replace function public.studio_slideshow_settle(p_step uuid)
returns void language plpgsql security definer set search_path = public
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
  -- P6 S4: the look check reads the MP4 first; `look_check_raise` turns the step `waiting` when it is done.
  if public.look_check_begin(v_step.user_id, 'studio_step', v_step.id, v_step.order_id, v_hash,
      jsonb_build_array(jsonb_build_object('path', v_mp4.output_path, 'clip_id', v_step.clip_id))) then
    return;
  end if;
  -- `studio_steps_sync` raises the card when the step turns `waiting`.
  update public.studio_steps set status = 'waiting' where id = v_step.id;
  if v_step.order_id is not null then
    perform public.work_order_wait_founder(v_step.order_id, 'Your slideshow is rendered');
  end if;
end;
$$;

commit;
