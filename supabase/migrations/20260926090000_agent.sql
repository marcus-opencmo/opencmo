-- Assistant (agent chat) cho một clip — spec AI Studio §6, phase P2.
--
-- Bốn bảng, một vòng đời: phiên (một clip) → lượt (một câu lệnh của người
-- dùng) → tin nhắn API chỉ-nối-thêm + tool call + usage. Mọi ghi đi qua RPC
-- có kiểm ownership; app đọc dưới RLS.
--
-- Vì sao lượt là một hàng riêng chứ không suy từ tin nhắn: lượt mang những
-- thứ có tiền và có khoá — credit giữ trước, checkpoint để Undo, trạng thái
-- chạy/dừng mà request sau (hoặc Stop) đọc được. Tin nhắn thì chỉ là lịch sử.

begin;

-- ------------------------------------------------------------ bảng
create table if not exists public.agent_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  clip_id     uuid not null references public.clips(id) on delete cascade,
  -- P4 mở thêm 'project'; tới đó check này đổi cùng migration của nó.
  scope       text not null default 'clip' check (scope in ('clip')),
  model       text not null check (char_length(model) between 1 and 64),
  -- Khoá mềm: có lượt đang chạy thì tới mốc này. Request chết giữa chừng thì
  -- khoá tự hết hạn, và lượt kế tiếp dọn lượt treo (`agent_begin_turn`).
  lock_until  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists agent_sessions_clip_idx on public.agent_sessions (clip_id, created_at desc);

create table if not exists public.agent_turns (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.agent_sessions(id) on delete cascade,
  number        int not null,
  prompt        text not null check (char_length(prompt) between 1 and 4000),
  status        text not null default 'running'
                check (status in ('running', 'done', 'failed', 'stopped')),
  error         text check (error is null or char_length(error) <= 500),
  -- Bản TRƯỚC lượt ghi đầu tiên của lượt này. Undo khôi phục đúng bản đó.
  checkpoint_id uuid references public.editor_revisions(id) on delete set null,
  undone_at     timestamptz,
  hold_credits  int not null check (hold_credits >= 0),
  credits       int check (credits is null or credits >= 0),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  unique (session_id, number)
);

-- Nguyên khối content của API (kể cả thinking): lịch sử chỉ nối thêm, không
-- sửa — thinking block và cache prompt đều đòi prefix giữ nguyên từng byte.
create table if not exists public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.agent_sessions(id) on delete cascade,
  turn_id     uuid not null references public.agent_turns(id) on delete cascade,
  seq         int not null,
  role        text not null check (role in ('user', 'assistant')),
  content     jsonb not null check (jsonb_typeof(content) = 'array'),
  created_at  timestamptz not null default now(),
  unique (session_id, seq)
);

create table if not exists public.agent_tool_calls (
  id           uuid primary key default gen_random_uuid(),
  turn_id      uuid not null references public.agent_turns(id) on delete cascade,
  tool_use_id  text not null check (char_length(tool_use_id) between 1 and 128),
  name         text not null check (char_length(name) between 1 and 64),
  input        jsonb not null,
  status       text not null check (status in ('done', 'failed')),
  result       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists agent_tool_calls_turn_idx on public.agent_tool_calls (turn_id, created_at);

create table if not exists public.agent_usage (
  id                  uuid primary key default gen_random_uuid(),
  turn_id             uuid not null references public.agent_turns(id) on delete cascade,
  model               text not null,
  input_tokens        int not null check (input_tokens >= 0),
  output_tokens       int not null check (output_tokens >= 0),
  cache_read_tokens   int not null check (cache_read_tokens >= 0),
  cache_write_tokens  int not null check (cache_write_tokens >= 0),
  micro_usd           bigint not null check (micro_usd >= 0),
  created_at          timestamptz not null default now()
);

-- Tin nhắn là bất biến: một byte đổi ở giữa là thinking block không còn hợp lệ.
create or replace function public.agent_messages_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Assistant messages cannot be changed.' using errcode = '55000';
end;
$$;
drop trigger if exists agent_messages_immutable on public.agent_messages;
create trigger agent_messages_immutable
  before update on public.agent_messages
  for each row execute function public.agent_messages_immutable();

-- ------------------------------------------------------------ RLS
alter table public.agent_sessions   enable row level security;
alter table public.agent_turns      enable row level security;
alter table public.agent_messages   enable row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.agent_usage      enable row level security;

drop policy if exists "đọc phiên assistant của mình" on public.agent_sessions;
create policy "đọc phiên assistant của mình" on public.agent_sessions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "đọc lượt assistant của mình" on public.agent_turns;
create policy "đọc lượt assistant của mình" on public.agent_turns
  for select to authenticated using (exists (
    select 1 from public.agent_sessions s
    where s.id = agent_turns.session_id and s.user_id = (select auth.uid())));

drop policy if exists "đọc tin nhắn assistant của mình" on public.agent_messages;
create policy "đọc tin nhắn assistant của mình" on public.agent_messages
  for select to authenticated using (exists (
    select 1 from public.agent_sessions s
    where s.id = agent_messages.session_id and s.user_id = (select auth.uid())));

drop policy if exists "đọc tool call assistant của mình" on public.agent_tool_calls;
create policy "đọc tool call assistant của mình" on public.agent_tool_calls
  for select to authenticated using (exists (
    select 1 from public.agent_turns t join public.agent_sessions s on s.id = t.session_id
    where t.id = agent_tool_calls.turn_id and s.user_id = (select auth.uid())));

drop policy if exists "đọc usage assistant của mình" on public.agent_usage;
create policy "đọc usage assistant của mình" on public.agent_usage
  for select to authenticated using (exists (
    select 1 from public.agent_turns t join public.agent_sessions s on s.id = t.session_id
    where t.id = agent_usage.turn_id and s.user_id = (select auth.uid())));

-- ------------------------------------------------------------ giá
--
-- Bảng giá sống ở SERVER (spec §6.8), không ở client. Micro-USD mỗi token theo
-- giá niêm yết của Claude Opus 5 (và Opus 4.8, model fallback, cùng giá):
-- $5 vào, $25 ra, đọc cache $0.50, ghi cache 5 phút $6.25 mỗi triệu token.
create or replace function public.agent_micro_usd(
  p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint
)
returns bigint language sql immutable set search_path = public as $$
  select ceil(p_input * 5 + p_output * 25 + p_cache_read * 0.5 + p_cache_write * 6.25)::bigint;
$$;

-- 1 credit = 50 000 micro-USD ($0.05) chi phí API — gấp đôi giá vốn ở gói
-- Starter ($15 / 150 credit = $0.10 mỗi credit). Lượt có dùng model thì tối
-- thiểu 1 credit. Con số là quyết định kinh doanh: ghi ở `COSTS.md`.
create or replace function public.agent_credits(p_micro_usd bigint)
returns int language sql immutable set search_path = public as $$
  select case when coalesce(p_micro_usd, 0) <= 0 then 0
              else greatest(1, ceil(p_micro_usd / 50000.0)::int) end;
$$;

-- Giữ trước mỗi lượt — cũng là TRẦN chi của lượt đó. Phải trùng
-- `AGENT_HOLD_CREDITS` ở `apps/web/lib/agent/limits.ts`.
create or replace function public.agent_hold_credits()
returns int language sql immutable set search_path = public as $$ select 5 $$;

-- ------------------------------------------------------------ helpers
create or replace function public.agent_owned_session(p_session_id uuid, p_user uuid)
returns public.agent_sessions language plpgsql stable security definer set search_path = public
as $$
declare
  v_session public.agent_sessions;
begin
  select s.* into v_session from public.agent_sessions s
  join public.clips c on c.id = s.clip_id
  join public.jobs j on j.id = c.job_id
  where s.id = p_session_id and s.user_id = p_user and j.purging_at is null;
  if not found then
    raise exception 'Assistant session not found.' using errcode = 'P0002';
  end if;
  return v_session;
end;
$$;

create or replace function public.agent_owned_turn(p_turn_id uuid, p_user uuid)
returns public.agent_turns language plpgsql stable security definer set search_path = public
as $$
declare
  v_turn public.agent_turns;
begin
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = p_user;
  if not found then
    raise exception 'Assistant turn not found.' using errcode = 'P0002';
  end if;
  return v_turn;
end;
$$;

-- Chốt một lượt: tính credit từ usage thật, hoàn phần dư của khoản giữ, gỡ
-- khoá. Gọi lại trên lượt đã chốt thì không làm gì — Stop và request đang chạy
-- có thể cùng chốt một lượt.
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
  if v_turn.status <> 'running' then
    return v_turn;
  end if;

  select least(v_turn.hold_credits, public.agent_credits(coalesce(sum(u.micro_usd), 0)::bigint))
    into v_credits
  from public.agent_usage u where u.turn_id = p_turn_id;

  if v_turn.hold_credits - v_credits > 0 then
    insert into public.credit_ledger(user_id, delta, reason)
    values (v_user, v_turn.hold_credits - v_credits, 'Assistant refund');
  end if;

  update public.agent_turns
  set status = p_status, error = left(p_error, 500), credits = v_credits, finished_at = now()
  where id = p_turn_id returning * into v_turn;

  update public.agent_sessions set lock_until = null, updated_at = now()
  where id = v_turn.session_id;
  return v_turn;
end;
$$;

-- ------------------------------------------------------------ RPC
-- Phiên mới nhất của clip này cho người này, hoặc một phiên mới.
create or replace function public.agent_open_session(p_clip_id uuid, p_model text)
returns public.agent_sessions language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
begin
  perform public.owned_clip(p_clip_id, v_user);
  if p_model is null or p_model not in ('claude-opus-5', 'fake') then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  select * into v_session from public.agent_sessions
  where clip_id = p_clip_id and user_id = v_user
  order by created_at desc limit 1;
  if found then
    return v_session;
  end if;
  insert into public.agent_sessions(user_id, clip_id, model)
  values (v_user, p_clip_id, p_model) returning * into v_session;
  return v_session;
end;
$$;

-- Bắt đầu một lượt: khoá phiên, giữ credit, ghi câu lệnh làm tin nhắn user.
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
  -- Cùng thứ tự khoá với mọi đường ghi credit: profile trước.
  perform public.lock_credit_owner(v_user);
  select * into v_session from public.agent_sessions where id = p_session_id for update;

  select * into v_running from public.agent_turns
  where session_id = p_session_id and status = 'running'
  order by number desc limit 1;
  if found then
    if v_session.lock_until is not null and v_session.lock_until > now() then
      raise exception 'The assistant is already working on this clip.' using errcode = 'P0001';
    end if;
    -- Request trước chết giữa chừng (tab đóng, function hết giờ): chốt nó theo
    -- usage đã ghi rồi mới cho lượt mới chạy.
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

-- Nối một tin nhắn vào lượt đang chạy. Lượt đã dừng (Stop) thì từ chối: đó là
-- cách vòng lặp đang chạy biết mà thôi.
create or replace function public.agent_append(p_turn_id uuid, p_role text, p_content jsonb)
returns int language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_seq int;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if p_role is null or p_role not in ('user', 'assistant') then
    raise exception 'Invalid assistant message.' using errcode = '22023';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'array' or pg_column_size(p_content) > 1048576 then
    raise exception 'Invalid assistant message.' using errcode = '22023';
  end if;
  perform 1 from public.agent_sessions where id = v_turn.session_id for update;
  select status into v_turn.status from public.agent_turns where id = p_turn_id;
  if v_turn.status <> 'running' then
    raise exception 'This assistant turn was stopped.' using errcode = 'P0001';
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.agent_messages where session_id = v_turn.session_id;
  insert into public.agent_messages(session_id, turn_id, seq, role, content)
  values (v_turn.session_id, p_turn_id, v_seq, p_role, p_content);
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = v_turn.session_id;
  return v_seq;
end;
$$;

create or replace function public.agent_record_tool(
  p_turn_id uuid, p_tool_use_id text, p_name text, p_input jsonb, p_status text, p_result jsonb
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
  insert into public.agent_tool_calls(turn_id, tool_use_id, name, input, status, result)
  values (p_turn_id, p_tool_use_id, p_name, coalesce(p_input, '{}'::jsonb), p_status, p_result);
end;
$$;

-- Ghi usage một bước; trả credit lượt này đã tiêu tới giờ, để vòng lặp dừng
-- trước khi vượt khoản giữ.
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
    public.agent_micro_usd(p_input, p_output, p_cache_read, p_cache_write));
  select coalesce(sum(micro_usd), 0)::bigint into v_total from public.agent_usage where turn_id = p_turn_id;
  return public.agent_credits(v_total);
end;
$$;

create or replace function public.agent_set_checkpoint(p_turn_id uuid, p_revision_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  -- Checkpoint phải là revision của CHÍNH clip này.
  if not exists (
    select 1 from public.editor_revisions r
    join public.agent_sessions s on s.clip_id = r.clip_id
    where r.id = p_revision_id and s.id = v_turn.session_id
  ) then
    raise exception 'That version is no longer available.' using errcode = 'P0002';
  end if;
  update public.agent_turns set checkpoint_id = p_revision_id
  where id = p_turn_id and checkpoint_id is null;
end;
$$;

create or replace function public.agent_finish_turn(p_turn_id uuid, p_status text, p_error text)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  perform public.agent_owned_turn(p_turn_id, v_user);
  if p_status not in ('done', 'failed', 'stopped') then
    raise exception 'Invalid turn status.' using errcode = '22023';
  end if;
  return public.agent_close_turn(p_turn_id, p_status, p_error);
end;
$$;

-- Stop: chốt lượt đang chạy. Vòng lặp đang chạy thấy ở lượt `agent_append` kế tiếp.
create or replace function public.agent_stop(p_session_id uuid)
returns public.agent_turns language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  perform public.agent_owned_session(p_session_id, v_user);
  select * into v_turn from public.agent_turns
  where session_id = p_session_id and status = 'running'
  order by number desc limit 1;
  if not found then
    return null;
  end if;
  return public.agent_close_turn(v_turn.id, 'stopped', null);
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
  if v_turn.status = 'running' then
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
revoke execute on function public.agent_messages_immutable() from public, anon, authenticated;
revoke execute on function public.agent_owned_session(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.agent_owned_turn(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.agent_close_turn(uuid, text, text) from public, anon, authenticated;

revoke execute on function public.agent_open_session(uuid, text) from public, anon;
revoke execute on function public.agent_begin_turn(uuid, text, jsonb) from public, anon;
revoke execute on function public.agent_append(uuid, text, jsonb) from public, anon;
revoke execute on function public.agent_record_tool(uuid, text, text, jsonb, text, jsonb) from public, anon;
revoke execute on function public.agent_record_usage(uuid, text, int, int, int, int) from public, anon;
revoke execute on function public.agent_set_checkpoint(uuid, uuid) from public, anon;
revoke execute on function public.agent_finish_turn(uuid, text, text) from public, anon;
revoke execute on function public.agent_stop(uuid) from public, anon;
revoke execute on function public.agent_mark_undone(uuid) from public, anon;

grant execute on function public.agent_open_session(uuid, text) to authenticated;
grant execute on function public.agent_begin_turn(uuid, text, jsonb) to authenticated;
grant execute on function public.agent_append(uuid, text, jsonb) to authenticated;
grant execute on function public.agent_record_tool(uuid, text, text, jsonb, text, jsonb) to authenticated;
grant execute on function public.agent_record_usage(uuid, text, int, int, int, int) to authenticated;
grant execute on function public.agent_set_checkpoint(uuid, uuid) to authenticated;
grant execute on function public.agent_finish_turn(uuid, text, text) to authenticated;
grant execute on function public.agent_stop(uuid) to authenticated;
grant execute on function public.agent_mark_undone(uuid) to authenticated;

commit;
