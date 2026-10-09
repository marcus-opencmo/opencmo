-- Assistant ở trang project (spec AI Studio P4): một phiên cho CẢ project
-- (job), sửa nhiều clip — mọi lượt ghi lên nhiều clip phải qua THẺ DUYỆT.
--
-- 1. `agent_sessions` có `job_id`; phiên `project` không gắn clip nào.
-- 2. Lượt `awaiting_approval`: như `awaiting_browser` (tạm dừng giữa hai
--    request, tool `pending`), nhưng chờ NGƯỜI bấm Approve/Cancel.
-- 3. Checkpoint của lượt project là revision của MỘT clip bất kỳ trong job —
--    nó chỉ đánh dấu "lượt này có ghi"; checkpoint từng clip nằm trong kết
--    quả tool (`agent_tool_calls.result.clips`).

begin;

-- ------------------------------------------------------------ phiên project
alter table public.agent_sessions add column if not exists job_id uuid references public.jobs(id) on delete cascade;
alter table public.agent_sessions alter column clip_id drop not null;
alter table public.agent_sessions drop constraint if exists agent_sessions_scope_check;
alter table public.agent_sessions add constraint agent_sessions_scope_check check (
  (scope = 'clip' and clip_id is not null and job_id is null)
  or (scope = 'project' and job_id is not null and clip_id is null)
);
create index if not exists agent_sessions_job_idx on public.agent_sessions (job_id, created_at desc);

create or replace function public.agent_owned_session(p_session_id uuid, p_user uuid)
returns public.agent_sessions language plpgsql stable security definer set search_path = public
as $$
declare
  v_session public.agent_sessions;
begin
  select s.* into v_session from public.agent_sessions s
  left join public.clips c on c.id = s.clip_id
  join public.jobs j on j.id = coalesce(s.job_id, c.job_id)
  where s.id = p_session_id and s.user_id = p_user and j.purging_at is null;
  if not found then
    raise exception 'Assistant session not found.' using errcode = 'P0002';
  end if;
  return v_session;
end;
$$;

create or replace function public.agent_open_project_session(p_job_id uuid, p_model text)
returns public.agent_sessions language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
begin
  if not exists (
    select 1 from public.jobs j where j.id = p_job_id and j.user_id = v_user and j.purging_at is null
  ) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if p_model is null or char_length(p_model) > 64 or not exists (
    select 1 from public.agent_model_prices p
    where p.allowed and p.pattern <> 'default' and p_model like p.pattern
  ) then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  select * into v_session from public.agent_sessions
  where job_id = p_job_id and user_id = v_user and model = p_model
  order by created_at desc limit 1;
  if found then
    return v_session;
  end if;
  insert into public.agent_sessions(user_id, job_id, scope, model)
  values (v_user, p_job_id, 'project', p_model) returning * into v_session;
  return v_session;
end;
$$;

-- ------------------------------------------------------------ chờ duyệt
alter table public.agent_turns drop constraint if exists agent_turns_status_check;
alter table public.agent_turns add constraint agent_turns_status_check
  check (status in ('running', 'awaiting_browser', 'awaiting_approval', 'done', 'failed', 'stopped'));

drop function if exists public.agent_pause_turn(uuid);
create or replace function public.agent_pause_turn(p_turn_id uuid, p_reason text default 'browser')
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if p_reason not in ('browser', 'approval') then
    raise exception 'Invalid pause reason.' using errcode = '22023';
  end if;
  update public.agent_turns
  set status = case p_reason when 'approval' then 'awaiting_approval' else 'awaiting_browser' end
  where id = p_turn_id and status = 'running';
  if not found then
    raise exception 'This assistant turn was stopped.' using errcode = 'P0001';
  end if;
  -- Chờ người duyệt có thể lâu hơn chờ trình duyệt chụp ảnh.
  update public.agent_sessions
  set lock_until = now() + case p_reason when 'approval' then interval '30 minutes' else interval '6 minutes' end,
      updated_at = now()
  where id = v_turn.session_id;
end;
$$;

create or replace function public.agent_resume_turn(p_session_id uuid)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  perform public.agent_owned_session(p_session_id, v_user);
  perform 1 from public.agent_sessions where id = p_session_id for update;
  select * into v_turn from public.agent_turns
  where session_id = p_session_id and status in ('awaiting_browser', 'awaiting_approval')
  order by number desc limit 1;
  if not found then
    raise exception 'The assistant is not waiting for you.' using errcode = 'P0001';
  end if;
  update public.agent_turns set status = 'running' where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;

create or replace function public.agent_close_turn(p_turn_id uuid, p_status text, p_error text)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_turn public.agent_turns;
  v_user uuid;
  v_credits int;
begin
  select s.user_id into v_user from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id where t.id = p_turn_id;
  perform public.lock_credit_owner(v_user);

  select * into v_turn from public.agent_turns where id = p_turn_id for update;
  if v_turn.status not in ('running', 'awaiting_browser', 'awaiting_approval') then
    return v_turn;
  end if;

  select least(v_turn.hold_credits, public.agent_credits(coalesce(sum(u.micro_usd), 0)::bigint))
    into v_credits
  from public.agent_usage u where u.turn_id = p_turn_id;

  if v_turn.hold_credits - v_credits > 0 then
    insert into public.credit_ledger(user_id, delta, reason)
    values (v_user, v_turn.hold_credits - v_credits, 'Assistant refund');
  end if;

  update public.agent_tool_calls set status = 'failed', result = '{"summary":"Not completed"}'::jsonb
  where turn_id = p_turn_id and status = 'pending';

  update public.agent_turns
  set status = p_status, error = left(p_error, 500), credits = v_credits, finished_at = now()
  where id = p_turn_id returning * into v_turn;

  update public.agent_sessions set lock_until = null, updated_at = now()
  where id = v_turn.session_id;
  return v_turn;
end;
$$;

create or replace function public.agent_stop(p_session_id uuid)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  perform public.agent_owned_session(p_session_id, v_user);
  select * into v_turn from public.agent_turns
  where session_id = p_session_id and status in ('running', 'awaiting_browser', 'awaiting_approval')
  order by number desc limit 1;
  if not found then
    return null;
  end if;
  return public.agent_close_turn(v_turn.id, 'stopped', null);
end;
$$;

create or replace function public.agent_begin_turn(p_session_id uuid, p_prompt text, p_content jsonb)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
  v_running public.agent_turns;
  v_hold int := public.agent_hold_credits();
  v_turn public.agent_turns;
  v_recent int;
begin
  if p_prompt is null or char_length(trim(p_prompt)) = 0 then
    raise exception 'Tell the assistant what to do.' using errcode = '22023';
  end if;
  if char_length(p_prompt) > 4000 then
    raise exception 'That request is too long. Keep it under 4000 characters.' using errcode = '22023';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'array' then
    raise exception 'Invalid assistant message.' using errcode = '22023';
  end if;

  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  select * into v_session from public.agent_sessions where id = p_session_id for update;

  select * into v_running from public.agent_turns
  where session_id = p_session_id and status in ('running', 'awaiting_browser', 'awaiting_approval')
  order by number desc limit 1;
  if found then
    if v_session.lock_until is not null and v_session.lock_until > now() then
      raise exception 'The assistant is already working on this clip.' using errcode = 'P0001';
    end if;
    perform public.agent_close_turn(v_running.id, 'failed', 'The assistant stopped responding.');
  end if;

  select count(*) into v_recent from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where s.user_id = v_user and t.created_at > now() - interval '1 hour';
  if v_recent >= 60 then
    raise exception 'Too many assistant requests. Try again in a few minutes.' using errcode = 'P0001';
  end if;

  if public.credit_balance(v_user) < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, public.credit_balance(v_user) using errcode = 'P0001';
  end if;

  insert into public.agent_turns(session_id, number, prompt, hold_credits)
  values (
    p_session_id,
    coalesce((select max(number) from public.agent_turns where session_id = p_session_id), 0) + 1,
    p_prompt, v_hold
  ) returning * into v_turn;

  insert into public.credit_ledger(user_id, delta, reason)
  values (v_user, -v_hold, 'Assistant hold');

  insert into public.agent_messages(session_id, turn_id, seq, role, content)
  values (
    p_session_id, v_turn.id,
    coalesce((select max(seq) from public.agent_messages where session_id = p_session_id), 0) + 1,
    'user', p_content
  );

  update public.agent_sessions
  set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;

create or replace function public.agent_mark_undone(p_turn_id uuid)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if v_turn.status in ('running', 'awaiting_browser', 'awaiting_approval') then
    raise exception 'Wait for the assistant to finish before undoing.' using errcode = 'P0001';
  end if;
  if v_turn.checkpoint_id is null then
    raise exception 'This request did not change the clip.' using errcode = '22023';
  end if;
  update public.agent_turns set undone_at = coalesce(undone_at, now())
  where id = p_turn_id returning * into v_turn;
  return v_turn;
end;
$$;

-- Checkpoint của lượt: revision của clip của phiên, hoặc của một clip trong
-- job của phiên project.
create or replace function public.agent_set_checkpoint(p_turn_id uuid, p_revision_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if not exists (
    select 1 from public.editor_revisions r
    join public.clips c on c.id = r.clip_id
    join public.agent_sessions s on s.id = v_turn.session_id
    where r.id = p_revision_id and (s.clip_id = r.clip_id or s.job_id = c.job_id)
  ) then
    raise exception 'That version is no longer available.' using errcode = 'P0002';
  end if;
  update public.agent_turns set checkpoint_id = p_revision_id
  where id = p_turn_id and checkpoint_id is null;
end;
$$;

revoke execute on function public.agent_open_project_session(uuid, text) from public, anon;
revoke execute on function public.agent_pause_turn(uuid, text) from public, anon;
revoke execute on function public.agent_close_turn(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.agent_owned_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agent_open_project_session(uuid, text) to authenticated;
grant execute on function public.agent_pause_turn(uuid, text) to authenticated;

commit;
