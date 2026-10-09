-- Assistant đa provider + tool chạy ở trình duyệt (spec AI Studio P3).
--
-- 1. Giá theo MODEL, không còn cứng theo Claude Opus: phiên có thể chạy
--    Gemini hay Claude, và credit phải phản ánh đúng thứ đã tiêu.
-- 2. Phiên gắn với MỘT model: lịch sử lưu ở dạng native của provider (content
--    block của Claude, `parts` của Gemini kèm `thoughtSignature`), không đổi
--    qua lại được. Đổi model thì mở phiên mới.
-- 3. `capture_frames` chạy ở trình duyệt: lượt TẠM DỪNG (`awaiting_browser`)
--    giữa hai request, kết quả tool đã có của cùng bước được giữ lại để ghép
--    một tin nhắn duy nhất khi trình duyệt trả ảnh về.

begin;

-- ------------------------------------------------------------ bảng giá
--
-- Micro-USD mỗi token. `pattern` là mẫu LIKE trên id model; dòng khớp có
-- `priority` nhỏ nhất thắng. `default` là giá cao nhất bảng: model lạ không
-- bao giờ được tính 0.
create table if not exists public.agent_model_prices (
  pattern      text primary key,
  priority     int not null,
  input        numeric not null check (input >= 0),
  output       numeric not null check (output >= 0),
  cache_read   numeric not null check (cache_read >= 0),
  cache_write  numeric not null check (cache_write >= 0),
  -- Chỉ dòng `allowed` mới mở phiên được. `default` chỉ để tính tiền.
  allowed      boolean not null default true,
  note         text
);
alter table public.agent_model_prices enable row level security;
-- Không ai đọc qua API; hàm security definer đọc.

insert into public.agent_model_prices (pattern, priority, input, output, cache_read, cache_write, allowed, note) values
  ('claude-opus-5%', 10, 5, 25, 0.5, 6.25, true, 'Giá niêm yết Claude Opus 5 (và Opus 4.8, model fallback).'),
  -- TẠM: trang giá của Google bị chặn ở máy build. Đặt ở mức cao so với các
  -- đời Gemini Pro đã biết để không bán lỗ; xác nhận ở COSTS.md §6b.
  ('gemini-%pro%', 20, 2.5, 15, 0.25, 2.5, true, 'TẠM — chờ xác nhận giá Gemini Pro.'),
  ('gemini-%flash%', 30, 0.5, 3, 0.05, 0.5, true, 'TẠM — chờ xác nhận giá Gemini Flash.'),
  ('fake', 40, 5, 25, 0.5, 6.25, true, 'Claude giả của CI/E2E — tính như Opus để test đường credit.'),
  ('default', 1000, 5, 25, 0.5, 6.25, false, 'Model không có trong bảng: giá cao nhất.')
on conflict (pattern) do nothing;

create or replace function public.agent_price(p_model text)
returns public.agent_model_prices language sql stable security definer set search_path = public as $$
  select p.* from public.agent_model_prices p
  where p.pattern <> 'default' and coalesce(p_model, '') like p.pattern
  union all
  select p.* from public.agent_model_prices p where p.pattern = 'default'
  order by priority limit 1;
$$;

drop function if exists public.agent_micro_usd(bigint, bigint, bigint, bigint);
create or replace function public.agent_micro_usd(
  p_model text, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint
)
returns bigint language plpgsql stable security definer set search_path = public as $$
declare
  v_price public.agent_model_prices := public.agent_price(p_model);
begin
  return ceil(p_input * v_price.input + p_output * v_price.output
    + p_cache_read * v_price.cache_read + p_cache_write * v_price.cache_write)::bigint;
end;
$$;

create or replace function public.agent_record_usage(
  p_turn_id uuid, p_model text, p_input int, p_output int, p_cache_read int, p_cache_write int
)
returns int language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_total bigint;
begin
  perform public.agent_owned_turn(p_turn_id, v_user);
  if least(p_input, p_output, p_cache_read, p_cache_write) < 0 then
    raise exception 'Invalid usage.' using errcode = '22023';
  end if;
  insert into public.agent_usage(turn_id, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, micro_usd)
  values (p_turn_id, left(coalesce(p_model, 'unknown'), 64), p_input, p_output, p_cache_read, p_cache_write,
    public.agent_micro_usd(p_model, p_input, p_output, p_cache_read, p_cache_write));
  select coalesce(sum(micro_usd), 0)::bigint into v_total from public.agent_usage where turn_id = p_turn_id;
  return public.agent_credits(v_total);
end;
$$;

-- ------------------------------------------------------------ phiên theo model
create or replace function public.agent_open_session(p_clip_id uuid, p_model text)
returns public.agent_sessions language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
begin
  perform public.owned_clip(p_clip_id, v_user);
  if p_model is null or char_length(p_model) > 64 or not exists (
    select 1 from public.agent_model_prices p
    where p.allowed and p.pattern <> 'default' and p_model like p.pattern
  ) then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  -- Lịch sử là dạng native của model: chỉ nối tiếp được trên CÙNG model.
  select * into v_session from public.agent_sessions
  where clip_id = p_clip_id and user_id = v_user and model = p_model
  order by created_at desc limit 1;
  if found then
    return v_session;
  end if;
  insert into public.agent_sessions(user_id, clip_id, model)
  values (v_user, p_clip_id, p_model) returning * into v_session;
  return v_session;
end;
$$;

-- ------------------------------------------------------------ chờ trình duyệt
alter table public.agent_turns drop constraint if exists agent_turns_status_check;
alter table public.agent_turns add constraint agent_turns_status_check
  check (status in ('running', 'awaiting_browser', 'done', 'failed', 'stopped'));

alter table public.agent_tool_calls drop constraint if exists agent_tool_calls_status_check;
alter table public.agent_tool_calls add constraint agent_tool_calls_status_check
  check (status in ('pending', 'done', 'failed'));
-- Nội dung tool_result đã gửi (hoặc sẽ gửi) cho model — để ghép lại MỘT tin
-- nhắn khi phần trình duyệt của bước trả về.
alter table public.agent_tool_calls add column if not exists content jsonb;

create or replace function public.agent_record_tool(
  p_turn_id uuid, p_tool_use_id text, p_name text, p_input jsonb, p_status text, p_result jsonb,
  p_content jsonb default null
)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  perform public.agent_owned_turn(p_turn_id, v_user);
  if p_status not in ('pending', 'done', 'failed') then
    raise exception 'Invalid tool status.' using errcode = '22023';
  end if;
  insert into public.agent_tool_calls(turn_id, tool_use_id, name, input, status, result, content)
  values (p_turn_id, p_tool_use_id, p_name, coalesce(p_input, '{}'::jsonb), p_status, p_result, p_content);
end;
$$;
drop function if exists public.agent_record_tool(uuid, text, text, jsonb, text, jsonb);

-- Hoàn tất một tool đang `pending` (kết quả từ trình duyệt).
create or replace function public.agent_complete_tool(
  p_turn_id uuid, p_tool_use_id text, p_status text, p_result jsonb
)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  perform public.agent_owned_turn(p_turn_id, v_user);
  if p_status not in ('done', 'failed') then
    raise exception 'Invalid tool status.' using errcode = '22023';
  end if;
  update public.agent_tool_calls set status = p_status, result = p_result
  where turn_id = p_turn_id and tool_use_id = p_tool_use_id and status = 'pending';
  if not found then
    raise exception 'That tool call is not waiting for a result.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.agent_pause_turn(p_turn_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  update public.agent_turns set status = 'awaiting_browser'
  where id = p_turn_id and status = 'running';
  if not found then
    raise exception 'This assistant turn was stopped.' using errcode = 'P0001';
  end if;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
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
  where session_id = p_session_id and status = 'awaiting_browser'
  order by number desc limit 1;
  if not found then
    raise exception 'The assistant is not waiting for the editor.' using errcode = 'P0001';
  end if;
  update public.agent_turns set status = 'running' where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;

-- `agent_append` giữ nguyên: chỉ nối vào lượt `running`, nên lượt đang chờ
-- trình duyệt phải `agent_resume_turn` trước. Chốt, Stop và lượt treo thì xử
-- lý cả `awaiting_browser`, và tool còn `pending` khi chốt thành `failed`.
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
  if v_turn.status not in ('running', 'awaiting_browser') then
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
  where session_id = p_session_id and status in ('running', 'awaiting_browser')
  order by number desc limit 1;
  if not found then
    return null;
  end if;
  return public.agent_close_turn(v_turn.id, 'stopped', null);
end;
$$;

-- Lượt mới: lượt đang chạy HOẶC đang chờ trình duyệt còn khoá thì chặn; hết
-- khoá thì chốt nó như lượt treo.
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
  where session_id = p_session_id and status in ('running', 'awaiting_browser')
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
  if v_turn.status in ('running', 'awaiting_browser') then
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

-- ------------------------------------------------------------ quyền
revoke execute on function public.agent_price(text) from public, anon, authenticated;
revoke execute on function public.agent_micro_usd(text, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.agent_close_turn(uuid, text, text) from public, anon, authenticated;

revoke execute on function public.agent_record_tool(uuid, text, text, jsonb, text, jsonb, jsonb) from public, anon;
revoke execute on function public.agent_complete_tool(uuid, text, text, jsonb) from public, anon;
revoke execute on function public.agent_pause_turn(uuid) from public, anon;
revoke execute on function public.agent_resume_turn(uuid) from public, anon;

grant execute on function public.agent_record_tool(uuid, text, text, jsonb, text, jsonb, jsonb) to authenticated;
grant execute on function public.agent_complete_tool(uuid, text, text, jsonb) to authenticated;
grant execute on function public.agent_pause_turn(uuid) to authenticated;
grant execute on function public.agent_resume_turn(uuid) to authenticated;

commit;
