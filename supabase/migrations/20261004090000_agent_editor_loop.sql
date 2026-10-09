-- Agent editor AE3 (spec docs/specs/2026-09-26-agent-editor.md §5).
--
-- Một lượt Assistant không còn trần bước; nó dừng giữa hai request khi:
--   awaiting_input    — agent hỏi người dùng (`ask_user`), chờ câu trả lời;
--   awaiting_continue — pause_reason 'time': chạm trần thời gian của MỘT request
--                       HTTP, tab tự gọi nối tiếp;
--                       pause_reason 'budget': đã tiêu hết credit giữ, người
--                       dùng duyệt "Continue for N credits?" → agent_extend_hold.
-- Mọi hàm có danh sách trạng thái "đang chạy" được viết lại để biết hai trạng
-- thái mới: bỏ sót một hàm là một lượt treo không Stop được, không chốt được.

alter table public.agent_turns add column if not exists pause_reason text;
alter table public.agent_turns drop constraint if exists agent_turns_pause_reason_check;
alter table public.agent_turns add constraint agent_turns_pause_reason_check
  check (pause_reason is null or pause_reason in ('browser', 'approval', 'input', 'time', 'budget'));

alter table public.agent_turns drop constraint if exists agent_turns_status_check;
alter table public.agent_turns add constraint agent_turns_status_check
  check (status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue',
                    'done', 'failed', 'stopped'));

-- Mỗi lần gia hạn giữ thêm đúng ngần này; trùng `AGENT_EXTEND_CREDITS` ở TS.
create or replace function public.agent_extend_credits()
returns int language sql immutable as $$ select 10 $$;

-- ------------------------------------------------------------ tạm dừng
create or replace function public.agent_pause_turn(p_turn_id uuid, p_reason text default 'browser')
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if p_reason is null or p_reason not in ('browser', 'approval', 'input', 'time', 'budget') then
    raise exception 'Invalid pause reason.' using errcode = '22023';
  end if;
  update public.agent_turns
  set status = case p_reason
        when 'approval' then 'awaiting_approval'
        when 'browser' then 'awaiting_browser'
        when 'input' then 'awaiting_input'
        else 'awaiting_continue' end,
      pause_reason = p_reason
  where id = p_turn_id and status = 'running';
  if not found then
    raise exception 'This assistant turn was stopped.' using errcode = 'P0001';
  end if;
  -- Chờ người (duyệt, trả lời, gia hạn) có thể lâu; chờ tab (chụp, nối tiếp) thì không.
  update public.agent_sessions
  set lock_until = now() + case when p_reason in ('approval', 'input', 'budget') then interval '30 minutes'
                                else interval '6 minutes' end,
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
  where session_id = p_session_id
    and status in ('awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
  order by number desc limit 1;
  if not found then
    raise exception 'The assistant is not waiting for you.' using errcode = 'P0001';
  end if;
  -- Hết credit giữ: chỉ gia hạn (agent_extend_hold) mới chạy tiếp được.
  if v_turn.status = 'awaiting_continue' and v_turn.pause_reason = 'budget' then
    raise exception 'Approve more credits to let the assistant continue.' using errcode = 'P0001';
  end if;
  update public.agent_turns set status = 'running', pause_reason = null where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;

-- Người dùng duyệt "Continue for N credits?": giữ thêm N credit rồi chạy tiếp.
create or replace function public.agent_extend_hold(p_session_id uuid)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int := public.agent_extend_credits();
begin
  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  select * into v_turn from public.agent_turns
  where session_id = p_session_id and status = 'awaiting_continue' and pause_reason = 'budget'
  order by number desc limit 1
  for update;
  if not found then
    raise exception 'The assistant is not waiting for more credits.' using errcode = 'P0001';
  end if;
  if public.credit_balance(v_user) < v_more then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_more, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  insert into public.credit_ledger(user_id, delta, reason) values (v_user, -v_more, 'Assistant hold');
  update public.agent_turns
  set hold_credits = hold_credits + v_more, status = 'running', pause_reason = null
  where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;

-- ------------------------------------------------------------ chốt, Stop, lượt mới, Undo
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
  if v_turn.status not in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue') then
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
  set status = p_status, pause_reason = null, error = left(p_error, 500), credits = v_credits, finished_at = now()
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
  where session_id = p_session_id
    and status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
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
  where session_id = p_session_id
    and status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
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
  if v_turn.status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue') then
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

-- ------------------------------------------------------------ New chat
-- "New chat" của panel: luôn một phiên MỚI cho clip + model (lịch sử chat là
-- danh sách phiên của clip). `agent_open_session` vẫn trả phiên mới nhất.
create or replace function public.agent_new_session(p_clip_id uuid, p_model text)
returns public.agent_sessions language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
  v_busy boolean;
begin
  perform public.owned_clip(p_clip_id, v_user);
  if p_model is null or char_length(p_model) > 64 or not exists (
    select 1 from public.agent_model_prices p
    where p.allowed and p.pattern <> 'default' and p_model like p.pattern
  ) then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  -- Một lượt đang sửa clip ở phiên khác: phiên mới sẽ ghi chen vào bài của nó.
  select exists (
    select 1 from public.agent_sessions s
    where s.clip_id = p_clip_id and s.user_id = v_user and s.lock_until is not null and s.lock_until > now()
  ) into v_busy;
  if v_busy then
    raise exception 'The assistant is already working on this clip.' using errcode = 'P0001';
  end if;
  insert into public.agent_sessions(user_id, clip_id, model)
  values (v_user, p_clip_id, p_model) returning * into v_session;
  return v_session;
end;
$$;

revoke execute on function public.agent_new_session(uuid, text) from public, anon;
grant execute on function public.agent_new_session(uuid, text) to authenticated;
revoke execute on function public.agent_extend_hold(uuid) from public, anon;
grant execute on function public.agent_extend_hold(uuid) to authenticated;
grant execute on function public.agent_extend_credits() to authenticated;
