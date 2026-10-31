-- SINH TỰ ĐỘNG bởi scripts/dump-schema.sh — đừng sửa tay, đừng áp như migration.
--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status AS ENUM (
    'queued',
    'running',
    'done',
    'failed',
    'cancelled'
);


--
-- Name: account_is_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_is_paid(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    exists (
      select 1 from public.profiles p
      where p.id = p_user and (p.retention_exempt or p.plan <> 'free')
    )
    or exists (
      select 1 from public.polar_purchases o
      where o.user_id = p_user and o.paid_at is not null
        and o.total_amount > 0 and o.refunded_amount < o.total_amount
    )
    or exists (
      select 1 from public.polar_subscriptions s
      where s.user_id = p_user and s.status in ('active', 'past_due')
    );
$$;


--
-- Name: account_retention(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_retention() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_from timestamptz;
begin
  if v_user is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if public.account_is_paid(v_user) then
    return jsonb_build_object('paid', true, 'delete_after', null);
  end if;
  select retention_from into v_from from public.profiles where id = v_user;
  return jsonb_build_object('paid', false, 'delete_after', coalesce(v_from, now()) + interval '30 days');
end;
$$;


--
-- Name: account_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_summary() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_email text;
  v_plan text;
  v_limits record;
  v_preview int := 0;
  v_export int := 0;
  v_storage jsonb;
begin
  select email into v_email from auth.users where id = v_user;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(max(count), 0) into v_preview
  from public.rate_limits
  where user_id = v_user and bucket in ('preview', 'daily_preview')
    and window_start = to_timestamp(floor(extract(epoch from now()) / 86400) * 86400);
  select coalesce(max(count), 0) into v_export
  from public.rate_limits
  where user_id = v_user and bucket in ('export', 'daily_export')
    and window_start = to_timestamp(floor(extract(epoch from now()) / 86400) * 86400);
  v_storage := public.upload_usage();
  return jsonb_build_object(
    'email', v_email,
    'plan', v_plan,
    'credits', public.credit_balance(v_user),
    'job_hold_credits', public.job_hold_credits(),
    'quota', jsonb_build_object(
      'previews', jsonb_build_object('used', least(v_preview, v_limits.preview_daily), 'limit', v_limits.preview_daily),
      'exports', jsonb_build_object('used', least(v_export, v_limits.export_daily), 'limit', v_limits.export_daily),
      'storage', v_storage
    ),
    'resets_at', to_timestamp((floor(extract(epoch from now()) / 86400) + 1) * 86400)
  );
end;
$$;


--
-- Name: agent_3d_hold_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_3d_hold_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 20 $$;


--
-- Name: agent_append(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_append(p_turn_id uuid, p_role text, p_content jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_append_for(uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_append_for(p_user uuid, p_turn_id uuid, p_role text, p_content jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_turn public.agent_turns;
  v_seq int;
begin
  v_turn := public.agent_owned_turn(p_turn_id, p_user);
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


--
-- Name: agent_auto_extend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_auto_extend(p_turn_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := least(public.agent_extend_credits(), public.agent_auto_hold_cap() - v_turn.hold_credits);
  if v_turn.status <> 'running' or v_more <= 0 or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$$;


--
-- Name: agent_auto_hold_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_auto_hold_cap() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 60 $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    number integer NOT NULL,
    prompt text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    checkpoint_id uuid,
    undone_at timestamp with time zone,
    hold_credits integer NOT NULL,
    credits integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    pause_reason text,
    CONSTRAINT agent_turns_credits_check CHECK (((credits IS NULL) OR (credits >= 0))),
    CONSTRAINT agent_turns_error_check CHECK (((error IS NULL) OR (char_length(error) <= 500))),
    CONSTRAINT agent_turns_hold_credits_check CHECK ((hold_credits >= 0)),
    CONSTRAINT agent_turns_pause_reason_check CHECK (((pause_reason IS NULL) OR (pause_reason = ANY (ARRAY['browser'::text, 'approval'::text, 'input'::text, 'time'::text, 'steps'::text, 'budget'::text])))),
    CONSTRAINT agent_turns_prompt_check CHECK (((char_length(prompt) >= 1) AND (char_length(prompt) <= 4000))),
    CONSTRAINT agent_turns_status_check CHECK ((status = ANY (ARRAY['running'::text, 'awaiting_browser'::text, 'awaiting_approval'::text, 'awaiting_input'::text, 'awaiting_continue'::text, 'done'::text, 'failed'::text, 'stopped'::text])))
);


--
-- Name: agent_begin_turn(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_begin_turn(p_session_id uuid, p_prompt text, p_content jsonb) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_hold, 'Assistant hold');

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


--
-- Name: agent_close_turn(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_close_turn(p_turn_id uuid, p_status text, p_error text) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

  -- Hoàn phần giữ chưa dùng: đang giữ (= hold_credits) − số đã dùng.
  perform public.credit_settle(v_user, 'agent_turn', v_turn.id, v_credits, 'Assistant refund');

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


--
-- Name: agent_complete_tool(uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_complete_tool(p_turn_id uuid, p_tool_use_id text, p_status text, p_result jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  perform public.agent_owned_turn(p_turn_id, v_user);
  if p_status not in ('done', 'failed') then
    raise exception 'Invalid tool status.' using errcode = '22023';
  end if;
  if pg_column_size(p_result) > 262144 then
    raise exception 'This tool call is too large to save.' using errcode = '22023';
  end if;
  update public.agent_tool_calls set status = p_status, result = p_result
  where turn_id = p_turn_id and tool_use_id = p_tool_use_id and status = 'pending';
  if not found then
    raise exception 'That tool call is not waiting for a result.' using errcode = 'P0001';
  end if;
end;
$$;


--
-- Name: agent_credits(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_credits(p_micro_usd bigint) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case when coalesce(p_micro_usd, 0) <= 0 then 0
              else greatest(1, ceil(p_micro_usd / 50000.0)::int) end;
$$;


--
-- Name: agent_extend_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_extend_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 10 $$;


--
-- Name: agent_extend_hold(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_extend_hold(p_session_id uuid) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int := public.agent_extend_credits();
begin
  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  perform 1 from public.agent_sessions where id = p_session_id for update;
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
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold');
  update public.agent_turns
  set hold_credits = hold_credits + v_more, status = 'running', pause_reason = null
  where id = v_turn.id returning * into v_turn;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;


--
-- Name: agent_finish_turn(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_finish_turn(p_turn_id uuid, p_status text, p_error text) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_finish_turn_for(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_finish_turn_for(p_user uuid, p_turn_id uuid, p_status text, p_error text) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.agent_owned_turn(p_turn_id, p_user);
  if p_status not in ('done', 'failed', 'stopped') then
    raise exception 'Invalid turn status.' using errcode = '22023';
  end if;
  return public.agent_close_turn(p_turn_id, p_status, p_error);
end;
$$;


--
-- Name: agent_hold_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_hold_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 5 $$;


--
-- Name: agent_mark_undone(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_mark_undone(p_turn_id uuid) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_messages_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_messages_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  raise exception 'Assistant messages cannot be changed.' using errcode = '55000';
end;
$$;


--
-- Name: agent_micro_usd(text, bigint, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_micro_usd(p_model text, p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_price public.agent_model_prices := public.agent_price(p_model);
begin
  return ceil(p_input * v_price.input + p_output * v_price.output
    + p_cache_read * v_price.cache_read + p_cache_write * v_price.cache_write)::bigint;
end;
$$;


--
-- Name: agent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    clip_id uuid,
    scope text DEFAULT 'clip'::text NOT NULL,
    model text NOT NULL,
    lock_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    job_id uuid,
    CONSTRAINT agent_sessions_model_check CHECK (((char_length(model) >= 1) AND (char_length(model) <= 64))),
    CONSTRAINT agent_sessions_scope_check CHECK ((((scope = 'clip'::text) AND (clip_id IS NOT NULL) AND (job_id IS NULL)) OR ((scope = 'project'::text) AND (job_id IS NOT NULL) AND (clip_id IS NULL)) OR ((scope = 'cmo'::text) AND (clip_id IS NULL) AND (job_id IS NULL))))
);


--
-- Name: agent_new_session(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_new_session(p_clip_id uuid, p_model text) RETURNS public.agent_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_open_cmo_session(text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_open_cmo_session(p_model text, p_new boolean DEFAULT false) RETURNS public.agent_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_session public.agent_sessions;
begin
  if p_model is null or char_length(p_model) > 64 or not exists (
    select 1 from public.agent_model_prices p
    where p.allowed and p.pattern <> 'default' and p_model like p.pattern
  ) then
    raise exception 'Unknown assistant model.' using errcode = '22023';
  end if;
  if not coalesce(p_new, false) then
    select * into v_session from public.agent_sessions
    where user_id = v_user and scope = 'cmo' and model = p_model
    order by created_at desc limit 1;
    if found then
      return v_session;
    end if;
  end if;
  if (select count(*) from public.agent_sessions
      where user_id = v_user and scope = 'cmo' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many new conversations in the last hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.agent_sessions(user_id, scope, model)
  values (v_user, 'cmo', p_model) returning * into v_session;
  return v_session;
end;
$$;


--
-- Name: agent_open_session(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_open_session(p_clip_id uuid, p_model text) RETURNS public.agent_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_owned_session(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_owned_session(p_session_id uuid, p_user uuid) RETURNS public.agent_sessions
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_session public.agent_sessions;
begin
  select s.* into v_session from public.agent_sessions s
  left join public.clips c on c.id = s.clip_id
  left join public.jobs j on j.id = coalesce(s.job_id, c.job_id)
  where s.id = p_session_id and s.user_id = p_user
    and (s.scope = 'cmo' or (j.id is not null and j.purging_at is null));
  if not found then
    raise exception 'Assistant session not found.' using errcode = 'P0002';
  end if;
  return v_session;
end;
$$;


--
-- Name: agent_owned_turn(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_owned_turn(p_turn_id uuid, p_user uuid) RETURNS public.agent_turns
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_pause_turn(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_pause_turn(p_turn_id uuid, p_reason text DEFAULT 'browser'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  v_turn := public.agent_owned_turn(p_turn_id, v_user);
  if p_reason is null or p_reason not in ('browser', 'approval', 'input', 'time', 'steps', 'budget') then
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
  -- Waiting on a person (approve, answer, extend) can take a while; waiting on the tab cannot.
  update public.agent_sessions
  set lock_until = now() + case when p_reason in ('approval', 'input', 'budget') then interval '30 minutes'
                                else interval '6 minutes' end,
      updated_at = now()
  where id = v_turn.session_id;
end;
$$;


--
-- Name: agent_model_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_model_prices (
    pattern text NOT NULL,
    priority integer NOT NULL,
    input numeric NOT NULL,
    output numeric NOT NULL,
    cache_read numeric NOT NULL,
    cache_write numeric NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    note text,
    CONSTRAINT agent_model_prices_cache_read_check CHECK ((cache_read >= (0)::numeric)),
    CONSTRAINT agent_model_prices_cache_write_check CHECK ((cache_write >= (0)::numeric)),
    CONSTRAINT agent_model_prices_input_check CHECK ((input >= (0)::numeric)),
    CONSTRAINT agent_model_prices_output_check CHECK ((output >= (0)::numeric))
);


--
-- Name: agent_price(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_price(p_model text) RETURNS public.agent_model_prices
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.* from public.agent_model_prices p
  where p.pattern <> 'default' and coalesce(p_model, '') like p.pattern
  union all
  select p.* from public.agent_model_prices p where p.pattern = 'default'
  order by priority limit 1;
$$;


--
-- Name: agent_raise_hold_3d(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_raise_hold_3d(p_turn_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := public.agent_3d_hold_credits() - v_turn.hold_credits;
  -- An explainer turn previews its scene like a 3D turn and needs the same bigger hold.
  if v_turn.status <> 'running' or v_more <= 0
     or not exists (select 1 from public.agent_tool_calls c
                    where c.turn_id = v_turn.id and c.name in ('preview_3d', 'preview_explainer'))
     or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold (3D)');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$$;


--
-- Name: agent_reap_turns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_reap_turns() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_turn record;
  v_count integer := 0;
begin
  for v_turn in
    select t.id, t.status, t.session_id, s.user_id
    from public.agent_turns t
    join public.agent_sessions s on s.id = t.session_id
    where (t.status in ('running', 'awaiting_browser') and (s.lock_until is null or s.lock_until < now()))
       or (t.status in ('awaiting_approval', 'awaiting_input', 'awaiting_continue') and s.updated_at < now() - interval '24 hours')
    order by t.created_at
    limit 200
  loop
    -- Credit owner, then session, as every turn RPC; a user or session in use right now is left
    -- for the next sweep.
    perform 1 from public.profiles where id = v_turn.user_id for update skip locked;
    if not found and exists (select 1 from public.profiles where id = v_turn.user_id) then
      continue;
    end if;
    perform 1 from public.agent_sessions where id = v_turn.session_id for update skip locked;
    if not found then
      continue;
    end if;
    perform public.agent_close_turn(
      v_turn.id,
      case when v_turn.status = 'running' then 'failed' else 'stopped' end,
      case when v_turn.status = 'running' then 'The assistant stopped responding.' else null end
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;


--
-- Name: agent_record_tool(uuid, text, text, jsonb, text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_record_tool(p_turn_id uuid, p_tool_use_id text, p_name text, p_input jsonb, p_status text, p_result jsonb, p_content jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_record_tool_for(uuid, uuid, text, text, jsonb, text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_record_tool_for(p_user uuid, p_turn_id uuid, p_tool_use_id text, p_name text, p_input jsonb, p_status text, p_result jsonb, p_content jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.agent_owned_turn(p_turn_id, p_user);
  if p_status not in ('pending', 'done', 'failed') then
    raise exception 'Invalid tool status.' using errcode = '22023';
  end if;
  -- 256 KB each: far above any real tool call, far below what bloats the table.
  if pg_column_size(p_input) > 262144 or pg_column_size(p_result) > 262144 or pg_column_size(p_content) > 262144 then
    raise exception 'This tool call is too large to save.' using errcode = '22023';
  end if;
  insert into public.agent_tool_calls(turn_id, tool_use_id, name, input, status, result, content)
  values (p_turn_id, p_tool_use_id, p_name, coalesce(p_input, '{}'::jsonb), p_status, p_result, p_content);
end;
$$;


--
-- Name: agent_record_usage(uuid, text, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_record_usage(p_turn_id uuid, p_model text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_record_usage_for(uuid, uuid, text, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_record_usage_for(p_user uuid, p_turn_id uuid, p_model text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_total bigint;
  v_turn public.agent_turns;
  v_credits int;
begin
  perform public.agent_owned_turn(p_turn_id, p_user);
  if least(p_input, p_output, p_cache_read, p_cache_write) < 0 then
    raise exception 'Invalid usage.' using errcode = '22023';
  end if;
  -- Same lock as agent_close_turn: a close either counts this row or sees the turn closed after it.
  perform public.lock_credit_owner(p_user);
  insert into public.agent_usage(turn_id, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, micro_usd)
  values (p_turn_id, left(coalesce(p_model, 'unknown'), 64), p_input, p_output, p_cache_read, p_cache_write,
    public.agent_micro_usd(p_model, p_input, p_output, p_cache_read, p_cache_write));
  select coalesce(sum(micro_usd), 0)::bigint into v_total from public.agent_usage where turn_id = p_turn_id;

  select * into v_turn from public.agent_turns where id = p_turn_id for update;
  if v_turn.status not in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue') then
    -- Already settled: charge what this usage adds, up to the hold the user approved and never
    -- past the balance (the hold was given back at the close and may be spent since).
    v_credits := least(v_turn.hold_credits, public.agent_credits(v_total));
    if v_credits > coalesce(v_turn.credits, 0) then
      v_credits := coalesce(v_turn.credits, 0)
        + least(v_credits - coalesce(v_turn.credits, 0), greatest(public.credit_balance(p_user), 0));
      perform public.credit_settle(p_user, 'agent_turn', p_turn_id, v_credits, 'Assistant usage after Stop');
      update public.agent_turns set credits = v_credits where id = p_turn_id;
    end if;
  end if;
  return public.agent_credits(v_total);
end;
$$;


--
-- Name: agent_resume_turn(uuid, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_resume_turn(p_session_id uuid, p_waiting text DEFAULT NULL::text, p_tool_use_ids text[] DEFAULT NULL::text[]) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  perform public.agent_owned_session(p_session_id, v_user);
  perform public.lock_credit_owner(v_user);
  perform 1 from public.agent_sessions where id = p_session_id for update;
  select * into v_turn from public.agent_turns
  where session_id = p_session_id
    and status in ('awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
  order by number desc limit 1
  for update;
  if not found then
    raise exception 'The assistant is not waiting for you.' using errcode = 'P0001';
  end if;
  if p_waiting is not null and v_turn.status <> p_waiting then
    raise exception 'The assistant is not waiting for that any more. Reload the chat.' using errcode = 'P0001';
  end if;
  if p_tool_use_ids is not null and exists (
    select unnest(p_tool_use_ids)
    except
    select tool_use_id from public.agent_tool_calls where turn_id = v_turn.id and status = 'pending'
  ) then
    raise exception 'The assistant is not waiting for that any more. Reload the chat.' using errcode = 'P0001';
  end if;
  -- Out of held credits: only agent_extend_hold lets the turn continue.
  if v_turn.status = 'awaiting_continue' and v_turn.pause_reason = 'budget' then
    raise exception 'Approve more credits to let the assistant continue.' using errcode = 'P0001';
  end if;
  update public.agent_turns set status = 'running', pause_reason = null
  where id = v_turn.id
    and status in ('awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
  returning * into v_turn;
  if not found then
    raise exception 'The assistant is not waiting for you.' using errcode = 'P0001';
  end if;
  update public.agent_sessions set lock_until = now() + interval '6 minutes', updated_at = now()
  where id = p_session_id;
  return v_turn;
end;
$$;


--
-- Name: agent_set_checkpoint(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_set_checkpoint(p_turn_id uuid, p_revision_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: agent_stop(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_stop(p_session_id uuid) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
begin
  perform public.agent_owned_session(p_session_id, v_user);
  -- Credit owner, then session, as agent_begin_turn: Stop waits for a resume in flight.
  perform public.lock_credit_owner(v_user);
  perform 1 from public.agent_sessions where id = p_session_id for update;
  select * into v_turn from public.agent_turns
  where session_id = p_session_id
    and status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue')
  order by number desc limit 1
  for update;
  if not found then
    return null;
  end if;
  return public.agent_close_turn(v_turn.id, 'stopped', null);
end;
$$;


--
-- Name: ai_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_models (
    id text NOT NULL,
    kind text NOT NULL,
    provider text NOT NULL,
    name text NOT NULL,
    price jsonb NOT NULL,
    limits jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT ai_models_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'voice'::text, 'audio'::text])))
);


--
-- Name: ai_check_spec(public.ai_models, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_check_spec(p_model public.ai_models, p_spec jsonb) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $_$
declare
  v_allowed text[] := case p_model.kind
    when 'image' then array['prompt', 'aspectRatio', 'seed']
    when 'video' then array['prompt', 'aspectRatio', 'duration', 'seed']
    when 'voice' then array['prompt', 'voice', 'seed']
    when 'audio' then array['prompt', 'duration', 'seed']
  end;
  v_prompt text;
  v_scene boolean := coalesce((p_model.limits->>'scene')::boolean, false);
  v_max_refs int := coalesce((p_model.limits->>'maxReferences')::int, 0);
  v_source boolean := coalesce((p_model.limits->>'sourceVideo')::boolean, false);
  -- A narrated video (explainer) takes a voice, like a voiceover.
  v_voiced boolean := p_model.kind = 'voice' or (p_model.kind = 'video' and p_model.limits ? 'voices');
  v_explainer boolean := p_model.provider = 'opencmo-motion';
  -- The scene template a motion model renders: narrated explainers take voices, silent clips do not.
  v_template text := case when p_model.provider = 'opencmo-motion'
    then case when p_model.limits ? 'voices' then 'explainer' else 'clip' end end;
  v_beat jsonb;
  v_seconds numeric := 0;
begin
  if v_scene then
    v_allowed := v_allowed || array['scene'];
  end if;
  if p_model.kind in ('image', 'video') then
    if p_model.limits ? 'resolutions' then v_allowed := v_allowed || array['resolution']; end if;
    if v_max_refs > 0 then v_allowed := v_allowed || array['references']; end if;
  end if;
  if p_model.kind = 'video' then
    if coalesce((p_model.limits->>'firstFrame')::boolean, false) then v_allowed := v_allowed || array['startImage', 'after']; end if;
    if coalesce((p_model.limits->>'lastFrame')::boolean, false) then v_allowed := v_allowed || array['endImage']; end if;
    if coalesce((p_model.limits->>'audio')::boolean, false) then v_allowed := v_allowed || array['audio']; end if;
    if v_source then v_allowed := v_allowed || array['sourceVideo', 'sourceStart']; end if;
    if v_voiced then v_allowed := v_allowed || array['voice']; end if;
  end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_spec) k where k <> all (v_allowed)) then
    raise exception 'This request has settings the model does not take.' using errcode = '22023';
  end if;
  v_prompt := case when jsonb_typeof(p_spec->'prompt') = 'string' then p_spec->>'prompt' end;
  if v_prompt is null or btrim(v_prompt) = '' then
    raise exception 'Write a prompt first.' using errcode = '22023';
  end if;
  if length(v_prompt) > (p_model.limits->>'maxPromptChars')::int then
    raise exception 'Keep the prompt under % characters.', p_model.limits->>'maxPromptChars' using errcode = '22023';
  end if;
  if p_spec ? 'seed' and (jsonb_typeof(p_spec->'seed') <> 'number'
      or (p_spec->>'seed')::numeric <> trunc((p_spec->>'seed')::numeric)
      or (p_spec->>'seed')::numeric not between 0 and 2147483647) then
    raise exception 'Invalid seed.' using errcode = '22023';
  end if;
  if p_model.kind in ('image', 'video') and (jsonb_typeof(p_spec->'aspectRatio') is distinct from 'string'
      or not coalesce(p_model.limits->'aspectRatios' ? (p_spec->>'aspectRatio'), false)) then
    raise exception '% does not support that aspect ratio.', p_model.name using errcode = '22023';
  end if;
  if p_model.kind = 'video' and (jsonb_typeof(p_spec->'duration') is distinct from 'number'
      or not (p_model.limits->'durations') @> jsonb_build_array(p_spec->'duration')) then
    raise exception '% does not support that duration.', p_model.name using errcode = '22023';
  end if;
  if p_spec ? 'resolution' and (jsonb_typeof(p_spec->'resolution') is distinct from 'string'
      or not coalesce(p_model.limits->'resolutions' ? (p_spec->>'resolution'), false)) then
    raise exception '% does not support that resolution.', p_model.name using errcode = '22023';
  end if;
  if p_spec ? 'audio' and jsonb_typeof(p_spec->'audio') is distinct from 'boolean' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  -- A shot that continues the previous one (/video): `after` is the parent's spec hash; the
  -- worker starts it from the parent's last frame, so it cannot also start from an image.
  if p_spec ? 'after' and (jsonb_typeof(p_spec->'after') is distinct from 'string'
      or p_spec->>'after' !~ '^[0-9a-f]{64}$') then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  if p_spec ? 'after' and p_spec ? 'startImage' then
    raise exception 'A shot that continues the previous one cannot also start from an image.' using errcode = '22023';
  end if;
  if (p_spec ? 'startImage' and not public.ai_media_ref_ok(p_spec->'startImage'))
      or (p_spec ? 'endImage' and not public.ai_media_ref_ok(p_spec->'endImage')) then
    raise exception 'That image was not found in your library.' using errcode = '22023';
  end if;
  -- Video-to-video: the source is required and the caller's own. Background removal and the
  -- edit models flagged `clipVideo` may also read the clip's own video (`renders:` / `sources:`);
  -- upscale only library files.
  if v_source then
    if not (p_spec ? 'sourceVideo') or not (
        public.ai_media_ref_ok(p_spec->'sourceVideo')
        or ((coalesce((p_model.limits->>'removeBackground')::boolean, false)
             or coalesce((p_model.limits->>'clipVideo')::boolean, false))
            and public.ai_clip_video_ref_ok(p_spec->'sourceVideo'))) then
      raise exception 'Choose a video from your library to edit.' using errcode = '22023';
    end if;
    if jsonb_typeof(p_spec->'sourceStart') is distinct from 'number' or (p_spec->>'sourceStart')::numeric < 0 then
      raise exception 'Invalid generation request.' using errcode = '22023';
    end if;
  end if;
  if p_spec ? 'references' then
    if jsonb_typeof(p_spec->'references') is distinct from 'array'
        or jsonb_array_length(p_spec->'references') not between 1 and v_max_refs then
      raise exception '% takes up to % reference images.', p_model.name, v_max_refs using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_spec->'references') r where not public.ai_media_ref_ok(r)) then
      raise exception 'That image was not found in your library.' using errcode = '22023';
    end if;
  end if;
  if v_scene and (jsonb_typeof(p_spec->'scene') is distinct from 'object'
      or jsonb_typeof(p_spec->'scene'->'template') is distinct from 'string') then
    raise exception 'Describe the 3D scene first.' using errcode = '22023';
  end if;
  if v_scene and octet_length((case when v_explainer then (p_spec->'scene') - 'assets' else p_spec->'scene' end)::text) > 4000 then
    raise exception 'This 3D scene has too much data.' using errcode = '22023';
  end if;
  -- Explainers: the explainer model takes only explainer scenes, and only it takes them. The
  -- script is checked here because the price and the voice are computed from it.
  if v_scene and v_explainer and p_spec->'scene'->>'template' is distinct from v_template then
    if v_template = 'clip' then
      raise exception 'This motion clip is not valid. Write it again.' using errcode = '22023';
    end if;
    raise exception 'This explainer script is not valid. Write it again.' using errcode = '22023';
  end if;
  if v_scene and not v_explainer and p_spec->'scene'->>'template' in ('explainer', 'clip') then
    raise exception 'Describe the 3D scene first.' using errcode = '22023';
  end if;
  if v_explainer and (
      jsonb_typeof(p_spec->'scene'->'code_ref') is distinct from 'string'
      or not exists (select 1 from public.scene_codes c
                     where c.user_id = auth.uid() and c.hash = p_spec->'scene'->>'code_ref')) then
    raise exception 'This explainer code was not found. Preview it again.' using errcode = '22023';
  end if;
  if v_explainer and (
      jsonb_typeof(p_spec->'scene'->'title') is distinct from 'string'
      or length(btrim(p_spec->'scene'->>'title')) not between 1 and 60
      or jsonb_typeof(p_spec->'scene'->'beats') is distinct from 'array'
      -- Explainers: 3-16 narrated beats; silent clips (motion quality B1): 1-8 timed beats.
      or jsonb_array_length(p_spec->'scene'->'beats') not between
         case v_template when 'clip' then 1 else 3 end and case v_template when 'clip' then 8 else 16 end
      or (p_spec->'scene' ? 'accent' and (jsonb_typeof(p_spec->'scene'->'accent') is distinct from 'string'
          or p_spec->'scene'->>'accent' !~ '^#[0-9a-fA-F]{6}$'))
      -- v2: the look and the motion personality, the same names as `THEMES` and
      -- `PERSONALITIES` in packages/clip-motion/src/job.ts. Both optional.
      or (p_spec->'scene' ? 'theme' and (jsonb_typeof(p_spec->'scene'->'theme') is distinct from 'string'
          or p_spec->'scene'->>'theme' not in ('blueprint', 'paper')))
      or (p_spec->'scene' ? 'personality' and (jsonb_typeof(p_spec->'scene'->'personality') is distinct from 'string'
          or p_spec->'scene'->>'personality' not in ('premium', 'corporate', 'playful', 'energetic')))) then
    if v_template = 'clip' then
      raise exception 'This motion clip is not valid. Write it again.' using errcode = '22023';
    end if;
    raise exception 'This explainer script is not valid. Write it again.' using errcode = '22023';
  end if;
  if v_template = 'explainer' then
    for v_beat in select b from jsonb_array_elements(p_spec->'scene'->'beats') b loop
      if jsonb_typeof(v_beat) is distinct from 'object'
          or exists (select 1 from jsonb_object_keys(v_beat) k where k not in ('say', 'label'))
          or jsonb_typeof(v_beat->'say') is distinct from 'string'
          or length(btrim(v_beat->>'say')) not between 1 and 240
          or (v_beat ? 'label' and (jsonb_typeof(v_beat->'label') is distinct from 'string'
              or length(btrim(v_beat->>'label')) > 40)) then
        raise exception 'This explainer script is not valid. Write it again.' using errcode = '22023';
      end if;
    end loop;
  end if;
  -- A silent clip: every beat says how long it lasts (0.5-30 s), and they add up to at most 30 s and
  -- to no more than the paid duration.
  if v_template = 'clip' then
    for v_beat in select b from jsonb_array_elements(p_spec->'scene'->'beats') b loop
      if jsonb_typeof(v_beat) is distinct from 'object'
          or exists (select 1 from jsonb_object_keys(v_beat) k where k not in ('say', 'label', 'seconds'))
          or jsonb_typeof(v_beat->'say') is distinct from 'string'
          or length(btrim(v_beat->>'say')) not between 1 and 240
          or (v_beat ? 'label' and (jsonb_typeof(v_beat->'label') is distinct from 'string'
              or length(btrim(v_beat->>'label')) > 40))
          or jsonb_typeof(v_beat->'seconds') is distinct from 'number'
          or (v_beat->>'seconds')::numeric not between 0.5 and 30 then
        raise exception 'This motion clip is not valid. Write it again.' using errcode = '22023';
      end if;
      v_seconds := v_seconds + (v_beat->>'seconds')::numeric;
    end loop;
    if v_seconds > 30 then
      raise exception 'This motion clip is longer than 30 seconds. Shorten its beats.' using errcode = '22023';
    end if;
    if v_seconds > (p_spec->>'duration')::numeric then
      raise exception 'This motion clip''s beats last longer than its paid length. Shorten its beats or make it longer.' using errcode = '22023';
    end if;
  end if;
  -- Images the scene shows (kit.Image): at most 6, each the caller's own library object
  -- (motion quality A5). The worker checks them again against the task's owner.
  if v_explainer and p_spec->'scene' ? 'assets'
      and not public.ai_motion_assets_ok(p_spec->'scene'->'assets') then
    raise exception 'An image in this animation is not in your library. Pick it again.' using errcode = '22023';
  end if;
  if v_scene and p_spec->'scene'->>'template' = 'code' and (
      jsonb_typeof(p_spec->'scene'->'code_ref') is distinct from 'string'
      or not exists (select 1 from public.scene_codes c
                     where c.user_id = auth.uid() and c.hash = p_spec->'scene'->>'code_ref')) then
    raise exception 'This 3D scene code was not found. Preview it again.' using errcode = '22023';
  end if;
  if v_voiced and (jsonb_typeof(p_spec->'voice') is distinct from 'string'
      or not coalesce(p_model.limits->'voices' ? (p_spec->>'voice'), false)) then
    raise exception 'Choose one of the listed voices.' using errcode = '22023';
  end if;
  if p_model.kind = 'audio' and (jsonb_typeof(p_spec->'duration') is distinct from 'number'
      or (p_spec->>'duration')::numeric <> trunc((p_spec->>'duration')::numeric)
      or (p_spec->>'duration')::numeric not between (p_model.limits->>'minSeconds')::numeric
                                             and (p_model.limits->>'maxSeconds')::numeric) then
    raise exception 'Sounds are % to % seconds long.', p_model.limits->>'minSeconds', p_model.limits->>'maxSeconds'
      using errcode = '22023';
  end if;
end;
$_$;


--
-- Name: ai_clip_video_ref_ok(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_clip_video_ref_ok(p_ref jsonb) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
  select jsonb_typeof(p_ref) = 'string'
     and length(p_ref #>> '{}') <= 520
     and (p_ref #>> '{}') ~ '^(renders|sources):'
     and split_part(p_ref #>> '{}', ':', 2) like auth.uid()::text || '/%'
     and (p_ref #>> '{}') !~ '\.\.'
     and exists (select 1 from storage.objects o
                 where o.bucket_id = split_part(p_ref #>> '{}', ':', 1)
                   and o.name = substr(p_ref #>> '{}', length(split_part(p_ref #>> '{}', ':', 1)) + 2));
$$;


--
-- Name: ai_media_ref_ok(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_media_ref_ok(p_ref jsonb) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
  select jsonb_typeof(p_ref) = 'string'
     and length(p_ref #>> '{}') <= 500
     and (p_ref #>> '{}') like auth.uid()::text || '/%'
     and (p_ref #>> '{}') !~ '\.\.'
     and exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = p_ref #>> '{}');
$$;


--
-- Name: ai_motion_assets_ok(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_motion_assets_ok(p_assets jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  select jsonb_typeof(p_assets) = 'array'
     and jsonb_array_length(p_assets) <= 6
     and not exists (
       select 1 from jsonb_array_elements(p_assets) a
       where jsonb_typeof(a) is distinct from 'object'
          or exists (select 1 from jsonb_object_keys(a) k where k not in ('name', 'ref'))
          or jsonb_typeof(a->'name') is distinct from 'string'
          or a->>'name' !~ '^[a-z][a-z0-9-]{0,31}$'
          or not public.ai_media_ref_ok(a->'ref'))
     and (select count(distinct a->>'name') from jsonb_array_elements(p_assets) a) = jsonb_array_length(p_assets);
$_$;


--
-- Name: ai_price(public.ai_models, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_price(p_model public.ai_models, p_spec jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select ceil(
    (case p_model.price->>'unit'
      when 'generation' then (p_model.price->>'credits')::numeric
      when 'second' then (p_model.price->>'credits')::numeric * ceil(coalesce((p_spec->>'duration')::numeric, 1))
      when 'kchars' then (p_model.price->>'credits')::numeric
        * greatest(1, ceil(length(btrim(p_spec->>'prompt')) / 1000.0))
      -- Explainer: render per started 10 s plus the voice per started 1,000 narration characters
      -- (none for a silent motion clip, whose row has no `voiceKchars`).
      when 'explainer' then (p_model.price->>'credits')::numeric * ceil((p_spec->>'duration')::numeric / 10)
        + coalesce((p_model.price->>'voiceKchars')::numeric, 0) * greatest(1, ceil(coalesce((
            select length(string_agg(btrim(b->>'say'), ' ' order by i))
            from jsonb_array_elements(p_spec->'scene'->'beats') with ordinality as t(b, i)), 0) / 1000.0))
    end)
    * coalesce((p_model.price->'resolution'->>(p_spec->>'resolution'))::numeric, 1)
  )::int;
$$;


--
-- Name: api_key_owner(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.api_key_owner(p_hash text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
begin
  select user_id into v_user
  from public.api_keys
  where key_hash = p_hash and revoked_at is null;

  if v_user is not null then
    update public.api_keys set last_used_at = now()
    where key_hash = p_hash
      and (last_used_at is null or last_used_at < now() - interval '5 minutes');
  end if;
  return v_user;
end;
$$;


--
-- Name: apply_credit_ledger_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_credit_ledger_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.user_id is null then
    raise exception 'The credit account no longer exists.' using errcode = 'P0002';
  end if;
  if new.job_id is not null
     and not exists(select 1 from public.jobs where id = new.job_id) then
    raise exception 'No such project for credit entry.' using errcode = 'P0002';
  end if;

  update public.profiles
  set credit_balance = credit_balance + new.delta
  where id = new.user_id;

  if not found then
    raise exception 'The credit account no longer exists.' using errcode = 'P0002';
  end if;
  return new;
end;
$$;


--
-- Name: approval_close(text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_close(p_ref_kind text, p_ref_id uuid, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.approvals
  set status = p_status,
      decided_at = now(),
      decided_via = case when p_status in ('approved', 'edited', 'skipped')
        then coalesce(nullif(current_setting('opencmo.decided_via', true), ''), 'app') end
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held');
end;
$$;


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    department text NOT NULL,
    ref_kind text NOT NULL,
    ref_id uuid NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    price_credits integer,
    post_at timestamp with time zone,
    account text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_via text,
    reason text,
    held_until timestamp with time zone,
    released_at timestamp with time zone,
    CONSTRAINT approvals_account_check CHECK ((char_length(account) <= 100)),
    CONSTRAINT approvals_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT approvals_decided_via_check CHECK ((decided_via = ANY (ARRAY['app'::text, 'email'::text, 'push'::text, 'mcp'::text]))),
    CONSTRAINT approvals_department_check CHECK ((department = ANY (ARRAY['brain'::text, 'research'::text, 'writer'::text, 'studio'::text, 'sales'::text, 'schedule'::text, 'publish'::text]))),
    CONSTRAINT approvals_held_until CHECK (((status <> 'held'::text) OR (held_until IS NOT NULL))),
    CONSTRAINT approvals_kind_check CHECK ((kind = ANY (ARRAY['post'::text, 'reply'::text, 'goal'::text, 'script'::text, 'price'::text, 'finished_video'::text, 'shorts_batch'::text, 'slideshow'::text, 'schedule'::text, 'correction'::text]))),
    CONSTRAINT approvals_price_credits_check CHECK ((price_credits >= 0)),
    CONSTRAINT approvals_reason_check CHECK ((char_length(reason) <= 400)),
    CONSTRAINT approvals_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['content_item'::text, 'opportunity'::text, 'goal'::text, 'correction'::text, 'studio_step'::text, 'editor_project'::text, 'short_batch'::text, 'schedule_slot'::text]))),
    CONSTRAINT approvals_snapshot_check CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND (octet_length((snapshot)::text) <= 32768))),
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'held'::text, 'approved'::text, 'edited'::text, 'skipped'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: approval_decide(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_decide(p_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS public.approvals
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
      perform public.cmo_decide_opportunity(v_row.ref_id, p_action, v_payload->>'reason', v_payload->>'text');
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


--
-- Name: approval_hash(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_hash(p_snapshot jsonb) RETURNS text
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'public'
    AS $$ select encode(extensions.digest(convert_to(public.jcs(p_snapshot), 'UTF8'), 'sha256'), 'hex') $$;


--
-- Name: approval_raise(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_raise(p_user uuid, p_ref_kind text, p_ref_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_snapshot jsonb := public.approval_snapshot(p_ref_kind, p_ref_id);
  v_hash text;
  v_kind text;
  v_id uuid;
  v_expires timestamptz;
  v_prev public.approvals;
  v_status text := 'waiting';
  v_held_until timestamptz;
begin
  if v_snapshot is null then
    return;
  end if;
  v_hash := public.approval_hash(v_snapshot);
  if exists (select 1 from public.approvals
             where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held') and content_hash = v_hash) then
    return;
  end if;
  select * into v_prev from public.approvals
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held') for update;
  update public.approvals set status = 'cancelled', decided_at = now()
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held');
  v_kind := v_snapshot->>'kind';
  -- A failure card (it carries the last error) stays open while the slot's window lasts, so Retry can still post
  -- at the approved time; any other schedule card expires at its time.
  if v_kind = 'schedule' then
    select case when s.error is not null then s.window_ends_at else s.publish_at end into v_expires
    from public.schedule_slots s where s.id = p_ref_id;
  end if;
  if v_prev.id is not null then
    -- A replacement keeps its place: not counted again, still held if the old one was.
    v_status := case when v_prev.status = 'held' and v_expires is null then 'held' else 'waiting' end;
    v_held_until := case when v_status = 'held' then v_prev.held_until end;
  elsif not public.card_budget_take(p_user, v_expires is not null) then
    v_status := 'held';
    v_held_until := public.card_budget_next_day(p_user);
  end if;
  -- A schedule card carries its time and account in the foot and expires when its time comes (rule 4).
  insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash, price_credits,
    post_at, account, expires_at, status, held_until)
  values (p_user, v_kind,
    case v_kind when 'post' then 'writer' when 'reply' then 'sales'
      when 'script' then 'studio' when 'price' then 'studio' when 'finished_video' then 'studio'
      when 'shorts_batch' then 'studio' when 'slideshow' then 'studio' when 'schedule' then 'schedule' else 'brain' end,
    p_ref_kind, p_ref_id, v_snapshot, v_hash,
    case when v_kind in ('script', 'price') then (v_snapshot->>'price_credits')::integer end,
    case when v_kind = 'schedule' then (v_snapshot->>'publish_at')::timestamptz end,
    case when v_kind = 'schedule' then left(v_snapshot->>'handle', 100) end,
    v_expires, v_status, v_held_until)
  returning id into v_id;
  if v_kind = 'schedule' then
    update public.schedule_slots set approval_id = v_id, updated_at = now() where id = p_ref_id;
  end if;
end;
$$;


--
-- Name: approval_refresh(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_refresh(p_ref_kind text, p_ref_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_snapshot jsonb := public.approval_snapshot(p_ref_kind, p_ref_id);
begin
  if v_snapshot is null then
    return;
  end if;
  update public.approvals set snapshot = v_snapshot, content_hash = public.approval_hash(v_snapshot)
  where ref_kind = p_ref_kind and ref_id = p_ref_id and status in ('waiting', 'held')
    and content_hash is distinct from public.approval_hash(v_snapshot);
end;
$$;


--
-- Name: approval_release_held(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_release_held(p_limit integer DEFAULT 500) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_card public.approvals;
  v_n integer := 0;
begin
  for v_card in
    select * from public.approvals where status = 'held' and held_until <= now()
    order by user_id, created_at limit greatest(1, least(p_limit, 5000))
    for update skip locked
  loop
    if public.card_budget_take(v_card.user_id, false) then
      update public.approvals set status = 'waiting', held_until = null, released_at = now() where id = v_card.id;
      v_n := v_n + 1;
    else
      -- `card_budget_take` counted it as held again on today's row; it tries tomorrow.
      update public.approvals set held_until = public.card_budget_next_day(v_card.user_id) where id = v_card.id;
    end if;
  end loop;
  return v_n;
end;
$$;


--
-- Name: approval_snapshot(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_snapshot(p_ref_kind text, p_ref_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v jsonb := public.approval_snapshot_base(p_ref_kind, p_ref_id);
  v_look public.look_checks;
  v_extra jsonb;
begin
  if v is null then
    return v;
  end if;
  if p_ref_kind = 'content_item' then
    select case when public.thread_valid(body) then jsonb_build_object('thread', body->'thread') end into v_extra
    from public.content_items where id = p_ref_id;
    return v || coalesce(v_extra, '{}'::jsonb);
  end if;
  if p_ref_kind = 'opportunity' then
    select case when platform <> 'reddit' then jsonb_build_object('platform', platform) end into v_extra
    from public.opportunities where id = p_ref_id;
    return v || coalesce(v_extra, '{}'::jsonb);
  end if;
  if p_ref_kind not in ('editor_project', 'short_batch', 'studio_step') then
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


--
-- Name: approval_snapshot_base(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approval_snapshot_base(p_ref_kind text, p_ref_id uuid) RETURNS jsonb
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


--
-- Name: approvals_backfill(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approvals_backfill() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_before integer := (select count(*) from public.approvals);
  r record;
begin
  for r in
    select user_id, 'content_item' as ref_kind, id from public.content_items where department = 'post' and status = 'in_review'
    union all select user_id, 'opportunity', id from public.opportunities where status = 'in_review'
    union all select user_id, 'goal', id from public.cmo_goals where status = 'proposed'
    union all select user_id, 'correction', id from public.cmo_corrections where status = 'proposed'
  loop
    perform public.approval_raise(r.user_id, r.ref_kind, r.id);
  end loop;
  return (select count(*) from public.approvals) - v_before;
end;
$$;


--
-- Name: approvals_caption_approve(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approvals_caption_approve() RETURNS trigger
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


--
-- Name: approvals_caption_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approvals_caption_rules() RETURNS trigger
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


--
-- Name: approvals_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approvals_sync() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_ref_kind text := tg_argv[0];
  v_status text;
begin
  if tg_op = 'DELETE' then
    perform public.approval_close(v_ref_kind, old.id, 'cancelled');
    return old;
  end if;
  -- One branch per table: a plpgsql expression may only name fields its row has.
  if v_ref_kind = 'content_item' then
    if new.department <> 'post' then
      return new;
    end if;
    if new.status = 'in_review' then
      perform public.approval_raise(new.user_id, v_ref_kind, new.id);
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = new.status then
      return new;
    end if;
    -- Picking an alternate as written is not an edit; changing the words is.
    v_status := case new.status
      when 'approved' then case
        when new.final_text is null or new.final_text = new.body->>'text'
          or (jsonb_typeof(new.body->'alternates') = 'array' and new.body->'alternates' ? new.final_text) then 'approved'
        else 'edited' end
      when 'published' then 'approved'
      when 'skipped' then 'skipped'
      else 'cancelled' end;
  elsif v_ref_kind = 'opportunity' then
    if new.status = 'in_review' then
      perform public.approval_raise(new.user_id, v_ref_kind, new.id);
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = new.status then
      return new;
    end if;
    v_status := case new.status when 'replied' then 'approved' else 'skipped' end;
  elsif v_ref_kind = 'goal' then
    if new.status = 'proposed' then
      perform public.approval_raise(new.user_id, v_ref_kind, new.id);
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = new.status then
      return new;
    end if;
    v_status := case
      when new.status <> 'approved' then 'skipped'
      when tg_op = 'UPDATE' and (new.goal is distinct from old.goal or new.target is distinct from old.target) then 'edited'
      else 'approved' end;
  else
    if new.status = 'proposed' then
      perform public.approval_raise(new.user_id, v_ref_kind, new.id);
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status = new.status then
      return new;
    end if;
    v_status := case
      when new.status <> 'active' then 'skipped'
      when tg_op = 'UPDATE' and new.rule is distinct from old.rule then 'edited'
      else 'approved' end;
  end if;
  perform public.approval_close(v_ref_kind, new.id, v_status);
  return new;
end;
$$;


--
-- Name: auto_transcript_daily_seconds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_transcript_daily_seconds() RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$ select 10800::numeric $$;


--
-- Name: best_slots_refresh(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.best_slots_refresh(p_user uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_rules jsonb := public.best_time_rules();
  v_n integer;
begin
  delete from public.best_slots where user_id = p_user;
  insert into public.best_slots (user_id, platform, hour, median_views_per_hour, posts, computed_at)
  select p_user, b.platform, b.hour, percentile_cont(0.5) within group (order by b.views), count(*), now()
  from public.best_time_posts(p_user) b
  where b.platform in (
    select platform from public.best_time_posts(p_user) group by platform having count(*) >= (v_rules->>'minPosts')::integer)
  group by b.platform, b.hour
  having count(*) >= (v_rules->>'minPostsPerHour')::integer;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--
-- Name: best_time_posts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.best_time_posts(p_user uuid) RETURNS TABLE(item_id uuid, platform text, hour smallint, views bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with r as (select public.best_time_rules() as j),
  latest as (
    select distinct on (m.item_id) m.item_id, greatest(m.views, coalesce(m.impressions, 0)) as views
    from public.post_metrics m
    where m.user_id = p_user
    order by m.item_id, m.measured_at desc
  ),
  posts as (
    select i.id, public.platform_profile_id(i.platform) as platform, l.views,
      coalesce(i.published_at, (
        select max(s.publish_at) from public.schedule_slots s join public.deliverables d on d.id = s.deliverable_id
        where s.user_id = p_user and s.status = 'published'
          and ((d.ref_kind = 'content_item' and d.ref_id = i.id)
            or (d.ref_kind = 'clip' and d.ref_id = i.clip_id and s.platform = public.platform_profile_id(i.platform)))
      )) as published_at
    from latest l join public.content_items i on i.id = l.item_id and i.user_id = p_user
  )
  select p.id, p.platform, extract(hour from p.published_at at time zone public.schedule_timezone(p_user))::smallint, p.views
  from posts p, r
  where p.published_at is not null
    and p.platform in ('x', 'threads', 'linkedin', 'tiktok', 'youtube', 'instagram')
    and p.published_at >= now() - make_interval(days => (r.j->>'windowDays')::integer)
    and p.published_at <= now() - make_interval(hours => (r.j->>'settleHours')::integer)
$$;


--
-- Name: best_time_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.best_time_rules() RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select '{"minPosts": 10, "minPostsPerHour": 2, "windowDays": 90, "settleHours": 24}'::jsonb $$;


--
-- Name: brand_check_kit(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.brand_check_kit(p_user uuid, p_kit jsonb) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
declare
  v_key text;
  v_font text;
begin
  if p_kit is null or jsonb_typeof(p_kit) <> 'object' or (p_kit->>'version') is distinct from '1' then
    raise exception 'This brand kit is not valid.' using errcode = '22023';
  end if;
  foreach v_key in array array['primary', 'secondary', 'accent', 'text', 'background'] loop
    if coalesce(p_kit->'colors'->>v_key, '') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'Brand colors are hex, like #FFD400.' using errcode = '22023';
    end if;
  end loop;
  foreach v_font in array array[p_kit->'fonts'->>'heading', p_kit->'fonts'->>'body'] loop
    if coalesce(v_font, '') !~ '^[A-Za-z0-9 ]{2,40}$' then
      raise exception 'Choose a font from the list.' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(p_kit->'logo') = 'object'
     and coalesce(p_kit->'logo'->>'object', '') !~ ('^' || p_user::text || '/logo-[0-9a-f-]{36}\.png$') then
    raise exception 'Upload the logo again.' using errcode = '22023';
  end if;
end;
$_$;


--
-- Name: brand_logo_allows(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.brand_logo_allows(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $_$
  select p_name ~ ('^' || (select auth.uid())::text || '/logo-[0-9a-f-]{36}\.png$')
    and (select count(*) from storage.objects o
         where o.bucket_id = 'brand' and (storage.foldername(o.name))[1] = (select auth.uid())::text) < 20;
$_$;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    clip_id uuid,
    settings_hash text,
    asset_id uuid,
    job_id uuid,
    payload jsonb,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    attempt_id uuid,
    lease_until timestamp with time zone,
    heartbeat_at timestamp with time zone,
    output_path text,
    output jsonb,
    bytes bigint,
    width integer,
    height integer,
    duration numeric,
    error text,
    request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    editor_revision_id uuid,
    progress real,
    CONSTRAINT tasks_kind_check CHECK ((kind = ANY (ARRAY['probe_media'::text, 'generate'::text, 'render_document'::text, 'render_stills'::text, 'transcribe_media'::text, 'transcribe_asset'::text, 'capture_page'::text, 'publish_media'::text, 'look_check'::text]))),
    CONSTRAINT tasks_progress_check CHECK (((progress IS NULL) OR ((progress >= (0)::double precision) AND (progress <= (1)::double precision)))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['awaiting_upload'::text, 'awaiting_input'::text, 'queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: cancel_export(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_export(p_task_id uuid) RETURNS public.tasks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and user_id = v_user and kind in ('render_document', 'export')
  for update;
  if not found then
    raise exception 'Export not found.' using errcode = 'P0002';
  end if;
  if v_task.status = 'cancelled' then
    return v_task;
  end if;
  if v_task.status not in ('queued', 'running') then
    raise exception 'This export has already finished.' using errcode = 'P0001';
  end if;
  update public.tasks
  set status = 'cancelled', error = 'Export cancelled.', lease_until = null, finished_at = now()
  where id = p_task_id
  returning * into v_task;
  return v_task;
end;
$$;


--
-- Name: cancel_generation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_generation(p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_generation public.generations;
begin
  select * into v_generation from public.generations where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Generation not found.' using errcode = 'P0002';
  end if;
  if v_generation.status in ('queued', 'running') then
    update public.tasks
    set status = 'cancelled', error = 'Cancelled.', finished_at = now(), lease_until = null
    where id = v_generation.task_id and status in ('awaiting_input', 'queued', 'running');
  end if;
  select * into v_generation from public.generations where id = p_id;
  return to_jsonb(v_generation);
end;
$$;


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_url text NOT NULL,
    title text,
    duration_seconds numeric,
    status public.job_status DEFAULT 'queued'::public.job_status NOT NULL,
    clips_requested integer DEFAULT 5 NOT NULL,
    error text,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    watermark boolean DEFAULT true NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    attempt_id uuid,
    lease_until timestamp with time zone,
    heartbeat_at timestamp with time zone,
    call_id text,
    name text,
    stage text DEFAULT 'queued'::text NOT NULL,
    progress jsonb,
    pinned boolean DEFAULT false NOT NULL,
    media_manifest jsonb,
    attempt_started_at timestamp with time zone,
    aspect text DEFAULT '9:16'::text NOT NULL,
    layout text DEFAULT 'auto'::text NOT NULL,
    captions boolean DEFAULT true NOT NULL,
    caption_preset text DEFAULT 'bold'::text NOT NULL,
    purging_at timestamp with time zone,
    kind text DEFAULT 'clip'::text NOT NULL,
    CONSTRAINT jobs_aspect_check CHECK ((aspect = ANY (ARRAY['9:16'::text, '1:1'::text, '16:9'::text]))),
    CONSTRAINT jobs_caption_preset_check CHECK ((caption_preset = ANY (ARRAY['bold'::text, 'clean'::text, 'minimal'::text]))),
    CONSTRAINT jobs_kind_check CHECK ((kind = ANY (ARRAY['clip'::text, 'edit'::text]))),
    CONSTRAINT jobs_layout_check CHECK ((layout = ANY (ARRAY['auto'::text, 'fill'::text, 'fit'::text]))),
    CONSTRAINT jobs_media_manifest_size_check CHECK (((media_manifest IS NULL) OR (pg_column_size(media_manifest) < 1000000))),
    CONSTRAINT jobs_name_length_check CHECK ((char_length(name) <= 120)),
    CONSTRAINT jobs_source_url_check CHECK ((((kind = 'edit'::text) AND (source_url = 'editor://blank'::text)) OR ((kind = 'clip'::text) AND ((source_url ~ '^https?://[^[:space:]]+$'::text) OR (source_url ~ (('^storage://'::text || (user_id)::text) || '/[A-Za-z0-9][A-Za-z0-9._-]{0,240}$'::text))))))
);


--
-- Name: cancel_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_job(p_job_id uuid) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
  v_was_running boolean;
  v_refunded int;
begin
  -- Cùng thứ tự profiles -> jobs với settle/finalize để tránh deadlock.
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status = 'cancelled' then return v_job; end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'This project has already finished.' using errcode = '22023';
  end if;
  -- Đọc TRƯỚC lệnh update: `returning * into v_job` ghi đè hàng cũ ngay sau đó.
  v_was_running := v_job.status = 'running';
  update public.jobs set status = 'cancelled', stage = 'cancelled',
    finished_at = now(), lease_until = null
  where id = p_job_id returning * into v_job;
  v_refunded := public.refund_job(p_job_id, 'Refund: project cancelled');
  -- Job đã `running` nghĩa là worker đã tải/giải mã thật. Hoàn đủ thì start rồi
  -- huỷ là một vòng lặp compute miễn phí. Giữ lại 1 credit — ghi thành dòng
  -- ledger RIÊNG chứ không trừ vào số hoàn, để đối soát đọc được cả hai vế.
  -- Job `failed` vẫn hoàn đủ: lỗi thường là của ta, không phải của người dùng.
  if v_was_running and v_refunded > 1 then
    perform public.credit_hold(v_user, 'job', p_job_id, 1, 'Cancelled while running', p_job_id);
  end if;
  update public.tasks set status = 'cancelled', finished_at = now(), lease_until = null
  where status in ('queued', 'running') and (
    job_id = p_job_id or clip_id in (select id from public.clips where job_id = p_job_id)
    or asset_id in (select id from public.media_assets where job_id = p_job_id)
  );
  return v_job;
end;
$$;


--
-- Name: caption_cards_refresh(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_cards_refresh(p_clip uuid) RETURNS void
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


--
-- Name: caption_check(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_check(p_profile text, p_text text, p_title text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
declare
  v_profile jsonb := public.platform_profile(p_profile);
  v_label text := v_profile->>'label';
  v_tags integer;
begin
  if v_profile is null or v_profile->>'kind' not in ('caption', 'youtube') then
    raise exception 'Captions are for Instagram, TikTok and YouTube.' using errcode = '22023';
  end if;
  if p_text is null or char_length(trim(p_text)) = 0 or char_length(p_text) > (v_profile->>'limit')::integer then
    raise exception 'A % is 1 to % characters.', v_label, to_char((v_profile->>'limit')::integer, 'FM999,999') using errcode = '22023';
  end if;
  if v_profile->>'kind' = 'youtube' then
    if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > (v_profile->>'title')::integer then
      raise exception 'A YouTube title is 1 to % characters.', v_profile->>'title' using errcode = '22023';
    end if;
  elsif p_title is not null then
    raise exception 'Only YouTube has a title.' using errcode = '22023';
  end if;
  if concat_ws(' ', p_title, p_text) ~* '(https?://|www\.|\m[a-z0-9][a-z0-9-]*\.[a-z]{2,}/[^[:space:]])' then
    raise exception 'Captions carry no links.' using errcode = '22023';
  end if;
  -- `countHashtags` in lib/cmo/platforms.ts: `#word` with a letter in it, not `#1` or `a#b`.
  select count(*) into v_tags
  from regexp_matches(concat_ws(' ', p_title, p_text), '(^|[^[:alnum:]_&/])#[[:alnum:]_]*[[:alpha:]][[:alnum:]_]*', 'g');
  if v_tags > (v_profile->>'hashtags')::integer then
    raise exception 'A % carries at most % hashtags.', v_label, v_profile->>'hashtags' using errcode = '22023';
  end if;
end;
$$;


--
-- Name: content_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    department text NOT NULL,
    platform text NOT NULL,
    day date NOT NULL,
    idea text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    body jsonb DEFAULT '{}'::jsonb NOT NULL,
    final_text text,
    external_url text,
    decided_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    clip_id uuid,
    CONSTRAINT content_items_body_check CHECK (((jsonb_typeof(body) = 'object'::text) AND (octet_length((body)::text) <= 16384))),
    CONSTRAINT content_items_clip_check CHECK (((clip_id IS NULL) OR (department = 'video'::text))),
    CONSTRAINT content_items_department_check CHECK ((department = ANY (ARRAY['post'::text, 'sales'::text, 'video'::text]))),
    CONSTRAINT content_items_external_url_check CHECK ((char_length(external_url) <= 500)),
    CONSTRAINT content_items_final_text_check CHECK ((char_length(final_text) <= 4000)),
    CONSTRAINT content_items_idea_check CHECK (((char_length(idea) >= 1) AND (char_length(idea) <= 300))),
    CONSTRAINT content_items_platform_check CHECK (((char_length(platform) >= 1) AND (char_length(platform) <= 20))),
    CONSTRAINT content_items_priority_check CHECK ((priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT content_items_reason_check CHECK ((char_length(reason) <= 300)),
    CONSTRAINT content_items_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'drafting'::text, 'in_review'::text, 'approved'::text, 'published'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: caption_deliver(public.content_items); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_deliver(p_caption public.content_items) RETURNS void
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


--
-- Name: caption_profiles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_profiles() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$ select array['instagram_caption', 'tiktok_caption', 'youtube'] $$;


--
-- Name: caption_snapshots(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_snapshots(p_clips uuid[]) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select jsonb_agg(jsonb_build_object('caption_id', c.id, 'clip_id', c.clip_id, 'profile', c.platform,
      'text', coalesce(c.body->>'text', ''), 'title', c.body->>'title')
    order by array_position(p_clips, c.clip_id), array_position(public.caption_profiles(), c.platform))
  from public.content_items c
  where c.clip_id = any(p_clips) and c.department = 'video'
$$;


--
-- Name: caption_targets(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.caption_targets(p_user uuid) RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (select array_agg(p order by array_position(public.caption_profiles(), p))
     from (select distinct public.platform_profile_id(c.platform) as p from public.content_items c
           where c.user_id = p_user and c.department = 'video' and c.clip_id is null
             and c.day between date_trunc('week', current_date)::date and date_trunc('week', current_date)::date + 6) x
     where p = any(public.caption_profiles())),
    public.caption_profiles())
$$;


--
-- Name: captions_credits(numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.captions_credits(p_seconds numeric) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select greatest(1, ceil(p_seconds / 60.0)::int) $$;


--
-- Name: captions_max_seconds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.captions_max_seconds() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 1800 $$;


--
-- Name: capture_create(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_create(p_url text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_url text := public.normalize_capture_url(p_url);
  v_id uuid;
  v_task uuid;
  v_used integer;
begin
  -- One lock per user: two requests at once can neither both slip under the cap nor both
  -- create the same capture.
  perform public.lock_credit_owner(v_user);
  select id into v_id from public.page_captures
  where user_id = v_user and url = v_url and status in ('pending', 'ready')
    and created_at > now() - interval '24 hours'
  order by created_at desc
  limit 1;
  if found then
    return v_id;
  end if;
  select count(*) into v_used from public.page_captures
  where user_id = v_user and created_at > now() - interval '24 hours';
  if v_used >= public.capture_daily_limit() then
    -- This exact sentence is on the API's 429 allowlist (lib/api/errors.ts).
    raise exception 'You have reached today''s limit for this task. Try again tomorrow.' using errcode = 'P0001';
  end if;
  v_id := gen_random_uuid();
  insert into public.page_captures (id, user_id, url) values (v_id, v_user, v_url);
  insert into public.tasks (user_id, kind, payload, status, request_id)
  values (v_user, 'capture_page',
          jsonb_build_object('capture_id', v_id, 'url', v_url, 'width', 1280, 'max_height', 8000),
          'queued', gen_random_uuid())
  returning id into v_task;
  update public.page_captures set task_id = v_task where id = v_id;
  return v_id;
end;
$$;


--
-- Name: capture_daily_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_daily_limit() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 30 $$;


--
-- Name: card_budget_next_day(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_budget_next_day(p_user uuid) RETURNS timestamp with time zone
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select (((now() at time zone public.schedule_timezone(p_user))::date + 1)::timestamp) at time zone public.schedule_timezone(p_user)
$$;


--
-- Name: card_budget_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_budget_rules() RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select '{"perDay": 10}'::jsonb $$;


--
-- Name: card_budget_take(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_budget_take(p_user uuid, p_force boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_day date := (now() at time zone public.schedule_timezone(p_user))::date;
  v_raised integer;
begin
  insert into public.card_budget (user_id, day) values (p_user, v_day) on conflict (user_id, day) do nothing;
  select raised into v_raised from public.card_budget where user_id = p_user and day = v_day for update;
  if p_force or v_raised < (public.card_budget_rules()->>'perDay')::integer then
    update public.card_budget set raised = raised + 1 where user_id = p_user and day = v_day;
    return true;
  end if;
  update public.card_budget set held = held + 1 where user_id = p_user and day = v_day;
  return false;
end;
$$;


--
-- Name: charge_caption_translation(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.charge_caption_translation(p_clip_id uuid, p_seconds numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_credits int;
  v_row public.caption_translations;
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'These captions are empty.' using errcode = '22023';
  end if;
  if p_seconds > public.captions_max_seconds() then
    raise exception 'Translation works on up to % minutes of captions at a time.', public.captions_max_seconds() / 60
      using errcode = '22023';
  end if;
  v_credits := public.captions_credits(p_seconds);
  perform public.lock_credit_owner(v_user);
  if public.credit_balance(v_user) < v_credits then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_credits, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  insert into public.caption_translations (user_id, clip_id, credits)
  values (v_user, p_clip_id, v_credits) returning * into v_row;
  perform public.credit_hold(v_user, 'caption_translation', v_row.id, v_credits, 'Caption translation', v_clip.job_id);
  return jsonb_build_object('charge_id', v_row.id, 'credits', v_credits);
end;
$$;


--
-- Name: check_transcript_body(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_transcript_body(p_body text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  v_json jsonb;
begin
  if p_body is null or octet_length(p_body) >= 524288 then
    raise exception 'These captions are too large to save.' using errcode = '22023';
  end if;
  begin
    v_json := p_body::jsonb;
  exception when others then
    raise exception 'These captions are not valid JSON.' using errcode = '22023';
  end;
  if jsonb_typeof(v_json) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_json) as segment
    where jsonb_typeof(segment) <> 'object'
       or jsonb_typeof(segment -> 'text') is distinct from 'string'
       or jsonb_typeof(segment -> 'words') is distinct from 'array'
  ) then
    raise exception 'These captions have an unexpected shape.' using errcode = '22023';
  end if;
end;
$$;


--
-- Name: editor_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    clip_id uuid NOT NULL,
    number integer NOT NULL,
    source_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'export'::text NOT NULL,
    label text,
    document jsonb NOT NULL,
    CONSTRAINT editor_revisions_document_check CHECK (((document IS NULL) OR (octet_length((document)::text) < 262144))),
    CONSTRAINT editor_revisions_kind_check CHECK ((kind = ANY (ARRAY['export'::text, 'agent'::text, 'manual'::text]))),
    CONSTRAINT editor_revisions_label_check CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 200)))),
    CONSTRAINT editor_revisions_source_hash_check CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: checkpoint_editor_project(uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.checkpoint_editor_project(p_clip_id uuid, p_kind text, p_label text, p_expected_version integer DEFAULT NULL::integer) RETURNS public.editor_revisions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
  v_hash text;
  v_latest public.editor_revisions;
  v_revision public.editor_revisions;
begin
  if p_kind is null or p_kind not in ('agent', 'manual') then
    raise exception 'Invalid checkpoint kind.' using errcode = '22023';
  end if;
  if p_label is null or char_length(trim(p_label)) = 0 or char_length(p_label) > 200 then
    raise exception 'A checkpoint needs a short label.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  -- Same refusal as save_editor_document: the write that follows would fail on this version.
  if p_expected_version is not null and v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.' using errcode = 'P0409';
  end if;

  v_hash := public.editor_document_hash(v_row.document);

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = v_hash and v_latest.kind = p_kind then
    return v_latest;
  end if;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind, label)
  values (p_clip_id, coalesce(v_latest.number, 0) + 1, v_hash, v_row.document, p_kind, trim(p_label))
  returning * into v_revision;

  return v_revision;
end;
$$;


--
-- Name: cmo_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    output jsonb,
    attempt integer DEFAULT 0 NOT NULL,
    lease_until timestamp with time zone,
    started_at timestamp with time zone,
    credits integer DEFAULT 0 NOT NULL,
    not_before timestamp with time zone,
    CONSTRAINT cmo_runs_credits_check CHECK ((credits >= 0)),
    CONSTRAINT cmo_runs_error_check CHECK ((char_length(error) <= 500)),
    CONSTRAINT cmo_runs_input_check CHECK (((jsonb_typeof(input) = 'object'::text) AND (octet_length((input)::text) <= 4096))),
    CONSTRAINT cmo_runs_kind_check CHECK ((kind = ANY (ARRAY['onboard'::text, 'plan_week'::text, 'post_draft'::text, 'sales_scan'::text, 'competitor_research'::text, 'pull_metrics'::text, 'summarize_memory'::text, 'review_week'::text, 'write_caption'::text, 'write_video_brief'::text, 'write_slides'::text, 'publish_post'::text, 'niche_video_research'::text]))),
    CONSTRAINT cmo_runs_output_check CHECK (((output IS NULL) OR ((jsonb_typeof(output) = 'object'::text) AND (octet_length((output)::text) <= 16384)))),
    CONSTRAINT cmo_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT cmo_runs_steps_check CHECK (((jsonb_typeof(steps) = 'array'::text) AND (octet_length((steps)::text) <= 16384)))
);


--
-- Name: claim_cmo_run(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_cmo_run(p_run_id uuid DEFAULT NULL::uuid, p_lease_seconds integer DEFAULT 300) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_runs;
  v_dead public.cmo_runs;
begin
  for v_dead in
    update public.cmo_runs set status = 'failed', error = 'This task stopped too many times.', finished_at = now(), lease_until = null
    where status = 'running' and kind <> 'onboard' and lease_until < now() and attempt >= 3
      and not public.cmo_paused(user_id)
    returning *
  loop
    perform public.cmo_refund_run(v_dead);
  end loop;
  -- A paused founder's run gives its attempt back, as `cmo_defer_run` does: pausing is not a failure, and three
  -- pauses must not fail it for good.
  update public.cmo_runs set status = 'queued', lease_until = null,
    attempt = case when public.cmo_paused(user_id) then greatest(0, attempt - 1) else attempt end,
    not_before = case when public.cmo_paused(user_id) then 'infinity'::timestamptz else not_before end
  where status = 'running' and kind <> 'onboard' and lease_until < now() and (attempt < 3 or public.cmo_paused(user_id));

  select * into v_row from public.cmo_runs r
  where status = 'queued' and (p_run_id is null or id = p_run_id)
    and (not_before is null or not_before <= now())
    and not public.cmo_paused(r.user_id)
  order by created_at
  for update skip locked
  limit 1;
  if not found then
    return null;
  end if;

  update public.cmo_runs
  set status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()),
      lease_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)))
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: claim_job_attempt(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_job_attempt(p_job_id uuid, p_lease_seconds integer DEFAULT 120) RETURNS SETOF public.jobs
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.jobs
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_started_at = now(),
      call_id = null
  where id = p_job_id and status = 'queued'
  returning *;
$$;


--
-- Name: claim_next_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_job() RETURNS public.jobs
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.jobs
  set status = 'running'
  where id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;


--
-- Name: claim_next_job_attempt(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_job_attempt(p_lease_seconds integer DEFAULT 120) RETURNS SETOF public.jobs
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.jobs
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_started_at = now(),
      call_id = null
  where id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;


--
-- Name: claim_next_task(text[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_task(p_kinds text[], p_lease_seconds integer DEFAULT 120) RETURNS SETOF public.tasks
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = (
    select id from public.tasks
    where status = 'queued' and kind = any(p_kinds)
    order by array_position(p_kinds, kind), created_at
    -- `skip locked`: tám worker chạy song song không bao giờ nhận trùng một task.
    for update skip locked
    limit 1
  )
  returning *;
$$;


--
-- Name: claim_task(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_task(p_task_id uuid, p_lease_seconds integer DEFAULT 120) RETURNS SETOF public.tasks
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = p_task_id and status = 'queued'
  returning *;
$$;


--
-- Name: cleanup_started_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_started_at() RETURNS timestamp with time zone
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select clock_timestamp(); $$;


--
-- Name: cmo_add_item(text, text, date, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_add_item(p_department text, p_idea text, p_day date, p_reason text DEFAULT ''::text, p_body jsonb DEFAULT '{}'::jsonb) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_platform text;
  v_row public.content_items;
begin
  if p_department is null or p_department not in ('post', 'sales', 'video') then
    raise exception 'Pick X, Reddit or video for this task.' using errcode = '22023';
  end if;
  if p_idea is null or char_length(trim(p_idea)) = 0 or char_length(p_idea) > 300 then
    raise exception 'Write the idea in 300 characters or fewer.' using errcode = '22023';
  end if;
  if p_day is null or p_day < current_date or p_day > current_date + 13 then
    raise exception 'Pick a day in the next two weeks.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_reason, '')) > 300 then
    raise exception 'Keep the reason under 300 characters.' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' or octet_length(p_body::text) > 4096 then
    raise exception 'This task has too much detail.' using errcode = '22023';
  end if;
  -- Trần mục còn mở: một agent chat lặp vòng không được đổ đầy lịch.
  if (select count(*) from public.content_items where user_id = v_user and status = 'planned' and day >= current_date) >= 40 then
    raise exception 'Your calendar is full for the next two weeks. Remove an item first.' using errcode = 'P0001';
  end if;
  v_platform := case p_department when 'post' then 'X' when 'sales' then 'Reddit' else 'Shorts' end;
  insert into public.content_items (user_id, department, platform, day, idea, reason, body)
  values (v_user, p_department, v_platform, p_day, trim(p_idea), coalesce(trim(p_reason), ''), p_body || jsonb_build_object('source', 'cmo_chat'))
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_as_written(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_as_written() RETURNS real
    LANGUAGE sql IMMUTABLE
    AS $$ select 0.95::real $$;


--
-- Name: marketing_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    version integer NOT NULL,
    body jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_documents_body_check CHECK (((jsonb_typeof(body) = 'object'::text) AND (octet_length((body)::text) <= 65536))),
    CONSTRAINT marketing_documents_created_by_check CHECK ((created_by = ANY (ARRAY['agent'::text, 'user'::text]))),
    CONSTRAINT marketing_documents_kind_check CHECK ((kind = ANY (ARRAY['product'::text, 'strategy'::text, 'competitors'::text, 'content_strategy'::text, 'calendar'::text]))),
    CONSTRAINT marketing_documents_version_check CHECK ((version >= 1))
);


--
-- Name: cmo_chat_save_document(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_chat_save_document(p_kind text, p_body jsonb) RETURNS public.marketing_documents
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.marketing_documents;
begin
  v_row := public.save_marketing_document(p_kind, p_body, null);
  update public.marketing_documents set created_by = 'agent' where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    rule text NOT NULL,
    source_edits jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    edit_mode text,
    times integer,
    CONSTRAINT cmo_corrections_edit_mode_check CHECK ((edit_mode = ANY (ARRAY['TOO_SALESY'::text, 'WRONG_VOICE'::text, 'INVENTED_CLAIM'::text, 'TOO_LONG'::text, 'HOOK_REWRITTEN'::text, 'CTA_REMOVED'::text]))),
    CONSTRAINT cmo_corrections_mode_times_check CHECK (((edit_mode IS NULL) = (times IS NULL))),
    CONSTRAINT cmo_corrections_rule_check CHECK (((char_length(rule) >= 3) AND (char_length(rule) <= 200))),
    CONSTRAINT cmo_corrections_source_edits_check CHECK (((jsonb_typeof(source_edits) = 'array'::text) AND (octet_length((source_edits)::text) <= 8192))),
    CONSTRAINT cmo_corrections_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'active'::text, 'rejected'::text]))),
    CONSTRAINT cmo_corrections_times_check CHECK (((times >= 1) AND (times <= 100)))
);


--
-- Name: cmo_decide_correction(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_correction(p_id uuid, p_action text, p_text text DEFAULT NULL::text) RETURNS public.cmo_corrections
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_corrections;
  v_text text := nullif(trim(coalesce(p_text, '')), '');
begin
  if p_action is null or p_action not in ('approve', 'edit', 'reject') then
    raise exception 'Choose approve, edit or reject.' using errcode = '22023';
  end if;
  if p_action = 'edit' and (v_text is null or char_length(v_text) < 3 or char_length(v_text) > 200) then
    raise exception 'Write the rule in 3 to 200 characters.' using errcode = '22023';
  end if;
  select * into v_row from public.cmo_corrections where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Rule not found.' using errcode = 'P0002';
  end if;
  if v_row.status = 'rejected' or (v_row.status = 'active' and p_action <> 'reject') then
    raise exception 'This rule was already decided.' using errcode = 'P0001';
  end if;
  update public.cmo_corrections
  set status = case p_action when 'reject' then 'rejected' else 'active' end,
      rule = case p_action when 'edit' then v_text else rule end,
      decided_at = now()
  where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_goals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    week date NOT NULL,
    goal text NOT NULL,
    metric text NOT NULL,
    target integer NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    result integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT cmo_goals_goal_check CHECK (((char_length(goal) >= 3) AND (char_length(goal) <= 300))),
    CONSTRAINT cmo_goals_metric_check CHECK ((metric = ANY (ARRAY['posts'::text, 'replies'::text, 'views'::text]))),
    CONSTRAINT cmo_goals_result_check CHECK ((result >= 0)),
    CONSTRAINT cmo_goals_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT cmo_goals_target_check CHECK (((target >= 1) AND (target <= 1000000))),
    CONSTRAINT cmo_goals_week_check CHECK ((EXTRACT(isodow FROM week) = (1)::numeric))
);


--
-- Name: cmo_decide_goal(uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_goal(p_id uuid, p_action text, p_goal text DEFAULT NULL::text, p_target integer DEFAULT NULL::integer) RETURNS public.cmo_goals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_goals;
begin
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.' using errcode = '22023';
  end if;
  if p_goal is not null and (char_length(trim(p_goal)) < 3 or char_length(p_goal) > 300) then
    raise exception 'Describe the goal in 3 to 300 characters.' using errcode = '22023';
  end if;
  if p_target is not null and (p_target < 1 or p_target > 1000000) then
    raise exception 'The target must be between 1 and 1,000,000.' using errcode = '22023';
  end if;
  update public.cmo_goals
  set status = case p_action when 'approve' then 'approved' else 'rejected' end,
      -- A new target rewrites the old number in the CMO's wording, or the card would read
      -- "3 posts" above "0 of 4 posts approved".
      goal = coalesce(
        nullif(trim(p_goal), ''),
        case when p_target is not null and p_target <> target
          then regexp_replace(goal, '\m' || target || '\M', p_target::text)
          else goal end
      ),
      target = coalesce(p_target, target),
      decided_at = now()
  where id = p_id and user_id = v_user
  returning * into v_row;
  if not found then
    raise exception 'Goal not found.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;


--
-- Name: opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    platform text DEFAULT 'reddit'::text NOT NULL,
    url text NOT NULL,
    community text DEFAULT ''::text NOT NULL,
    title text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    snippet text DEFAULT ''::text NOT NULL,
    posted_at timestamp with time zone,
    comments integer DEFAULT 0 NOT NULL,
    score integer NOT NULL,
    score_parts jsonb DEFAULT '[]'::jsonb NOT NULL,
    reply text,
    priority text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'in_review'::text NOT NULL,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    gen jsonb DEFAULT '{}'::jsonb NOT NULL,
    rule text,
    rule_why text,
    CONSTRAINT opportunities_author_check CHECK ((char_length(author) <= 100)),
    CONSTRAINT opportunities_comments_check CHECK ((comments >= 0)),
    CONSTRAINT opportunities_community_check CHECK ((char_length(community) <= 100)),
    CONSTRAINT opportunities_gen_check CHECK (((jsonb_typeof(gen) = 'object'::text) AND (octet_length((gen)::text) <= 256))),
    CONSTRAINT opportunities_platform_check CHECK ((platform = ANY (ARRAY['reddit'::text, 'hn'::text]))),
    CONSTRAINT opportunities_priority_check CHECK ((priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT opportunities_reply_check CHECK (((char_length(reply) >= 1) AND (char_length(reply) <= 3000))),
    CONSTRAINT opportunities_reply_or_skip CHECK (((reply IS NOT NULL) OR (rule = 'skip'::text))),
    CONSTRAINT opportunities_rule_check CHECK ((rule = ANY (ARRAY['mention_ok'::text, 'help_only'::text, 'skip'::text]))),
    CONSTRAINT opportunities_rule_why_check CHECK ((char_length(rule_why) <= 200)),
    CONSTRAINT opportunities_score_check CHECK (((score >= 0) AND (score <= 100))),
    CONSTRAINT opportunities_score_parts_check CHECK (((jsonb_typeof(score_parts) = 'array'::text) AND (octet_length((score_parts)::text) <= 8192))),
    CONSTRAINT opportunities_snippet_check CHECK ((char_length(snippet) <= 1200)),
    CONSTRAINT opportunities_status_check CHECK ((status = ANY (ARRAY['in_review'::text, 'replied'::text, 'dismissed'::text]))),
    CONSTRAINT opportunities_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 400))),
    CONSTRAINT opportunities_url_check CHECK (((char_length(url) <= 500) AND (((platform = 'reddit'::text) AND (url ~ '^https://(www\.|old\.)?reddit\.com/'::text)) OR ((platform = 'hn'::text) AND (url ~ '^https://news\.ycombinator\.com/item\?id=[0-9]{1,12}$'::text)))))
);


--
-- Name: cmo_decide_opportunity(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_opportunity(p_id uuid, p_action text, p_reason text DEFAULT NULL::text, p_text text DEFAULT NULL::text) RETURNS public.opportunities
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.opportunities;
  v_final text := nullif(trim(coalesce(p_text, '')), '');
begin
  if p_action is null or p_action not in ('replied', 'dismissed') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if v_final is not null and (p_action <> 'replied' or char_length(v_final) > 3000) then
    raise exception 'Only a reply you posted, up to 3000 characters, is saved with it.' using errcode = '22023';
  end if;
  -- The founder edits and posts by hand: the reply that counts is the one they say they posted (P5 F3).
  update public.opportunities set status = p_action, decided_at = now(), reply = coalesce(v_final, reply)
  where id = p_id and user_id = v_user and status = 'in_review' and (p_action = 'dismissed' or reply is not null)
  returning * into v_row;
  if not found then
    if exists(select 1 from public.opportunities where id = p_id and user_id = v_user) then
      raise exception 'This conversation was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  if p_action = 'dismissed' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, body)
    values (v_user, 'feedback', left('Dismissed the Reddit thread "' || left(v_row.title, 120) || '": ' || trim(p_reason), 600));
  end if;
  -- Whether the product was named is read from that final text, never from the draft's intent: the 1-in-10 rule
  -- counts what went out.
  insert into public.cmo_draft_outcomes (user_id, item_id, department, action, model, prompt_version, mentioned_product)
  values (v_user, p_id, 'sales', p_action, left(coalesce(v_row.gen->>'model', ''), 100), left(coalesce(v_row.gen->>'prompt_version', ''), 40),
    case when p_action = 'replied' then public.product_mentioned(v_user, v_row.reply) end)
  on conflict (department, item_id) do nothing;
  return v_row;
end;
$$;


--
-- Name: cmo_decide_post(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_post(p_id uuid, p_action text, p_text text DEFAULT NULL::text, p_reason text DEFAULT NULL::text) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
  v_text text;
  v_versions text[];
  v_best real;
  v_best_index smallint;
  v_sim real;
  v_profile text;
  v_label text;
  v_limit integer;
  v_outcome uuid;
  v_note uuid;
begin
  if p_action is null or p_action not in ('approve', 'skip') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':cmo_post', 1713));
  select * into v_row from public.content_items
  where id = p_id and user_id = v_user and department = 'post'
  for update;
  if not found then
    raise exception 'Post not found.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'in_review' then
    raise exception 'This post was already decided.' using errcode = 'P0001';
  end if;
  -- A post on a platform without a post profile was planned for X (every post before P3).
  v_profile := public.platform_profile_id(v_row.platform);
  if v_profile is null or public.platform_profile(v_profile)->>'kind' <> 'post' then
    v_profile := 'x';
  end if;
  v_label := public.platform_profile(v_profile)->>'label';
  v_limit := (public.platform_profile(v_profile)->>'limit')::integer;

  if p_action = 'skip' then
    update public.content_items set status = 'skipped', decided_at = now(), updated_at = now()
    where id = p_id returning * into v_row;
    insert into public.cmo_draft_outcomes (user_id, item_id, department, action, model, prompt_version, platform)
    values (v_user, p_id, 'post', 'skip', left(coalesce(v_row.body->'gen'->>'model', ''), 100),
            left(coalesce(v_row.body->'gen'->>'prompt_version', ''), 40), v_profile)
    on conflict (department, item_id) do nothing
    returning id into v_outcome;
    -- The reason is remembered once: as the decision's voice note, or, when no note is written (no outcome, a
    -- failure), as feedback, so Writer never reads the same skip twice.
    if p_reason is not null and char_length(trim(p_reason)) > 0 then
      v_note := null;
      if v_outcome is not null then
        begin
          v_note := (public.voice_note_write(v_outcome, left(trim(p_reason), 400))).id;
        exception when others then
          raise warning 'voice note for decision % failed: %', v_outcome, sqlerrm;
        end;
      end if;
      if v_note is null then
        insert into public.cmo_memories (user_id, type, topic, body)
        values (v_user, 'feedback', 'post', left('Skipped the ' || v_label || ' post "' || left(v_row.idea, 120) || '": ' || trim(p_reason), 600));
      end if;
    end if;
    return v_row;
  end if;

  v_text := coalesce(nullif(trim(p_text), ''), v_row.body->>'text');
  if v_text is null or char_length(v_text) = 0 then
    raise exception 'This post is empty.' using errcode = '22023';
  end if;
  if char_length(v_text) > v_limit then
    raise exception 'Posts on % can be at most % characters.', v_label, to_char(v_limit, 'FM999,999') using errcode = '22023';
  end if;
  if (select count(*) from public.operation_log
      where user_id = v_user and platform = v_profile and action = 'approve' and at > now() - interval '1 day') >= 5 then
    raise exception 'You can approve 5 posts for % a day. Try again tomorrow.', v_label using errcode = 'P0001';
  end if;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, v_profile, 'approve', p_id::text);
  update public.content_items set status = 'approved', final_text = v_text, decided_at = now(), updated_at = now()
  where id = p_id returning * into v_row;

  -- Version 0 is `text`, 1–2 the alternates, in the order the card shows them.
  v_versions := array[v_row.body->>'text'] || coalesce(array(
    select jsonb_array_elements_text(v_row.body->'alternates')
    where jsonb_typeof(v_row.body->'alternates') = 'array'), '{}');
  for i in 1 .. least(coalesce(array_length(v_versions, 1), 0), 3) loop
    continue when v_versions[i] is null;
    v_sim := case when v_versions[i] = v_text then 1 else extensions.similarity(v_versions[i], v_text) end;
    if v_best is null or v_sim > v_best then
      v_best := v_sim;
      v_best_index := i - 1;
    end if;
  end loop;
  -- A post approved as written is labelled at once; its voice note comes from the outcome's own trigger.
  insert into public.cmo_draft_outcomes (
    user_id, item_id, department, action, chosen_version, similarity, edit_mode, classified_at, model, prompt_version, platform
  ) values (
    v_user, p_id, 'post', 'approve', v_best_index, v_best,
    case when v_best >= public.cmo_as_written() then 'NO_MEANINGFUL_EDIT' end,
    case when v_best >= public.cmo_as_written() then now() end,
    left(coalesce(v_row.body->'gen'->>'model', ''), 100), left(coalesce(v_row.body->'gen'->>'prompt_version', ''), 40),
    v_profile
  )
  on conflict (department, item_id) do nothing;
  return v_row;
end;
$$;


--
-- Name: cmo_defer_run(uuid, integer, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_defer_run(p_run uuid, p_attempt integer, p_seconds integer, p_steps jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.cmo_runs
  set status = 'queued', lease_until = null, attempt = greatest(0, attempt - 1),
      not_before = now() + make_interval(secs => greatest(5, least(p_seconds, 3600))),
      steps = coalesce(p_steps, steps)
  where id = p_run and attempt = p_attempt and status = 'running';
  return found;
end;
$$;


--
-- Name: cmo_draft_outcomes_backfill_platform(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_draft_outcomes_backfill_platform() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_n integer;
begin
  update public.cmo_draft_outcomes o set platform = public.platform_profile_id(c.platform)
  from public.content_items c
  where o.platform is null and o.department = 'post' and c.id = o.item_id and public.platform_profile_id(c.platform) is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--
-- Name: cmo_draft_outcomes_learn(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_draft_outcomes_learn() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.edit_mode is null or (tg_op = 'UPDATE' and old.edit_mode is not distinct from new.edit_mode) then
    return new;
  end if;
  begin
    perform public.voice_note_write(new.id);
    perform public.correction_from_edits(new.id);
  exception when others then
    raise warning 'learning from decision % failed: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;


--
-- Name: cmo_draft_outcomes_platform(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_draft_outcomes_platform() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.platform is null and new.department = 'post' then
    select public.platform_profile_id(c.platform) into new.platform from public.content_items c where c.id = new.item_id;
  end if;
  return new;
end;
$$;


--
-- Name: cmo_enqueue(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_runs;
  v_price integer := case
    when p_input->>'brain' = 'claude' and public.is_paid(p_user) then 0
    else public.cmo_job_price(p_kind)
  end;
  v_key text := case when p_kind in ('post_draft', 'write_caption', 'write_video_brief', 'write_slides', 'publish_post')
    then coalesce(p_input->>'item_id', p_input->>'order_id') end;
begin
  if p_kind is null or p_kind = 'onboard' or public.cmo_job_daily_limit(p_kind) <= 0 then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;
  -- Replays are started by inbox_submit only, for an item the founder owns.
  if p_input ? 'inbox' then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;
  if public.cmo_paused(p_user) then
    raise exception 'Your CMO is paused. Resume it to start new work.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':cmo_run', 1713));

  select * into v_row from public.cmo_runs
  where user_id = p_user and kind = p_kind and status in ('queued', 'running')
    and (status = 'queued' or lease_until is null or lease_until > now())
    and (v_key is null or coalesce(input->>'item_id', input->>'order_id') = v_key)
  order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.cmo_runs
      where user_id = p_user and kind = p_kind and created_at > now() - interval '1 day'
        and not (input ? 'inbox')) >= public.cmo_job_daily_limit(p_kind) then
    raise exception 'You have reached today''s limit for this task. Try again tomorrow.' using errcode = 'P0001';
  end if;
  if v_price > 0 and public.credit_balance(p_user) < v_price then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_price, public.credit_balance(p_user) using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, status, input, credits)
  values (p_user, p_kind, 'queued', p_input, v_price) returning * into v_row;
  if v_price > 0 then
    perform public.credit_hold(p_user, 'cmo_run', v_row.id, v_price, 'CMO hold');
  end if;
  return v_row;
end;
$$;


--
-- Name: cmo_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    step text NOT NULL,
    request jsonb NOT NULL,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    memo jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    feedback text,
    rounds integer DEFAULT 0 NOT NULL,
    last_request_id uuid,
    run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    submitted_at timestamp with time zone,
    finished_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '3 days'::interval) NOT NULL,
    CONSTRAINT cmo_inbox_answers_check CHECK (((jsonb_typeof(answers) = 'object'::text) AND (octet_length((answers)::text) <= 262144))),
    CONSTRAINT cmo_inbox_feedback_check CHECK ((char_length(feedback) <= 1000)),
    CONSTRAINT cmo_inbox_input_check CHECK (((jsonb_typeof(input) = 'object'::text) AND (octet_length((input)::text) <= 4096))),
    CONSTRAINT cmo_inbox_kind_check CHECK ((kind = ANY (ARRAY['plan_week'::text, 'post_draft'::text, 'sales_scan'::text, 'competitor_research'::text, 'summarize_memory'::text, 'review_week'::text]))),
    CONSTRAINT cmo_inbox_memo_check CHECK (((jsonb_typeof(memo) = 'object'::text) AND (octet_length((memo)::text) <= 1048576))),
    CONSTRAINT cmo_inbox_request_check CHECK (((jsonb_typeof(request) = 'object'::text) AND (octet_length((request)::text) <= 1048576))),
    CONSTRAINT cmo_inbox_rounds_check CHECK ((rounds >= 0)),
    CONSTRAINT cmo_inbox_status_check CHECK ((status = ANY (ARRAY['open'::text, 'claimed'::text, 'submitted'::text, 'done'::text, 'expired'::text]))),
    CONSTRAINT cmo_inbox_step_check CHECK ((step ~ '^[a-z_]{1,40}$'::text))
);


--
-- Name: cmo_inbox_finish(uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_inbox_finish(p_run uuid, p_ok boolean, p_feedback text DEFAULT NULL::text) RETURNS public.cmo_inbox
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_run public.cmo_runs;
  v_item public.cmo_inbox;
begin
  select * into v_run from public.cmo_runs where id = p_run;
  if not found or nullif(v_run.input->>'inbox', '') is null then
    return null;
  end if;
  if p_ok then
    update public.cmo_inbox set status = 'done', finished_at = now(), feedback = null
    where id = (v_run.input->>'inbox')::uuid and user_id = v_run.user_id and status = 'submitted' and run_id = p_run
    returning * into v_item;
  else
    update public.cmo_inbox
    set status = case when rounds >= public.cmo_inbox_max_rounds() then 'expired' else 'open' end,
        answers = answers - step, claimed_at = null,
        finished_at = case when rounds >= public.cmo_inbox_max_rounds() then now() end,
        feedback = left(coalesce(p_feedback, 'The answer did not pass our checks.'), 1000)
    where id = (v_run.input->>'inbox')::uuid and user_id = v_run.user_id and status = 'submitted' and run_id = p_run
    returning * into v_item;
  end if;
  return v_item;
end;
$$;


--
-- Name: cmo_inbox_max_rounds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_inbox_max_rounds() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 8 $$;


--
-- Name: cmo_inbox_open(uuid, integer, text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_inbox_open(p_run uuid, p_attempt integer, p_step text, p_request jsonb, p_memo jsonb DEFAULT '{}'::jsonb) RETURNS public.cmo_inbox
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_run public.cmo_runs;
  v_item public.cmo_inbox;
  v_inbox uuid;
begin
  select * into v_run from public.cmo_runs where id = p_run and attempt = p_attempt and status = 'running' for update;
  if not found then
    return null;
  end if;
  if v_run.input->>'brain' is distinct from 'claude' then
    raise exception 'This run does not use the inbox.' using errcode = '22023';
  end if;
  v_inbox := nullif(v_run.input->>'inbox', '')::uuid;

  if v_inbox is null then
    -- A fresh scheduled item replaces the founder's older unanswered one of the same kind:
    -- yesterday's draft request is stale once today's exists.
    update public.cmo_inbox set status = 'expired', finished_at = now()
    where user_id = v_run.user_id and kind = v_run.kind and status in ('open', 'claimed');
    insert into public.cmo_inbox (user_id, kind, input, step, request, memo, run_id)
    values (v_run.user_id, v_run.kind, v_run.input - 'brain', p_step, p_request, coalesce(p_memo, '{}'), v_run.id)
    returning * into v_item;
  else
    update public.cmo_inbox
    set step = p_step, request = p_request, memo = memo || coalesce(p_memo, '{}'), status = 'open',
        feedback = null, claimed_at = null, run_id = v_run.id
    where id = v_inbox and user_id = v_run.user_id and status = 'submitted'
    returning * into v_item;
    if not found then
      raise exception 'This inbox item is no longer waiting.' using errcode = 'P0001';
    end if;
  end if;

  perform public.complete_cmo_run(p_run, p_attempt, true,
    jsonb_build_object('inbox_id', v_item.id, 'waiting_for', p_step), null);
  return v_item;
end;
$$;


--
-- Name: cmo_job_daily_limit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_job_daily_limit(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 when 'review_week' then 1
    when 'write_caption' then 20 when 'write_video_brief' then 5 when 'write_slides' then 10 when 'publish_post' then 100 when 'niche_video_research' then 2
    else 0 end
$$;


--
-- Name: cmo_job_price(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_job_price(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 when 'review_week' then 0
    when 'write_caption' then 1 when 'write_video_brief' then 1 when 'write_slides' then 1 when 'publish_post' then 0 when 'niche_video_research' then 2
    else 0 end
$$;


--
-- Name: cmo_mark_posted(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_mark_posted(p_id uuid, p_url text DEFAULT NULL::text) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
  v_url text := nullif(trim(coalesce(p_url, '')), '');
  v_profile text;
begin
  select * into v_row from public.content_items where id = p_id and user_id = v_user and status = 'approved' for update;
  if not found then
    raise exception 'Approve the post before marking it as posted.' using errcode = 'P0001';
  end if;
  v_profile := coalesce(public.platform_profile_id(v_row.platform), 'x');
  if public.platform_profile(v_profile)->>'kind' is distinct from 'post' then
    v_profile := 'x';
  end if;
  if v_url is not null then
    if v_profile = 'threads' and v_url !~ '^https://(www\.)?threads\.(net|com)/@[A-Za-z0-9_.]{1,30}/post/[A-Za-z0-9_-]{1,64}' then
      raise exception 'Paste the link to your post on Threads, like https://www.threads.com/@you/post/abc.' using errcode = '22023';
    elsif v_profile = 'linkedin'
      and v_url !~ '^https://(www\.)?linkedin\.com/(posts/[A-Za-z0-9_%.-]{1,255}|feed/update/urn:li:(activity|share|ugcPost):[0-9]{1,25})' then
      raise exception 'Paste the link to your post on LinkedIn, like https://www.linkedin.com/feed/update/urn:li:activity:123.' using errcode = '22023';
    elsif v_profile = 'x' and v_url !~ '^https://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}' then
      raise exception 'Paste the link to your post on X, like https://x.com/you/status/123.' using errcode = '22023';
    end if;
  end if;
  update public.content_items set status = 'published', external_url = v_url, published_at = now(), updated_at = now()
  where id = v_row.id
  returning * into v_row;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, v_profile, 'publish', p_id::text)
  on conflict do nothing;
  return v_row;
end;
$$;


--
-- Name: cmo_memories_classify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_memories_classify() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if new.type = 'feedback' then
    new.kind := 'feedback';
    if new.topic = 'general' then
      new.topic := case
        when new.body like 'Skipped the X post%' then 'post'
        when new.body like 'Dismissed the Reddit thread%' then 'sales'
        else 'general' end;
    end if;
    new.expires_at := coalesce(new.expires_at, now() + interval '90 days');
  end if;
  return new;
end;
$$;


--
-- Name: cmo_pause(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_pause() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_at timestamptz;
begin
  update public.profiles set cmo_paused_at = coalesce(cmo_paused_at, now()) where id = v_user returning cmo_paused_at into v_at;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  update public.cmo_runs set not_before = 'infinity' where user_id = v_user and status = 'queued';
  return v_at;
end;
$$;


--
-- Name: cmo_paused(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_paused(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select coalesce((select cmo_paused_at is not null from public.profiles where id = p_user), false) $$;


--
-- Name: cmo_plan_week(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_plan_week(p_user uuid, p_run uuid, p_items jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_day date;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then
    raise exception 'This plan is not valid.' using errcode = '22023';
  end if;
  delete from public.content_items where user_id = p_user and status = 'planned' and day >= current_date;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_day := (v_item->>'day')::date;
    if v_day < current_date or v_day > current_date + 13 then
      continue;
    end if;
    insert into public.content_items (user_id, run_id, department, platform, day, idea, reason)
    values (
      p_user, p_run, v_item->>'department', left(v_item->>'platform', 20), v_day,
      left(v_item->>'idea', 300), left(coalesce(v_item->>'reason', ''), 300)
    );
    v_count := v_count + 1;
  end loop;
  -- The tree only tracks the plan: a fault in it must not lose the calendar.
  begin
    perform public.work_orders_plan_week(p_user, p_run);
  exception when others then
    raise warning 'work_orders_plan_week failed for run %: %', p_run, sqlerrm;
  end;
  return v_count;
end;
$$;


--
-- Name: cmo_propose_correction(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_propose_correction(p_user uuid, p_rule text, p_source_edits jsonb DEFAULT '[]'::jsonb) RETURNS public.cmo_corrections
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_rule text := trim(coalesce(p_rule, ''));
  v_row public.cmo_corrections;
begin
  if char_length(v_rule) < 3 or char_length(v_rule) > 200 then
    raise exception 'Write the rule in 3 to 200 characters.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cmo_corrections:' || p_user::text, 0));
  select * into v_row from public.cmo_corrections
  where user_id = p_user and status in ('proposed', 'active') and lower(rule) = lower(v_rule)
  limit 1;
  if found then
    return v_row;
  end if;
  if (select count(*) from public.cmo_corrections where user_id = p_user and status = 'proposed') >= 5 then
    raise exception 'Five rules already wait for a decision.' using errcode = 'P0001';
  end if;
  insert into public.cmo_corrections (user_id, rule, source_edits)
  values (p_user, v_rule, coalesce(p_source_edits, '[]'::jsonb))
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_propose_goal(uuid, uuid, date, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_propose_goal(p_user uuid, p_run uuid, p_week date, p_goal text, p_metric text, p_target integer) RETURNS public.cmo_goals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.cmo_put_goal(p_user, p_run, p_week, p_goal, p_metric, p_target);
end;
$$;


--
-- Name: cmo_put_goal(uuid, uuid, date, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_put_goal(p_user uuid, p_run uuid, p_week date, p_goal text, p_metric text, p_target integer) RETURNS public.cmo_goals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_goals;
begin
  if p_week is null or extract(isodow from p_week) <> 1 then
    raise exception 'The week must start on a Monday.' using errcode = '22023';
  end if;
  if p_week < date_trunc('week', current_date)::date or p_week > date_trunc('week', current_date)::date + 7 then
    raise exception 'Goals are for this week or next week.' using errcode = '22023';
  end if;
  if p_goal is null or char_length(trim(p_goal)) < 3 or char_length(p_goal) > 300 then
    raise exception 'Describe the goal in 3 to 300 characters.' using errcode = '22023';
  end if;
  if p_metric is null or p_metric not in ('posts', 'replies', 'views') then
    raise exception 'The goal must count posts, replies or views.' using errcode = '22023';
  end if;
  if p_target is null or p_target < 1 or p_target > 1000000 then
    raise exception 'The target must be between 1 and 1,000,000.' using errcode = '22023';
  end if;
  select * into v_row from public.cmo_goals where user_id = p_user and week = p_week for update;
  if found and v_row.status = 'approved' then
    raise exception 'This week''s goal is already approved. Edit it on the goal card.' using errcode = 'P0001';
  end if;
  insert into public.cmo_goals (user_id, run_id, week, goal, metric, target)
  values (p_user, p_run, p_week, trim(p_goal), p_metric, p_target)
  on conflict (user_id, week) do update
    set goal = excluded.goal, metric = excluded.metric, target = excluded.target, run_id = excluded.run_id,
        status = 'proposed', decided_at = null, created_at = now()
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_read_hit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_read_hit(p_bucket text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_limit integer := public.cmo_read_limit(p_bucket);
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
  v_count integer;
begin
  if v_limit <= 0 then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;
  insert into public.rate_limits (user_id, bucket, window_start, count)
  values (v_user, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start) do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= v_limit;
end;
$$;


--
-- Name: cmo_read_limit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_read_limit(p_bucket text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_bucket when 'mcp_social' then 60 when 'mcp_site' then 20 else 0 end
$$;


--
-- Name: cmo_record_goal_result(uuid, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_record_goal_result(p_user uuid, p_week date, p_result integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.cmo_goals set result = greatest(0, p_result)
  where user_id = p_user and week = p_week and status = 'approved';
  return found;
end;
$$;


--
-- Name: cmo_refund_run(public.cmo_runs); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_refund_run(p_run public.cmo_runs) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_run.credits > 0 then
    perform public.credit_refund(p_run.user_id, 'cmo_run', p_run.id, 'CMO refund');
  end if;
end;
$$;


--
-- Name: cmo_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'fact'::text NOT NULL,
    topic text DEFAULT 'general'::text NOT NULL,
    importance smallint DEFAULT 2 NOT NULL,
    expires_at timestamp with time zone,
    source_run uuid,
    source_outcome uuid,
    CONSTRAINT cmo_memories_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 600))),
    CONSTRAINT cmo_memories_importance_check CHECK (((importance >= 1) AND (importance <= 3))),
    CONSTRAINT cmo_memories_kind_check CHECK ((kind = ANY (ARRAY['preference'::text, 'fact'::text, 'feedback'::text, 'result'::text]))),
    CONSTRAINT cmo_memories_topic_check CHECK ((topic = ANY (ARRAY['general'::text, 'post'::text, 'sales'::text, 'video'::text, 'research'::text]))),
    CONSTRAINT cmo_memories_type_check CHECK ((type = ANY (ARRAY['feedback'::text, 'user'::text, 'agent'::text])))
);


--
-- Name: cmo_remember(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_remember(p_body text, p_topic text DEFAULT 'general'::text, p_source text DEFAULT 'user'::text) RETURNS public.cmo_memories
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_memories;
begin
  if p_body is null or char_length(trim(p_body)) = 0 or char_length(p_body) > 600 then
    raise exception 'Keep the note under 600 characters.' using errcode = '22023';
  end if;
  if p_topic is null or p_topic not in ('general', 'post', 'sales', 'video', 'research') then
    raise exception 'Unknown topic.' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('user', 'agent') then
    raise exception 'Unknown note source.' using errcode = '22023';
  end if;
  -- At the cap, drop the least important, oldest note rather than simply the oldest one.
  if (select count(*) from public.cmo_memories where user_id = v_user) >= 200 then
    delete from public.cmo_memories where id in (
      select id from public.cmo_memories where user_id = v_user order by importance, created_at limit 1
    );
  end if;
  insert into public.cmo_memories (user_id, type, kind, topic, importance, body)
  values (v_user, p_source, case when p_source = 'user' then 'preference' else 'fact' end, p_topic,
    case when p_source = 'user' then 3 else 2 end, trim(p_body))
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_remove_item(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_remove_item(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.content_items where id = p_id and user_id = v_user and status = 'planned';
  if not found then
    raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
  end if;
end;
$$;


--
-- Name: cmo_reply_outcomes_due(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_reply_outcomes_due(p_user uuid, p_limit integer) RETURNS TABLE(outcome_id uuid, opportunity_id uuid, platform text, url text, community text, reply text, outcome_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select o.id, p.id, p.platform, p.url, p.community, p.reply, o.outcome_url
  from public.cmo_draft_outcomes o
  join public.opportunities p on p.id = o.item_id and p.user_id = o.user_id
  where o.user_id = p_user and o.department = 'sales' and o.action = 'replied' and o.outcome_checked_at is null
    and o.decided_at <= now() - interval '3 days' and p.reply is not null
  order by o.decided_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;


--
-- Name: cmo_resume(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_resume() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  update public.profiles set cmo_paused_at = null where id = v_user;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  -- A deferred run resumes a little early; that is harmless, and a paused run must not wait forever.
  update public.cmo_runs set not_before = null where user_id = v_user and status = 'queued' and not_before = 'infinity';
end;
$$;


--
-- Name: cmo_run_step(uuid, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_run_step(p_run uuid, p_attempt integer, p_steps jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.cmo_runs set steps = p_steps, lease_until = now() + interval '300 seconds'
  where id = p_run and attempt = p_attempt and status = 'running' and not public.cmo_paused(user_id);
  return found;
end;
$$;


--
-- Name: cmo_save_account_metrics(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_account_metrics(p_user uuid, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_row jsonb;
  v_account public.social_accounts;
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    select * into v_account from public.social_accounts
    where id = (v_row->>'social_account_id')::uuid and user_id = p_user;
    if not found or coalesce(v_row->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      continue;
    end if;
    insert into public.account_metrics (user_id, social_account_id, platform, handle, day, followers, impressions,
      engagements, video_views, posts, measured_at)
    values (p_user, v_account.id, v_account.platform, v_account.handle, (v_row->>'day')::date,
      public.nonneg((v_row->>'followers')::bigint), public.nonneg((v_row->>'impressions')::bigint),
      public.nonneg((v_row->>'engagements')::bigint), public.nonneg((v_row->>'video_views')::bigint),
      public.nonneg((v_row->>'posts')::bigint)::integer, now())
    on conflict (user_id, platform, handle, day) do update
      set social_account_id = excluded.social_account_id, followers = coalesce(excluded.followers, account_metrics.followers),
          impressions = excluded.impressions, engagements = excluded.engagements, video_views = excluded.video_views,
          posts = excluded.posts, measured_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$_$;


--
-- Name: cmo_save_caption(uuid, uuid, uuid, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_caption(p_user uuid, p_run uuid, p_clip uuid, p_profile text, p_text text, p_title text DEFAULT NULL::text, p_gen jsonb DEFAULT '{}'::jsonb) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_hook text;
  v_text text := trim(coalesce(p_text, ''));
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_row public.content_items;
begin
  select c.hook into v_hook from public.clips c join public.jobs j on j.id = c.job_id where c.id = p_clip and j.user_id = p_user;
  if not found then
    raise exception 'Video not found.' using errcode = 'P0002';
  end if;
  perform public.caption_check(p_profile, v_text, v_title);
  if p_gen is not null and (jsonb_typeof(p_gen) <> 'object' or octet_length(p_gen::text) > 1024) then
    raise exception 'This caption is not valid.' using errcode = '22023';
  end if;
  select * into v_row from public.content_items where clip_id = p_clip and platform = p_profile for update;
  if found and (v_row.body ? 'edited_at' or v_row.status <> 'in_review') then
    return v_row;
  end if;
  insert into public.content_items (user_id, run_id, department, platform, day, idea, status, body, clip_id)
  values (p_user, p_run, 'video', p_profile, current_date, left(coalesce(v_title, nullif(v_hook, ''), 'Caption'), 300), 'in_review',
    jsonb_strip_nulls(jsonb_build_object('text', v_text, 'title', v_title, 'drafted_text', v_text, 'drafted_title', v_title,
      'gen', coalesce(p_gen, '{}'::jsonb))),
    p_clip)
  on conflict (clip_id, platform) where clip_id is not null do update
  set body = excluded.body, idea = excluded.idea, run_id = excluded.run_id, updated_at = now()
  returning * into v_row;
  perform public.caption_cards_refresh(p_clip);
  return v_row;
end;
$$;


--
-- Name: cmo_save_draft(uuid, uuid, uuid, text, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_draft(p_user uuid, p_run uuid, p_item uuid, p_idea text, p_body jsonb, p_priority text DEFAULT 'medium'::text, p_platform text DEFAULT NULL::text) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.content_items;
  v_profile jsonb := public.platform_profile(public.platform_profile_id(p_platform));
  v_post boolean := coalesce(v_profile->>'kind' = 'post', false);
  v_platform text := case when v_post then v_profile->>'label' else 'x' end;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body->>'text', '') = '' then
    raise exception 'This draft is not valid.' using errcode = '22023';
  end if;
  if p_body ? 'thread' then
    if not public.thread_valid(p_body) then
      raise exception 'A thread has 5 to 8 posts of at most 280 characters, the first being the post.' using errcode = '22023';
    end if;
    if coalesce(public.platform_profile_id(case when p_item is not null
         then (select platform from public.content_items where id = p_item and user_id = p_user) else v_platform end), 'x') <> 'x' then
      raise exception 'Only an X post can be a thread.' using errcode = '22023';
    end if;
  end if;
  if p_item is not null then
    update public.content_items
    set status = 'in_review', body = p_body, priority = coalesce(p_priority, 'medium'), run_id = p_run, updated_at = now()
    where id = p_item and user_id = p_user and status in ('planned', 'drafting')
    returning * into v_row;
    if not found then
      raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
    end if;
  else
    insert into public.content_items (user_id, run_id, department, platform, day, idea, status, priority, body)
    values (p_user, p_run, 'post', v_platform, current_date,
            left(coalesce(nullif(p_idea, ''), 'Post for ' || case when v_post then v_profile->>'label' else 'X' end), 300),
            'in_review', coalesce(p_priority, 'medium'), p_body)
    returning * into v_row;
  end if;
  return v_row;
end;
$$;


--
-- Name: cmo_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_insights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    kind text NOT NULL,
    body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cmo_insights_body_check CHECK (((jsonb_typeof(body) = 'object'::text) AND (octet_length((body)::text) <= 32768))),
    CONSTRAINT cmo_insights_kind_check CHECK ((kind = ANY (ARRAY['competitors'::text, 'niche_video'::text])))
);


--
-- Name: cmo_save_insight(uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_insight(p_user uuid, p_run uuid, p_kind text, p_body jsonb) RETURNS public.cmo_insights
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_insights;
begin
  insert into public.cmo_insights (user_id, run_id, kind, body) values (p_user, p_run, p_kind, p_body) returning * into v_row;
  -- Giữ 20 bản gần nhất mỗi loại.
  delete from public.cmo_insights where id in (
    select id from public.cmo_insights where user_id = p_user and kind = p_kind order by created_at desc offset 20
  );
  return v_row;
end;
$$;


--
-- Name: cmo_save_lessons(uuid, uuid, date, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_lessons(p_user uuid, p_run uuid, p_week date, p_lessons jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_item jsonb;
  v_count integer := 0;
begin
  if p_week is null or extract(isodow from p_week) <> 1 then
    raise exception 'The week must start on a Monday.' using errcode = '22023';
  end if;
  if p_lessons is null or jsonb_typeof(p_lessons) <> 'array' or jsonb_array_length(p_lessons) > 5 then
    raise exception 'These lessons are not valid.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_lessons) loop
    if coalesce(v_item->>'topic', '') not in ('general', 'post', 'sales', 'video', 'research')
       or char_length(trim(coalesce(v_item->>'body', ''))) = 0 then
      continue;
    end if;
    insert into public.cmo_lessons (user_id, run_id, week, topic, body)
    values (p_user, p_run, p_week, v_item->>'topic', left(trim(v_item->>'body'), 600))
    on conflict (user_id, week, topic) do update set body = excluded.body, run_id = excluded.run_id, created_at = now();
    v_count := v_count + 1;
  end loop;
  -- Keep a year of lessons; older weeks no longer describe the business.
  delete from public.cmo_lessons where user_id = p_user and week < p_week - 364;
  return v_count;
end;
$$;


--
-- Name: cmo_save_metrics(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_metrics(p_user uuid, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row jsonb;
  v_count integer := 0;
  v_source text;
  v_item uuid;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_source := coalesce(v_row->>'source', 'public');
    if v_source not in ('public', 'zernio') then
      raise exception 'These numbers are not valid.' using errcode = '22023';
    end if;
    v_item := (v_row->>'item_id')::uuid;
    -- Only the founder's own published posts: the job never writes numbers onto someone else's.
    if (v_source = 'public' and exists (select 1 from public.content_items i
          where i.id = v_item and i.user_id = p_user and i.status = 'published'))
       or (v_source = 'zernio' and exists (select 1 from public.cmo_zernio_posts(p_user, '-infinity') z where z.item_id = v_item)) then
      if coalesce(v_row->>'views', v_row->>'impressions', v_row->>'likes', v_row->>'replies', v_row->>'reposts', v_row->>'engagements') is null then
        continue;
      end if;
      insert into public.post_metrics (user_id, item_id, url, views, likes, replies, reposts, source, impressions, engagements)
      values (p_user, v_item, left(coalesce(v_row->>'url', ''), 500),
        greatest(0, coalesce((v_row->>'views')::bigint, 0)), greatest(0, coalesce((v_row->>'likes')::bigint, 0)),
        greatest(0, coalesce((v_row->>'replies')::bigint, 0)), greatest(0, coalesce((v_row->>'reposts')::bigint, 0)),
        v_source, public.nonneg((v_row->>'impressions')::bigint), public.nonneg((v_row->>'engagements')::bigint));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;


--
-- Name: cmo_save_opportunities(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_opportunities(p_user uuid, p_run uuid, p_items jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_item jsonb;
  v_count integer := 0;
  v_score integer;
  v_gen jsonb;
  v_rule text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'These conversations are not valid.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_score := least(100, greatest(0, coalesce((v_item->>'score')::integer, 0)));
    v_gen := case when jsonb_typeof(v_item->'gen') = 'object' then jsonb_strip_nulls(jsonb_build_object(
      'model', left(v_item->'gen'->>'model', 100),
      'prompt_version', left(v_item->'gen'->>'prompt_version', 40))) else '{}'::jsonb end;
    -- The subreddit's rule the draft was written under (P5 R1); a skipped thread is kept without a draft.
    v_rule := case when v_item->>'rule' in ('mention_ok', 'help_only', 'skip') then v_item->>'rule' end;
    if v_rule is distinct from 'skip' and coalesce(v_item->>'reply', '') = '' then
      continue;
    end if;
    if coalesce(v_item->>'platform', 'reddit') not in ('reddit', 'hn') then
      raise exception 'A conversation comes from Reddit or Hacker News.' using errcode = '22023';
    end if;
    insert into public.opportunities (
      user_id, run_id, platform, url, community, title, author, snippet, posted_at, comments, score, score_parts, reply,
      priority, gen, rule, rule_why
    ) values (
      p_user, p_run, coalesce(v_item->>'platform', 'reddit'), v_item->>'url', left(coalesce(v_item->>'community', ''), 100),
      left(v_item->>'title', 400),
      left(coalesce(v_item->>'author', ''), 100), left(coalesce(v_item->>'snippet', ''), 1200),
      nullif(v_item->>'posted_at', '')::timestamptz, greatest(0, coalesce((v_item->>'comments')::integer, 0)),
      v_score, coalesce(v_item->'score_parts', '[]'::jsonb),
      case when v_rule = 'skip' then null else left(v_item->>'reply', 3000) end,
      case when v_score >= 85 then 'high' when v_score >= 70 then 'medium' else 'low' end,
      v_gen, v_rule, left(nullif(trim(coalesce(v_item->>'rule_why', '')), ''), 200)
    )
    on conflict (user_id, url) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  update public.content_items set status = 'published', published_at = now(), updated_at = now()
  where user_id = p_user and department = 'sales' and status = 'planned' and day <= current_date;
  return v_count;
end;
$$;


--
-- Name: cmo_save_reply_outcome(uuid, uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_reply_outcome(p_user uuid, p_outcome uuid, p_status text, p_votes integer, p_replies integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_row public.cmo_draft_outcomes;
  v_opp public.opportunities;
  v_where text;
begin
  if p_status is null or p_status not in ('found', 'not_found', 'gone')
     or (p_status = 'found' and p_votes is null and p_replies is null)
     or (p_status <> 'found' and (p_votes is not null or p_replies is not null)) then
    raise exception 'This reply check is not valid.' using errcode = '22023';
  end if;
  update public.cmo_draft_outcomes
  set outcome_status = p_status, outcome_votes = p_votes, outcome_replies = greatest(0, p_replies), outcome_checked_at = now()
  where id = p_outcome and user_id = p_user and department = 'sales' and action = 'replied' and outcome_checked_at is null
  returning * into v_row;
  if not found then
    return false;
  end if;
  if p_status = 'found' then
    select * into v_opp from public.opportunities where id = v_row.item_id;
    v_where := case when v_opp.platform = 'hn' then 'on Hacker News'
                    when coalesce(v_opp.community, '') ~ '^r/[A-Za-z0-9_]{1,40}$' then 'in ' || v_opp.community
                    else 'on Reddit' end;
    insert into public.cmo_memories (user_id, type, body)
    values (p_user, 'feedback', left(format('A reply %s %s got %s and %s three days later.', v_where,
      case when v_row.mentioned_product then 'that named the product' else 'that only helped' end,
      case when p_votes is null then 'no vote count' when p_votes = 1 then '1 vote' else p_votes || ' votes' end,
      case when p_replies is null then 'no reply count' when p_replies = 1 then '1 reply' else p_replies || ' replies' end), 600));
  end if;
  return true;
end;
$_$;


--
-- Name: cmo_set_edit_mode(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_set_edit_mode(p_id uuid, p_mode text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_mode is null or p_mode not in ('NO_MEANINGFUL_EDIT', 'TOO_SALESY', 'WRONG_VOICE', 'INVENTED_CLAIM',
                                      'TOO_LONG', 'HOOK_REWRITTEN', 'CTA_REMOVED', 'FULL_REWRITE') then
    raise exception 'Unknown edit mode.' using errcode = '22023';
  end if;
  update public.cmo_draft_outcomes set edit_mode = p_mode, classified_at = now()
  where id = p_id and classified_at is null;
  return found;
end;
$$;


--
-- Name: cmo_set_week_goal(date, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_set_week_goal(p_week date, p_goal text, p_metric text, p_target integer) RETURNS public.cmo_goals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.cmo_put_goal(public.require_user(), null, p_week, p_goal, p_metric, p_target);
end;
$$;


--
-- Name: cmo_unclassified_outcomes(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_unclassified_outcomes(p_limit integer) RETURNS TABLE(id uuid, draft text, final_text text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select o.id,
    case o.chosen_version when 0 then c.body->>'text' else c.body->'alternates'->>(o.chosen_version - 1) end,
    c.final_text
  from public.cmo_draft_outcomes o
  join public.content_items c on c.id = o.item_id and c.user_id = o.user_id
  where o.department = 'post' and o.action = 'approve' and o.classified_at is null
    and o.similarity is not null and o.chosen_version is not null and c.final_text is not null
  order by o.decided_at
  limit least(greatest(coalesce(p_limit, 0), 0), 100)
$$;


--
-- Name: cmo_update_item(uuid, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_update_item(p_id uuid, p_idea text, p_day date) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.content_items;
begin
  if p_idea is null or char_length(trim(p_idea)) = 0 or char_length(p_idea) > 300 then
    raise exception 'Write the idea in 300 characters or fewer.' using errcode = '22023';
  end if;
  if p_day is null or p_day < current_date or p_day > current_date + 13 then
    raise exception 'Pick a day in the next two weeks.' using errcode = '22023';
  end if;
  update public.content_items set idea = trim(p_idea), day = p_day, updated_at = now()
  where id = p_id and user_id = v_user and status = 'planned'
  returning * into v_row;
  if not found then
    raise exception 'This calendar item is no longer open.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;


--
-- Name: cmo_zernio_posts(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_zernio_posts(p_user uuid, p_since timestamp with time zone) RETURNS TABLE(item_id uuid, external_id text, external_url text, platform text, social_account_id uuid, zernio_account_id text, published_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(case when d.ref_kind = 'content_item' then d.ref_id end, cap.id) as item_id,
    s.external_id, s.external_url, s.platform, s.account_id, a.zernio_account_id, s.publish_at
  from public.schedule_slots s
  join public.deliverables d on d.id = s.deliverable_id
  left join public.social_accounts a on a.id = s.account_id
  left join lateral (
    select i.id from public.content_items i
    where d.ref_kind = 'clip' and i.user_id = p_user and i.clip_id = d.ref_id and i.department = 'video'
      and i.platform = public.platform_profile_id(s.platform)
    order by i.updated_at desc limit 1
  ) cap on true
  where s.user_id = p_user and s.status = 'published' and s.mode = 'publish' and s.external_id is not null
    and s.publish_at >= p_since
  order by s.publish_at desc
  limit 200;
$$;


--
-- Name: complete_caption_translation(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_caption_translation(p_charge_id uuid, p_body text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.caption_translations;
  v_hash text;
begin
  select * into v_row from public.caption_translations
  where id = p_charge_id and user_id = v_user for update;
  if not found or v_row.status <> 'charged' then
    raise exception 'This translation was cancelled. Try again.' using errcode = 'P0001';
  end if;
  perform public.owned_clip(v_row.clip_id, v_user);
  perform public.check_transcript_body(p_body);
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.editor_transcripts (clip_id, hash, body)
  values (v_row.clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;
  update public.caption_translations set status = 'done', hash = v_hash where id = v_row.id;
  return v_hash;
end;
$$;


--
-- Name: complete_cmo_run(uuid, integer, boolean, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_cmo_run(p_run uuid, p_attempt integer, p_ok boolean, p_output jsonb DEFAULT NULL::jsonb, p_error text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_runs;
begin
  update public.cmo_runs
  set status = case when p_ok then 'done' else 'failed' end,
      output = p_output,
      error = case when p_ok then null else left(coalesce(p_error, 'Something went wrong.'), 500) end,
      finished_at = now(), lease_until = null
  where id = p_run and attempt = p_attempt and status = 'running'
  returning * into v_row;
  if not found then
    return false;
  end if;
  -- Lượt xong nhưng không ra gì để bán (W4 không có thread nào đạt): hoàn credit
  -- như lượt hỏng — người dùng không trả tiền cho một lần quét rỗng.
  if not p_ok or coalesce((p_output->>'refund')::boolean, false) then
    perform public.cmo_refund_run(v_row);
  end if;
  return true;
end;
$$;


--
-- Name: complete_generation(uuid, uuid, text, text, numeric, integer, integer, integer, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_generation(p_task_id uuid, p_attempt_id uuid, p_object_name text, p_name text, p_duration numeric, p_width integer, p_height integer, p_credits integer, p_words jsonb DEFAULT NULL::jsonb, p_quality jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_task public.tasks;
  v_generation public.generations;
  v_asset public.media_assets;
  v_final int;
  v_words jsonb;
  v_quality jsonb;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'generate' and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then return false; end if;
  select * into v_generation from public.generations where task_id = p_task_id for update;
  if not found then return false; end if;
  if v_task.status = 'done' then
    return v_generation.status = 'done';
  end if;
  if v_task.status <> 'running' then return false; end if;
  -- The worker names the object itself; checked again so a worker bug cannot attach another
  -- project's file to this generation.
  if p_object_name is null
     or p_object_name !~ ('^' || v_task.user_id || '/' || v_task.job_id || '/gen-[0-9a-f-]{36}\.[a-z0-9]{2,5}$') then
    raise exception 'invalid generated object name';
  end if;

  -- Word timings matter for narrated media only: voiceovers and (v2) explainers, whose captions
  -- the editor builds from them. A bad shape is DROPPED, never failing a paid generation: the
  -- media still works, it just has no captions.
  if (v_generation.kind = 'voice'
      or exists (select 1 from public.ai_models m
                 where m.id = v_generation.model and m.provider = 'opencmo-motion'))
     and p_words is not null
     and jsonb_typeof(p_words) = 'array'
     and jsonb_array_length(p_words) <= 20000
     and octet_length(p_words::text) < 524288
     and not exists (
       select 1 from jsonb_array_elements(p_words) w
       where jsonb_typeof(w) <> 'object'
          or jsonb_typeof(w->'text') is distinct from 'string'
          or jsonb_typeof(w->'start') is distinct from 'number'
          or jsonb_typeof(w->'end') is distinct from 'number'
          or (w->>'start')::numeric < 0
          or (w->>'end')::numeric < (w->>'start')::numeric
     ) then
    v_words := p_words;
  end if;

  -- Long take F9: the garbled-text hint on a finished image. A hint, never a verdict: a bad shape is
  -- dropped and the generation still completes.
  if v_generation.kind = 'image' and public.generation_quality_ok(p_quality) then
    v_quality := p_quality;
  end if;

  insert into public.media_assets (user_id, job_id, storage_path, name, duration, width, height, status, words)
  values (v_task.user_id, v_task.job_id, 'media/' || p_object_name, left(coalesce(nullif(btrim(p_name), ''), 'Generated'), 200),
          p_duration, p_width, p_height, 'ready', v_words)
  returning * into v_asset;

  v_final := least(v_generation.credits_reserved, greatest(coalesce(p_credits, v_generation.credits_reserved), 0));
  update public.generations
  set status = 'done', credits_final = v_final, media_asset_id = v_asset.id, error = null, finished_at = now(),
      quality = v_quality
  where id = v_generation.id;
  if v_generation.credits_reserved - v_final > 0 then
    perform public.credit_settle(v_task.user_id, 'generation', v_generation.id, v_final, 'Generate refund', v_task.job_id);
  end if;
  update public.tasks
  set status = 'done', output = jsonb_build_object('media_asset_id', v_asset.id), error = null,
      finished_at = now(), lease_until = null
  where id = p_task_id;
  -- Shots that continue this one can start now; the worker's sweep claims them.
  update public.tasks set status = 'queued'
  where status = 'awaiting_input'
    and id in (select task_id from public.generations where after_id = v_generation.id);
  return true;
end;
$_$;


--
-- Name: complete_job(uuid, uuid, text, numeric, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_job(p_job_id uuid, p_attempt_id uuid, p_title text, p_duration_seconds numeric, p_clips jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.jobs
  set status = 'done',
      title = p_title,
      duration_seconds = p_duration_seconds,
      finished_at = now(),
      lease_until = null
  where id = p_job_id
    and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if not found then
    return exists (
      select 1 from public.jobs
      where id = p_job_id
        and status = 'done'
        and attempt_id is not distinct from p_attempt_id
    );
  end if;

  insert into public.clips (
    job_id, idx, hook, start_seconds, end_seconds, score, reason, storage_path, preview_path
  )
  select p_job_id, c.idx, c.hook, c.start_seconds, c.end_seconds, c.score, c.reason,
         c.storage_path, c.preview_path
  from jsonb_populate_recordset(null::public.clips, coalesce(p_clips, '[]'::jsonb)) c
  on conflict (job_id, idx) do update
  set hook = excluded.hook,
      start_seconds = excluded.start_seconds,
      end_seconds = excluded.end_seconds,
      score = excluded.score,
      reason = excluded.reason,
      storage_path = excluded.storage_path,
      preview_path = excluded.preview_path;

  return true;
end;
$$;


--
-- Name: complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_job_publication(p_job_id uuid, p_attempt_id uuid, p_title text, p_duration_seconds numeric, p_clips jsonb, p_revisions jsonb, p_manifest jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_job public.jobs;
  v_previous jsonb;
begin
  -- Khoá hàng job trước mọi kiểm tra: reclaim/cancel chạy song song phải chờ,
  -- không thì attempt có thể bị requeue giữa lúc đang chèn clip.
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null then
    return false;
  end if;

  -- Fence đứng TRƯỚC validate: attempt cũ về muộn chỉ nhận false, không được
  -- làm worker tưởng mình gửi dữ liệu hỏng.
  if v_job.status = 'done' and v_job.attempt_id = p_attempt_id then
    return true;
  end if;
  if v_job.status <> 'running' or v_job.attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if p_clips is null or jsonb_typeof(p_clips) <> 'array' then
    raise exception 'Clips must be a list.' using errcode = '22023';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be a list.' using errcode = '22023';
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'The media manifest must be an object.' using errcode = '22023';
  end if;

  -- Kiểm hình dạng trước khi ép kiểu: lỗi cast uuid/numeric của Postgres là
  -- message kỹ thuật, không nên lọt ra màn hình.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where jsonb_typeof(c) <> 'object'
       or coalesce(c ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or jsonb_typeof(c -> 'idx') is distinct from 'number'
       or (c ->> 'idx') !~ '^[0-9]{1,6}$'
       or jsonb_typeof(c -> 'start_seconds') is distinct from 'number'
       or jsonb_typeof(c -> 'end_seconds') is distinct from 'number'
  ) then
    raise exception 'A clip is missing required fields.' using errcode = '22023';
  end if;

  -- Bảng có check `source_end > source_start`, nhưng message constraint là chữ
  -- kỹ thuật; chặn ở đây để lỗi hiện ra còn đọc được.
  if exists (
    select 1 from jsonb_array_elements(p_clips) c
    where (c ->> 'end_seconds')::numeric <= (c ->> 'start_seconds')::numeric
  ) then
    raise exception 'A clip must end after it starts.' using errcode = '22023';
  end if;

  if (select count(distinct c ->> 'id') <> count(*) or count(distinct (c ->> 'idx')::int) <> count(*)
      from jsonb_array_elements(p_clips) c) then
    raise exception 'Clips must have unique ids and positions.' using errcode = '22023';
  end if;

  -- Không thay thế âm thầm clip cũ ở cùng vị trí: editor/task đang trỏ vào id cũ
  -- sẽ thành mồ côi hoặc bị cascade xoá mất lịch sử sửa của người dùng.
  if exists (
    select 1
    from jsonb_array_elements(p_clips) c
    join public.clips old
      on (old.job_id = p_job_id and old.idx = (c ->> 'idx')::int and old.id <> (c ->> 'id')::uuid)
      or (old.id = (c ->> 'id')::uuid and (old.job_id <> p_job_id or old.idx <> (c ->> 'idx')::int))
  ) then
    raise exception 'A different clip already exists at this position.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r -> 'settings') is distinct from 'object'
       or coalesce(r ->> 'settings_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_revisions) r
    where not exists (
      select 1 from jsonb_array_elements(p_clips) c where c ->> 'id' = r ->> 'clip_id'
    )
  ) then
    raise exception 'A revision points to a clip that is not being published.' using errcode = '22023';
  end if;

  if (select count(distinct r ->> 'clip_id') <> count(*) from jsonb_array_elements(p_revisions) r) then
    raise exception 'Each clip can have only one starting revision.' using errcode = '22023';
  end if;

  -- Biên nhận khác đầu vào nghĩa là cùng attempt đã ghi settings bằng dữ liệu
  -- khác — ghi tiếp là để hai phiên bản sự thật cùng tồn tại.
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found and v_previous is distinct from p_revisions then
    raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
  end if;

  insert into public.clips (
    id, job_id, idx, hook, start_seconds, end_seconds, score, reason,
    storage_path, preview_path, source_start, source_end
  )
  select (c ->> 'id')::uuid, p_job_id, (c ->> 'idx')::int, c ->> 'hook',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric,
         (c ->> 'score')::numeric, c ->> 'reason', c ->> 'storage_path', c ->> 'preview_path',
         (c ->> 'start_seconds')::numeric, (c ->> 'end_seconds')::numeric
  from jsonb_array_elements(p_clips) c
  where not exists (select 1 from public.clips old where old.id = (c ->> 'id')::uuid);

  -- Settings gốc ghi một lần: clip đã có (attempt trước đã công bố) giữ nguyên.
  update public.clips c
  set settings = r -> 'settings', settings_hash = r ->> 'settings_hash'
  from jsonb_array_elements(p_revisions) r
  where c.id = (r ->> 'clip_id')::uuid and c.settings is null;

  if v_previous is null then
    insert into public.worker_draft_initializations (job_id, attempt_id, revisions)
    values (p_job_id, p_attempt_id, p_revisions);
  end if;

  update public.jobs
  set media_manifest = p_manifest,
      title = p_title,
      duration_seconds = p_duration_seconds,
      status = 'done',
      finished_at = now(),
      lease_until = null
  where id = p_job_id;

  return true;
end;
$_$;


--
-- Name: complete_media_captions(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_media_captions(p_task_id uuid, p_attempt_id uuid, p_body text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_task public.tasks;
  v_hash text;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'transcribe_media' and status = 'running'
    and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then
    select output ->> 'hash' into v_hash from public.tasks
    where id = p_task_id and status = 'done' and attempt_id is not distinct from p_attempt_id;
    return v_hash;
  end if;
  perform public.check_transcript_body(p_body);
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.editor_transcripts (clip_id, hash, body)
  values (v_task.clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;
  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null,
      output = jsonb_build_object('hash', v_hash, 'src', 'assets/transcripts/' || v_hash || '.json')
  where id = p_task_id;
  return v_hash;
end;
$$;


--
-- Name: complete_media_probe(uuid, uuid, numeric, integer, integer, boolean, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_media_probe(p_asset_id uuid, p_attempt_id uuid, p_duration numeric, p_width integer, p_height integer, p_ok boolean, p_error text DEFAULT NULL::text, p_has_audio boolean DEFAULT NULL::boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_task public.tasks;
  v_error text := case when p_ok then null
    else left(coalesce(p_error, 'We could not read this media file.'), 2000) end;
begin
  if p_attempt_id is null or p_ok is null then return false; end if;
  select * into v_task from public.tasks
  where kind = 'probe_media' and asset_id = p_asset_id and attempt_id = p_attempt_id
  for update;
  if not found then return false; end if;
  if v_task.status in ('done', 'failed') then
    return v_task.status = case when p_ok then 'done' else 'failed' end
      and v_task.duration is not distinct from p_duration
      and v_task.width is not distinct from p_width
      and v_task.height is not distinct from p_height
      and v_task.error is not distinct from v_error;
  end if;
  if v_task.status <> 'running' then return false; end if;
  update public.tasks set status = case when p_ok then 'done' else 'failed' end,
    duration = p_duration, width = p_width, height = p_height, error = v_error,
    finished_at = now(), lease_until = null where id = v_task.id;
  update public.media_assets set status = case when p_ok then 'ready' else 'rejected' end,
    duration = p_duration, width = p_width, height = p_height, error = left(v_error, 500),
    has_audio = case when p_ok then p_has_audio end
  where id = p_asset_id;
  if p_ok then
    perform public.queue_asset_transcript(p_asset_id);
  end if;
  return true;
end;
$$;


--
-- Name: complete_media_transcript(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_media_transcript(p_task_id uuid, p_attempt_id uuid, p_body text, p_source text DEFAULT 'scribe'::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_task public.tasks;
  v_asset public.media_assets;
  v_hash text;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'transcribe_asset' and status = 'running'
    and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then
    select output ->> 'hash' into v_hash from public.tasks
    where id = p_task_id and kind = 'transcribe_asset' and status = 'done'
      and attempt_id is not distinct from p_attempt_id;
    return v_hash;
  end if;
  perform public.check_transcript_body(p_body);
  select * into v_asset from public.media_assets where id = v_task.asset_id and user_id = v_task.user_id;
  if not found then
    raise exception 'This file is no longer stored with this project.' using errcode = 'P0002';
  end if;
  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  insert into public.media_transcripts (asset_id, user_id, hash, body, seconds, source)
  values (v_asset.id, v_asset.user_id, v_hash, p_body, greatest(v_asset.duration, 0.001), p_source)
  on conflict (asset_id) do update
    set hash = excluded.hash, body = excluded.body, seconds = excluded.seconds,
        source = excluded.source, created_at = now();
  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null,
      output = jsonb_build_object('hash', v_hash)
  where id = p_task_id;
  return v_hash;
end;
$$;


--
-- Name: complete_page_capture(uuid, uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_page_capture(p_task_id uuid, p_attempt_id uuid, p_title text, p_width integer, p_height integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_task public.tasks;
  v_capture public.page_captures;
  v_prefix text;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'capture_page' and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then return false; end if;
  if v_task.status = 'done' then return true; end if;
  if v_task.status <> 'running' then return false; end if;
  select * into v_capture from public.page_captures
  where id = (v_task.payload ->> 'capture_id')::uuid and user_id = v_task.user_id and task_id = v_task.id
  for update;
  if not found then
    raise exception 'This capture no longer exists.' using errcode = 'P0002';
  end if;
  if p_width is null or p_width < 1 or p_height is null or p_height < 1 then
    raise exception 'Invalid capture size.' using errcode = '22023';
  end if;
  v_prefix := v_task.user_id::text || '/' || v_capture.id::text || '/';
  update public.page_captures
  set status = 'ready', error = null, title = left(nullif(btrim(coalesce(p_title, '')), ''), 300),
      width = p_width, height = p_height,
      image_path = v_prefix || 'page.png', boxes_path = v_prefix || 'page.boxes.json',
      finished_at = now()
  where id = v_capture.id;
  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null,
      output = jsonb_build_object('capture_id', v_capture.id, 'width', p_width, 'height', p_height)
  where id = v_task.id;
  return true;
end;
$$;


--
-- Name: complete_task(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_task(p_task_id uuid, p_attempt_id uuid, p_output jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.tasks
  set status = 'done',
      output = p_output,
      -- Các cột rút ra từ output để truy vấn được mà không phải mở jsonb: UI
      -- hiện kích thước file và độ phân giải ngay trên danh sách.
      output_path = coalesce(p_output ->> 'output_path', output_path),
      bytes = coalesce((p_output ->> 'bytes')::bigint, bytes),
      width = coalesce((p_output ->> 'width')::int, width),
      height = coalesce((p_output ->> 'height')::int, height),
      duration = coalesce((p_output ->> 'duration')::numeric, duration),
      error = null,
      finished_at = now(),
      lease_until = null
  where id = p_task_id and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if found then
    return true;
  end if;

  return exists (
    select 1 from public.tasks
    where id = p_task_id and status = 'done'
      and attempt_id is not distinct from p_attempt_id
  );
end;
$$;


--
-- Name: confirm_object_deletions(bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_object_deletions(p_ids bigint[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_rows int;
begin
  if p_ids is null or array_length(p_ids, 1) is null then return 0; end if;
  delete from public.storage_deletions where id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;


--
-- Name: consume_daily_task_quota(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_daily_task_quota(p_kind text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid := public.require_user(); v_plan text; v_limits record; v_limit int;
begin
  if p_kind not in ('preview','export') then raise exception 'Invalid task quota.' using errcode='22023'; end if;
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  v_limit := case when p_kind = 'preview' then v_limits.preview_daily else v_limits.export_daily end;
  if not public.rate_limit_hit('daily_' || p_kind, v_limit, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
  end if;
end;
$$;


--
-- Name: consume_upload_reservation(text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_upload_reservation(p_bucket text, p_object_name text, p_project_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
declare
  v_user uuid := public.require_user();
  v_res public.upload_reservations;
  v_size bigint;
begin
  select * into v_res from public.upload_reservations
    where user_id = v_user and bucket = p_bucket and object_name = p_object_name
    for update;
  if not found or v_res.status <> 'reserved' or v_res.expires_at <= now()
     or v_res.project_id is distinct from p_project_id then
    raise exception 'That upload is not ready. Please upload it again.' using errcode = 'P0001';
  end if;
  select coalesce((metadata->>'size')::bigint, 0) into v_size from storage.objects
    where bucket_id = p_bucket and name = p_object_name;
  if not found or v_size <= 0 or v_size > v_res.declared_size then
    raise exception 'That upload is not ready. Please upload it again.' using errcode = 'P0001';
  end if;
  update public.upload_reservations set status = 'consumed' where id = v_res.id;
end;
$$;


--
-- Name: correction_from_edits(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correction_from_edits(p_outcome uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_o public.cmo_draft_outcomes;
  v_rule text;
  v_since timestamptz;
  v_n integer;
  v_edits jsonb;
  v_id uuid;
begin
  select * into v_o from public.cmo_draft_outcomes where id = p_outcome;
  v_rule := public.correction_rule(v_o.edit_mode);
  if v_o.id is null or v_rule is null or v_o.department <> 'post' or v_o.action <> 'approve' then
    return null;
  end if;
  -- The same lock as `cmo_propose_correction`: one proposal at a time per founder.
  perform pg_advisory_xact_lock(hashtextextended('cmo_corrections:' || v_o.user_id::text, 0));
  if exists (select 1 from public.cmo_corrections where user_id = v_o.user_id and edit_mode = v_o.edit_mode and status = 'proposed') then
    return null;
  end if;
  v_since := greatest(now() - interval '14 days', coalesce((
    select max(created_at) from public.cmo_corrections where user_id = v_o.user_id and edit_mode = v_o.edit_mode), '-infinity'));
  select count(*) into v_n from public.cmo_draft_outcomes
  where user_id = v_o.user_id and department = 'post' and action = 'approve' and edit_mode = v_o.edit_mode and decided_at > v_since;
  if v_n < 3 then
    return null;
  end if;
  -- An approved rule with the same words already holds; five waiting rules are enough for one founder.
  if exists (select 1 from public.cmo_corrections where user_id = v_o.user_id and status = 'active' and lower(rule) = lower(v_rule))
     or (select count(*) from public.cmo_corrections where user_id = v_o.user_id and status = 'proposed') >= 5 then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('before', left(e.draft, 300), 'after', left(e.final_text, 300), 'at', e.at)
    order by e.decided_at desc, e.id), '[]'::jsonb)
  into v_edits
  from (
    select case o.chosen_version when 0 then c.body->>'text' else c.body->'alternates'->>(o.chosen_version - 1) end as draft,
      c.final_text, to_char(o.decided_at, 'YYYY-MM-DD') as at, o.decided_at, o.id
    from public.cmo_draft_outcomes o
    join public.content_items c on c.id = o.item_id and c.user_id = o.user_id
    where o.user_id = v_o.user_id and o.department = 'post' and o.action = 'approve' and o.edit_mode = v_o.edit_mode
      and o.decided_at > v_since and c.final_text is not null and o.chosen_version is not null
    order by o.decided_at desc, o.id
    limit 3
  ) e
  where e.draft is not null;
  insert into public.cmo_corrections (user_id, rule, source_edits, edit_mode, times)
  values (v_o.user_id, v_rule, v_edits, v_o.edit_mode, least(v_n, 100))
  returning id into v_id;
  return v_id;
end;
$$;


--
-- Name: correction_rule(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correction_rule(p_mode text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_mode
    when 'TOO_SALESY' then 'Help first: drop the pitch and the hype.'
    when 'WRONG_VOICE' then 'Write the way I talk: plain words, short sentences, no marketing tone.'
    when 'INVENTED_CLAIM' then 'Never state a number, result or story that is not in my documents.'
    when 'TOO_LONG' then 'Keep it short: one idea, no extra lines.'
    when 'HOOK_REWRITTEN' then 'Open with a plain, specific first line.'
    when 'CTA_REMOVED' then 'End on the point itself: no closing ask, no summary line.'
    else null end
$$;


--
-- Name: create_api_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_api_key(p_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_key text;
  v_row public.api_keys;
begin
  if not public.is_paid(v_user) then
    -- P0001 so the route shows the message (lib/api/errors.ts passes it through).
    raise exception 'API keys are part of the paid plans.' using errcode = 'P0001';
  end if;
  if v_name = '' or char_length(v_name) > 60 then
    raise exception 'Name the key in 1 to 60 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.api_keys where user_id = v_user and revoked_at is null) >= 10 then
    raise exception 'You already have 10 active keys. Revoke one first.' using errcode = 'P0001';
  end if;
  v_key := 'ocm_' || encode(gen_random_bytes(24), 'hex');
  insert into public.api_keys (user_id, name, prefix, key_hash)
  values (v_user, v_name, left(v_key, 12), encode(digest(v_key, 'sha256'), 'hex'))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'prefix', v_row.prefix, 'created_at', v_row.created_at, 'key', v_key);
end;
$$;


--
-- Name: create_blank_edit(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_blank_edit(p_name text DEFAULT NULL::text, p_aspect text DEFAULT '9:16'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 120), '');
  v_job uuid;
  v_clip uuid;
begin
  if p_aspect is null or p_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Choose a frame: 9:16, 1:1 or 16:9.' using errcode = '22023';
  end if;
  -- Chặn tạo hàng loạt project rỗng: cùng trần với các lượt tạo project khác.
  if (select count(*) from public.jobs where user_id = v_user and kind = 'edit' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'You have created many edits in the last hour. Try again later.' using errcode = 'P0001';
  end if;

  insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at)
  values (v_user, 'edit', 'editor://blank', coalesce(v_name, 'Untitled edit'), 'done', p_aspect, 0, 0, now())
  returning id into v_job;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, -1, coalesce(v_name, 'Untitled edit'), 0, 0, null, null, 'blank')
  returning id into v_clip;
  return v_clip;
end;
$$;


--
-- Name: create_clip_drafts(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_clip_drafts(p_job_id uuid, p_attempt_id uuid, p_revisions jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_job public.jobs;
  v_previous jsonb;
  v_created int;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null or v_job.attempt_id is distinct from p_attempt_id
     or v_job.status not in ('running', 'done') then
    raise exception 'This processing attempt is no longer active.' using errcode = 'P0001';
  end if;
  if p_revisions is null or jsonb_typeof(p_revisions) <> 'array' then
    raise exception 'Revisions must be an array.' using errcode = '22023';
  end if;
  select revisions into v_previous from public.worker_draft_initializations
  where job_id = p_job_id and attempt_id = p_attempt_id;
  if found then
    if v_previous is distinct from p_revisions then
      raise exception 'Drafts were already initialized with different content.' using errcode = '22023';
    end if;
    return 0;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_revisions) item
    where not exists (select 1 from public.clips c
      where c.id = (item ->> 'clip_id')::uuid and c.job_id = p_job_id)
  ) then
    raise exception 'A clip does not belong to this project.' using errcode = '22023';
  end if;
  -- Trước đây constraint của `clip_revisions` chặn hash sai; giờ kiểm ở đây để lỗi
  -- còn đọc được.
  if exists (
    select 1 from jsonb_array_elements(p_revisions) item
    where jsonb_typeof(item -> 'settings') is distinct from 'object'
       or coalesce(item ->> 'settings_hash', '') !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;
  update public.clips c
  set settings = item -> 'settings', settings_hash = item ->> 'settings_hash'
  from jsonb_array_elements(p_revisions) item
  where c.id = (item ->> 'clip_id')::uuid and c.settings is null;
  get diagnostics v_created = row_count;
  insert into public.worker_draft_initializations values (p_job_id, p_attempt_id, p_revisions);
  return v_created;
end;
$_$;


--
-- Name: create_generation(uuid, uuid, text, jsonb, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_generation(p_job_id uuid, p_clip_id uuid, p_model text, p_spec jsonb, p_spec_hash text, p_request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_model public.ai_models;
  v_generation public.generations;
  v_task public.tasks;
  v_price int;
  v_parent public.generations;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_spec_hash is null or p_spec_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid generation request.' using errcode = '22023';
  end if;
  -- Khoá theo người dùng: kiểm số dư, trần đang chạy và trùng hash phải đọc
  -- một trạng thái mà hai request song song không cùng thấy.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 2905));

  -- Gửi lại cùng request id (mạng rớt sau khi server đã ghi) → trả lại đúng lượt đó.
  select g.* into v_generation from public.generations g
  join public.tasks t on t.id = g.task_id
  where t.request_id = p_request_id and g.user_id = v_user;
  if found then
    return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', true);
  end if;
  if exists (select 1 from public.tasks where request_id = p_request_id) then
    raise exception 'That request id was already used.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.jobs
    where id = p_job_id and user_id = v_user and purging_at is null
  ) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if p_clip_id is not null and not exists (
    select 1 from public.clips where id = p_clip_id and job_id = p_job_id
  ) then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;

  select * into v_model from public.ai_models where id = p_model and enabled;
  if not found then
    raise exception 'This model is not available.' using errcode = '22023';
  end if;
  perform public.ai_check_spec(v_model, p_spec);

  -- A finished generation whose file was deleted from the library cannot be reused: Retry would
  -- return it forever, with no file. Its hash is retired (still 64 hex characters) so a new one can
  -- be made; a shot continuing it then waits for the new one like for any parent.
  update public.generations
  set spec_hash = encode(sha256(convert_to(spec_hash || ':retired:' || id::text, 'UTF8')), 'hex')
  where job_id = p_job_id and spec_hash = p_spec_hash and status = 'done' and media_asset_id is null;

  select * into v_generation from public.generations
  where job_id = p_job_id and spec_hash = p_spec_hash and status in ('queued', 'running', 'done');
  if found then
    return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', true);
  end if;

  -- New generations only (reuse returned above): each one runs a paid prompt check on the worker, and a
  -- blocked prompt is refunded in full, so the web's `generations` limit alone left a free loop open.
  if not public.rate_limit_hit('generation_create', 120, 3600) then
    raise exception 'Too many generations started. Wait a while and try again.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.generations
      where user_id = v_user and status in ('queued', 'running')) >= public.generation_active_limit() then
    raise exception 'Too many generations are running. Wait for one to finish.' using errcode = 'P0001';
  end if;

  v_price := public.ai_price(v_model, p_spec);
  if public.credit_balance(v_user) < v_price then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_price, public.credit_balance(v_user) using errcode = 'P0001';
  end if;

  -- A shot that continues another (`after`) waits for it: same project and owner, still live.
  -- The row lock orders this against `complete_generation`, which releases waiting children.
  if p_spec ? 'after' then
    select * into v_parent from public.generations
    where job_id = p_job_id and user_id = v_user and spec_hash = p_spec->>'after'
      and status in ('queued', 'running', 'done')
    for update;
    if not found then
      raise exception 'Start the shot before this one first.' using errcode = '22023';
    end if;
  end if;

  insert into public.generations (user_id, job_id, clip_id, kind, model, spec, spec_hash, credits_reserved, after_id)
  values (v_user, p_job_id, p_clip_id, v_model.kind, v_model.id, p_spec, p_spec_hash, v_price, v_parent.id)
  returning * into v_generation;
  insert into public.tasks (user_id, kind, job_id, clip_id, payload, request_id, status)
  values (v_user, 'generate', p_job_id, p_clip_id, jsonb_build_object('generation_id', v_generation.id), p_request_id,
          case when v_parent.id is not null and v_parent.status <> 'done' then 'awaiting_input' else 'queued' end)
  returning * into v_task;
  update public.generations set task_id = v_task.id where id = v_generation.id returning * into v_generation;
  if v_price > 0 then
    perform public.credit_hold(v_user, 'generation', v_generation.id, v_price, 'Generate hold', p_job_id);
  end if;

  return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', false);
end;
$_$;


--
-- Name: create_post_image_edit(text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_post_image_edit(p_name text, p_aspect text, p_source_clip uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    insert into public.jobs (user_id, kind, source_url, title, status, aspect, clips_requested, duration_seconds, finished_at, watermark)
    values (v_user, 'edit', 'editor://blank', v_name, 'done', p_aspect, 0, 0, now(),
      (select coalesce(plan, 'free') = 'free' from public.profiles where id = v_user))
    returning id into v_job;
  end if;
  insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
  values (v_job, v_idx, v_name, 0, 0, null, null, 'slideshow')
  returning id into v_clip;
  return v_clip;
end;
$$;


--
-- Name: create_slideshow(text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_slideshow(p_name text DEFAULT NULL::text, p_aspect text DEFAULT '9:16'::text, p_order uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;


--
-- Name: create_upload_edit(text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_upload_edit(p_source_url text, p_aspect text DEFAULT '9:16'::text, p_captions boolean DEFAULT true) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_job public.jobs;
  v_source text := btrim(coalesce(p_source_url, ''));
  v_aspect text := coalesce(p_aspect, '9:16');
begin
  if v_source not like 'storage://%' then
    raise exception 'Upload the video file to edit it.' using errcode = '22023';
  end if;
  if v_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Unsupported aspect ratio.' using errcode = '22023';
  end if;

  if (select count(*) from public.jobs
      where user_id = v_user and status in ('queued', 'running') and purging_at is null) >= 3
  then
    raise exception 'You already have 3 projects in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;
  if not public.rate_limit_hit('jobs', 10, 3600) then
    raise exception 'Too many projects started. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;

  perform public.consume_upload_reservation('sources', substring(v_source from 11), null);

  perform 1 from public.profiles where id = v_user for update;
  v_balance := public.credit_balance(v_user);
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs (user_id, source_url, clips_requested, watermark, aspect, captions)
  values (v_user, v_source, 1, coalesce(v_plan, 'free') = 'free', v_aspect, coalesce(p_captions, true))
  returning * into v_job;

  perform public.credit_hold(v_user, 'job', v_job.id, v_hold, 'Hold for new job', v_job.id);
  return v_job;
end;
$$;


--
-- Name: credit_balance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_balance(p_user_id uuid) RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select p.credit_balance
    from public.profiles p
    where p.id = p_user_id
  ), 0);
$$;


--
-- Name: credit_held(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_held(p_ref_kind text, p_ref_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(-sum(delta), 0)::int from public.credit_ledger
  where (ref_kind = p_ref_kind and ref_id = p_ref_id)
     -- Dòng trước R6 chỉ có `job_id`: thời đó mọi dòng có job_id được tính là của job.
     or (p_ref_kind = 'job' and ref_kind is null and job_id = p_ref_id);
$$;


--
-- Name: credit_hold(uuid, text, uuid, integer, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_hold(p_user uuid, p_ref_kind text, p_ref_id uuid, p_amount integer, p_reason text, p_job_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_amount is null or p_amount <= 0 then
    return 0;
  end if;
  -- Cùng khoá với trigger cập nhật số dư (`profiles`), lấy ở đúng chỗ trigger đã lấy: thứ
  -- tự khoá của các flow không đổi.
  perform public.lock_credit_owner(p_user);
  if public.credit_balance(p_user) < p_amount then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      p_amount, public.credit_balance(p_user) using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (user_id, delta, reason, job_id, ref_kind, ref_id)
  values (p_user, -p_amount, p_reason, p_job_id, p_ref_kind, p_ref_id);
  return p_amount;
end;
$$;


--
-- Name: credit_refund(uuid, text, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_refund(p_user uuid, p_ref_kind text, p_ref_id uuid, p_reason text, p_job_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.lock_credit_owner(p_user);
  -- Không bao giờ thu thêm khi "hoàn": số đang giữ âm (đã hoàn quá) thì thôi.
  if public.credit_held(p_ref_kind, p_ref_id) <= 0 then
    return 0;
  end if;
  return public.credit_settle(p_user, p_ref_kind, p_ref_id, 0, p_reason, p_job_id);
end;
$$;


--
-- Name: credit_settle(uuid, text, uuid, integer, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_settle(p_user uuid, p_ref_kind text, p_ref_id uuid, p_final integer, p_reason text, p_job_id uuid DEFAULT NULL::uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_delta int;
begin
  perform public.lock_credit_owner(p_user);
  v_delta := public.credit_held(p_ref_kind, p_ref_id) - greatest(coalesce(p_final, 0), 0);
  if v_delta = 0 then
    return 0;
  end if;
  if v_delta < 0 and public.credit_balance(p_user) < -v_delta then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      -v_delta, public.credit_balance(p_user) using errcode = 'P0001';
  end if;
  insert into public.credit_ledger (user_id, delta, reason, job_id, ref_kind, ref_id)
  values (p_user, v_delta, p_reason, p_job_id, p_ref_kind, p_ref_id);
  return v_delta;
end;
$$;


--
-- Name: cut_shorts_order(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cut_shorts_order(p_clip_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.cut_shorts_order_for(public.require_user(), p_clip_id, 'founder');
end;
$$;


--
-- Name: cut_shorts_order_for(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cut_shorts_order_for(p_user uuid, p_clip_id uuid, p_created_by text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_clip public.clips := public.owned_clip(p_clip_id, p_user);
  v_project public.editor_projects;
  v_root public.work_orders;
  v_id uuid;
begin
  if v_clip.kind = 'short' then
    raise exception 'A short is not cut into shorts.' using errcode = 'P0001';
  end if;
  select * into v_project from public.editor_projects where clip_id = p_clip_id for update;
  if not found or v_project.finished_hash is null
     or v_project.finished_hash is distinct from public.editor_document_hash(v_project.document) then
    raise exception 'Mark this edit finished first: shorts are cut only from a finished edit.' using errcode = 'P0001';
  end if;
  if public.cmo_paused(p_user) then
    raise exception 'Your CMO is paused. Resume it to start new work.' using errcode = 'P0001';
  end if;
  select id into v_id from public.work_orders
  where user_id = p_user and kind = 'cut_shorts' and brief->>'clip_id' = p_clip_id::text
    and brief->>'finished_hash' = v_project.finished_hash and status not in ('failed', 'cancelled')
  limit 1;
  if found then
    return v_id;
  end if;
  -- Each order runs the Clip editor and renders three shorts: a daily cap keeps re-marking from looping it.
  if (select count(*) from public.work_orders where user_id = p_user and kind = 'cut_shorts'
      and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You can cut shorts 10 times a day. Try again tomorrow.' using errcode = 'P0001';
  end if;
  v_root := public.work_order_week_root(p_user);
  select id into v_id from public.work_order_create(p_user, v_root.week, v_root.id, 'cut_shorts',
    left('Shorts from “' || coalesce(nullif(v_clip.hook, ''), 'your video') || '”', 200),
    jsonb_build_object('objective', 'Cut 3 shorts from the finished edit.', 'clip_id', p_clip_id,
      'finished_hash', v_project.finished_hash, 'done_when', 'The founder approved the shorts batch.'),
    0, null, '{}', p_created_by);
  return v_id;
end;
$$;


--
-- Name: defer_object_deletions(bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.defer_object_deletions(p_ids bigint[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_rows int;
begin
  update public.storage_deletions set attempts = attempts + 1, deferred_at = clock_timestamp()
    where id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;


--
-- Name: delete_brand_kit(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_brand_kit(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.brand_kits;
  v_logo text;
begin
  delete from public.brand_kits where id = p_id and user_id = v_user returning * into v_row;
  if not found then return false; end if;
  v_logo := v_row.kit->'logo'->>'object';
  if v_logo is not null and not exists(
    select 1 from public.brand_kits where user_id = v_user and kit->'logo'->>'object' = v_logo
  ) then
    insert into public.storage_deletions (bucket, path, user_id) values ('brand', v_logo, v_user)
    on conflict (bucket, path) do nothing;
  end if;
  return true;
end;
$$;


--
-- Name: delete_editor_skill(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_editor_skill(p_name text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.editor_skills s where s.user_id = v_user and s.name = lower(trim(coalesce(p_name, '')));
  return found;
end;
$$;


--
-- Name: delete_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
begin
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status in ('queued', 'running') then
    raise exception 'Stop this project before deleting it.' using errcode = '22023';
  end if;
  if exists (select 1 from public.tasks t where t.status in ('queued', 'running')
    and (t.job_id = p_job_id
      or t.clip_id in (select id from public.clips where job_id = p_job_id)
      or t.asset_id in (select id from public.media_assets where job_id = p_job_id))) then
    raise exception 'Wait for this project’s tasks to finish before deleting it.' using errcode = '22023';
  end if;
  delete from public.jobs where id = p_job_id and user_id = v_user;
  return found;
end;
$$;


--
-- Name: delete_media_asset(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_media_asset(p_asset_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.media_assets m
  using public.jobs j
  where m.id = p_asset_id
    and m.user_id = v_user
    and j.id = m.job_id
    and j.user_id = v_user
    and j.purging_at is null;

  if not found then
    raise exception 'That media file was not found.' using errcode = 'P0002';
  end if;
end;
$$;


--
-- Name: deliverables_caption_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deliverables_caption_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_caption public.content_items;
begin
  if new.ref_kind <> 'clip' or new.kind not in ('video', 'short') then
    return new;
  end if;
  for v_caption in select * from public.content_items where clip_id = new.ref_id and department = 'video' and user_id = new.user_id loop
    perform public.caption_deliver(v_caption);
  end loop;
  return new;
end;
$$;


--
-- Name: deliverables_parent_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deliverables_parent_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.parent_id is not null and not exists (
    select 1 from public.deliverables p
    where p.id = new.parent_id and p.user_id = new.user_id and p.kind in ('video', 'short')
  ) then
    raise exception 'A caption belongs to one of your videos or shorts.' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: editor_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_projects (
    clip_id uuid NOT NULL,
    manifest jsonb DEFAULT '{"assets": [], "folders": [], "version": 1}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    document jsonb NOT NULL,
    generated_document jsonb,
    finished_at timestamp with time zone,
    finished_hash text,
    CONSTRAINT editor_projects_document_check CHECK (((document IS NULL) OR (octet_length((document)::text) < 262144))),
    CONSTRAINT editor_projects_finished_check CHECK (((finished_at IS NULL) = (finished_hash IS NULL))),
    CONSTRAINT editor_projects_finished_hash_check CHECK ((finished_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT editor_projects_generated_document_check CHECK (((generated_document IS NULL) OR (octet_length((generated_document)::text) < 262144))),
    CONSTRAINT editor_projects_manifest_check CHECK ((pg_column_size(manifest) < 65536))
);


--
-- Name: document_hash(public.editor_projects); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_hash(p_project public.editor_projects) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select public.editor_document_hash(p_project.document);
$$;


--
-- Name: editor_document_hash(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editor_document_hash(p_document jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select encode(sha256(convert_to(p_document::text, 'UTF8')), 'hex');
$$;


--
-- Name: editor_document_shape_ok(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editor_document_shape_ok(p_document jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
  -- `coalesce`: khoá vắng mặt cho NULL, và `not NULL` là NULL — một `if` sẽ
  -- lặng lẽ cho document thiếu `version` đi qua.
  select coalesce(
    jsonb_typeof(p_document) = 'object'
      and jsonb_typeof(p_document->'version') = 'number'
      and (p_document->>'version') ~ '^[1-9][0-9]*$'
      and jsonb_typeof(p_document->'stage') = 'object'
      and octet_length(p_document::text) < 262144,
    false);
$_$;


--
-- Name: editor_json(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editor_json(p_clip_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object(
    'clip_id',       p.clip_id,
    'document',      p.document,
    'document_hash', public.editor_document_hash(p.document),
    'manifest',      p.manifest,
    'version',       p.version,
    'updated_at',    p.updated_at
  )
  from public.editor_projects p
  where p.clip_id = p_clip_id;
$$;


--
-- Name: editor_projects_clear_finished(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editor_projects_clear_finished() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.finished_hash is not null and new.document is distinct from old.document
     and public.editor_document_hash(new.document) is distinct from new.finished_hash then
    new.finished_at := null;
    new.finished_hash := null;
  end if;
  return new;
end;
$$;


--
-- Name: editor_projects_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editor_projects_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
begin
  if new.document is distinct from old.document then
    perform public.approval_close('editor_project', new.clip_id, 'cancelled');
  end if;
  if new.finished_hash is not null and new.finished_hash is distinct from old.finished_hash then
    select j.user_id into v_user from public.clips c join public.jobs j on j.id = c.job_id
    where c.id = new.clip_id and c.kind <> 'short';
    if v_user is not null and not public.cmo_paused(v_user) then
      begin
        perform public.cut_shorts_order_for(v_user, new.clip_id, 'event');
      exception when others then
        raise warning 'cut_shorts rule failed for clip %: %', new.clip_id, sqlerrm;
      end;
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: email_log_claim(uuid, text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.email_log_claim(p_user uuid, p_kind text, p_approval_ids uuid[]) RETURNS TABLE(log_id uuid, approval_ids uuid[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_day date := (now() at time zone public.schedule_timezone(p_user))::date;
  v_ids uuid[];
  v_id uuid;
begin
  if p_kind not in ('digest', 'expiring') then
    raise exception 'Unknown email kind.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_log:' || p_user::text, 0));
  if exists (select 1 from public.notify_settings n where n.user_id = p_user and not n.email_digest) then
    return;
  end if;
  -- Only the founder's own cards that still wait.
  select coalesce(array_agg(a.id order by a.created_at), '{}') into v_ids
  from public.approvals a
  where a.id = any(coalesce(p_approval_ids, '{}')) and a.user_id = p_user and a.status = 'waiting';
  if p_kind = 'expiring' then
    select coalesce(array_agg(i order by i), '{}') into v_ids from unnest(v_ids) i
    where not exists (select 1 from public.email_log l
                      where l.user_id = p_user and l.kind = 'expiring' and l.status <> 'failed' and i = any(l.approval_ids));
  end if;
  if cardinality(v_ids) = 0 then
    return;
  end if;
  v_ids := v_ids[1:50];
  insert into public.email_log (user_id, kind, day, approval_ids)
  values (p_user, p_kind, v_day, v_ids)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return;
  end if;
  return query select v_id, v_ids;
end;
$$;


--
-- Name: email_log_done(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.email_log_done(p_log uuid, p_provider_id text, p_error text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_error is null then
    update public.email_log set status = 'sent', provider_id = left(p_provider_id, 100), sent_at = now() where id = p_log;
  else
    update public.email_log set status = 'failed', error = left(p_error, 500) where id = p_log;
    delete from public.email_log where id = p_log and kind = 'digest';
  end if;
end;
$$;


--
-- Name: email_unsubscribe(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.email_unsubscribe(p_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.notify_settings
  set email_digest = false, unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
  where unsubscribe_token = p_token;
  return true;
end;
$$;


--
-- Name: enforce_write_budget(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_write_budget() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_rows int;
  v_bytes bigint;
  v_size bigint;
begin
  if v_user is null then
    return new;
  end if;
  -- Serialised per user and table, so parallel calls cannot all pass the same check.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':write-budget:' || tg_table_name, 0));
  -- Statements, not a CASE expression: plpgsql resolves every `new.<field>` in an expression on each table.
  if tg_table_name = 'editor_transcripts' then
    v_size := octet_length(new.body);
  elsif tg_table_name = 'editor_revisions' then
    v_size := pg_column_size(new.document);
  else
    v_size := pg_column_size(new.body);
  end if;
  delete from public.write_budget_ledger
  where user_id = v_user and table_name = tg_table_name and created_at <= now() - interval '1 hour';
  select count(*), coalesce(sum(bytes), 0) into v_rows, v_bytes
  from public.write_budget_ledger where user_id = v_user and table_name = tg_table_name;
  if v_rows >= public.write_budget_rows(tg_table_name) or v_bytes + v_size > public.write_budget_bytes() then
    raise exception 'You have saved a lot of changes in the last hour. Wait a few minutes and try again.'
      using errcode = 'P0001';
  end if;
  insert into public.write_budget_ledger (user_id, table_name, bytes) values (v_user, tg_table_name, v_size);
  return new;
end;
$$;


--
-- Name: enqueue_cmo_run(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_cmo_run(p_kind text, p_input jsonb DEFAULT '{}'::jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Posting is ordered only by Schedule, for a slot whose card the founder approved.
  if p_kind = 'publish_post' then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  return public.cmo_enqueue(public.require_user(), p_kind, p_input);
end;
$$;


--
-- Name: enqueue_cmo_run_for(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_cmo_run_for(p_user uuid, p_kind text, p_input jsonb DEFAULT '{}'::jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_kind = 'publish_post' then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  return public.cmo_enqueue(p_user, p_kind, p_input);
end;
$$;


--
-- Name: enqueue_expired_object_paths(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_expired_object_paths(p_limit integer DEFAULT 200) RETURNS TABLE(id bigint, bucket text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_job uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Invalid cleanup batch size.' using errcode = '22023';
  end if;

  -- Job `queued/running` không nằm trong danh sách: worker có thể đang ghi vào
  -- đúng những object này. Job treo được reconciler chuyển sang `failed` trước,
  -- rồi mới tới lượt retention — không có đường tắt.
  for v_job in
    with due as (
      select j.id
      from public.jobs j
      where j.purging_at is null
        and j.expires_at < now()
        and j.status::text in ('done', 'failed', 'cancelled')
        and not exists (
          select 1
          from public.tasks t
          left join public.clips c on c.id = t.clip_id
          where (t.job_id = j.id or c.job_id = j.id)
            and t.status in ('queued', 'running')
        )
      order by j.expires_at, j.id
      limit p_limit
      for update skip locked
    ),
    marked as (
      update public.jobs j set purging_at = now()
      from due where j.id = due.id
      returning j.id
    )
    select marked.id from marked
  loop
    perform public.enqueue_job_objects(v_job);
  end loop;

  return query
    select d.id, d.bucket, d.path
    from public.storage_deletions d
    order by d.attempts, d.id
    limit p_limit;
end;
$$;


--
-- Name: enqueue_job_objects(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_job_objects(p_job_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;


--
-- Name: expired_clip_paths(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expired_clip_paths() RETURNS TABLE(job_id uuid, storage_path text, preview_path text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select c.job_id, c.storage_path, c.preview_path
  from public.clips c
  join public.jobs j on j.id = c.job_id
  where j.expires_at < now();
$$;


--
-- Name: expired_object_paths(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expired_object_paths(p_limit integer DEFAULT 200) RETURNS TABLE(id bigint, bucket text, path text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select * from public.expired_object_paths(p_limit, clock_timestamp()); $$;


--
-- Name: expired_object_paths(integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expired_object_paths(p_limit integer, p_started_at timestamp with time zone) RETURNS TABLE(id bigint, bucket text, path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_started_at is null then
    raise exception 'Invalid cleanup invocation.' using errcode = '22023';
  end if;
  perform public.enqueue_expired_object_paths(p_limit);
  return query select d.id, d.bucket, d.path from public.storage_deletions d
    where d.deferred_at is null or d.deferred_at < p_started_at
    order by d.attempts, d.id limit p_limit;
end;
$$;


--
-- Name: fail_task(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fail_task(p_task_id uuid, p_attempt_id uuid, p_error text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.tasks
  set status = 'failed',
      error = left(coalesce(p_error, 'Rendering failed. Please try again.'), 2000),
      finished_at = now(),
      lease_until = null
  where id = p_task_id and status = 'running'
    and attempt_id is not distinct from p_attempt_id;

  if found then
    return true;
  end if;

  return exists (
    select 1 from public.tasks
    where id = p_task_id and status = 'failed'
      and attempt_id is not distinct from p_attempt_id
  );
end;
$$;


--
-- Name: finalize_job_failure(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_job_failure(p_job_id uuid, p_attempt_id uuid, p_error text, p_operation_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
  v_prev jsonb;
  v_rows int;
  v_refund int := 0;
  v_result jsonb;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return jsonb_build_object('transitioned', false, 'refunded', 0);
  end if;

  perform public.lock_credit_owner(v_user);

  select result into v_prev
  from public.worker_operations where operation_key = p_operation_key;
  if found then
    return v_prev;
  end if;

  update public.jobs
  set status = 'failed',
      error = left(p_error, 2000),
      finished_at = now(),
      lease_until = null
  where id = p_job_id
    and status = 'running'
    and attempt_id is not distinct from p_attempt_id;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    v_refund := public.credit_refund(v_user, 'job', p_job_id, 'Refund: job failed', p_job_id);
  end if;

  v_result := jsonb_build_object('transitioned', v_rows > 0, 'refunded', v_refund);

  insert into public.worker_operations (operation_key, job_id, kind, result)
  values (p_operation_key, p_job_id, 'fail', v_result);

  return v_result;
end;
$$;


--
-- Name: finish_cmo_run(uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_cmo_run(p_id uuid, p_ok boolean, p_error text DEFAULT NULL::text) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_runs;
begin
  update public.cmo_runs
  set status = case when p_ok then 'done' else 'failed' end,
      error = case when p_ok then null else left(coalesce(p_error, 'Something went wrong.'), 500) end,
      finished_at = now()
  where id = p_id and user_id = v_user and status = 'running'
  returning * into v_row;
  if not found then
    raise exception 'This task has already finished.' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;


--
-- Name: freeze_clip_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.freeze_clip_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  -- Tiếng Anh: message của trigger đi thẳng qua PostgREST ra màn hình.
  raise exception 'Revisions cannot be changed.' using errcode = 'P0001';
end;
$$;


--
-- Name: generation_active_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generation_active_limit() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 24 $$;


--
-- Name: generation_quality_ok(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generation_quality_ok(p_quality jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select p_quality is not null
     and jsonb_typeof(p_quality) = 'object'
     and (select count(*) from jsonb_object_keys(p_quality)) = 1
     and p_quality->>'text' in ('none', 'minor', 'severe');
$$;


--
-- Name: get_or_create_editor_project(uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_editor_project(p_clip_id uuid, p_document jsonb, p_manifest jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_manifest jsonb := coalesce(p_manifest, '{"version":1,"folders":[],"assets":[]}'::jsonb);
begin
  if not public.editor_document_shape_ok(p_document) then
    raise exception 'This project could not be read.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'The project manifest must be an object.' using errcode = '22023';
  end if;
  if pg_column_size(v_manifest) >= 65536 then
    raise exception 'This project has too many assets to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  insert into public.editor_projects (clip_id, manifest, document, generated_document)
  values (p_clip_id, v_manifest, p_document, p_document)
  on conflict (clip_id) do nothing;

  return public.editor_json(p_clip_id);
end;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;


--
-- Name: heartbeat_job(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_job(p_job_id uuid, p_attempt_id uuid, p_lease_seconds integer DEFAULT 120) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with touched as (
    update public.jobs
    set heartbeat_at = now(),
        lease_until = now() + make_interval(secs => p_lease_seconds)
    where id = p_job_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;


--
-- Name: heartbeat_task(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_task(p_task_id uuid, p_attempt_id uuid, p_lease_seconds integer DEFAULT 120) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with touched as (
    update public.tasks
    set heartbeat_at = now(),
        lease_until = now() + make_interval(secs => p_lease_seconds)
    where id = p_task_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;


--
-- Name: inbox_claim(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inbox_claim(p_id uuid) RETURNS public.cmo_inbox
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_item public.cmo_inbox;
  v_run public.cmo_runs;
begin
  select * into v_item from public.cmo_inbox where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Inbox item not found.' using errcode = 'P0002';
  end if;
  -- A replay that ended without reporting back (claim_cmo_run gives up on a run that kept
  -- dying): the item would wait for it forever.
  if v_item.status = 'submitted' then
    select * into v_run from public.cmo_runs where id = v_item.run_id;
    if not found or v_run.status = 'failed' then
      update public.cmo_inbox
      set status = 'open', answers = answers - step, claimed_at = null,
          feedback = left(coalesce(v_run.error, 'The check stopped before it finished.') || ' Answer again.', 1000)
      where id = p_id returning * into v_item;
    elsif v_run.status = 'done' and not (v_run.output ? 'inbox_id') then
      update public.cmo_inbox set status = 'done', finished_at = now() where id = p_id returning * into v_item;
    end if;
  end if;
  if v_item.status in ('open', 'claimed') and v_item.expires_at <= now() then
    update public.cmo_inbox set status = 'expired', finished_at = now() where id = p_id returning * into v_item;
  elsif v_item.status in ('open', 'claimed') then
    update public.cmo_inbox set status = 'claimed', claimed_at = now() where id = p_id returning * into v_item;
  end if;
  return v_item;
end;
$$;


--
-- Name: inbox_list(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inbox_list() RETURNS TABLE(id uuid, kind text, step text, title text, status text, feedback text, rounds integer, created_at timestamp with time zone, expires_at timestamp with time zone, run_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select i.id, i.kind, i.step, left(i.request->>'title', 200),
         case when i.status in ('open', 'claimed') and i.expires_at <= now() then 'expired' else i.status end,
         i.feedback, i.rounds, i.created_at, i.expires_at, i.run_id
  from public.cmo_inbox i
  where i.user_id = public.require_user()
    and (i.status in ('open', 'claimed', 'submitted') or i.finished_at > now() - interval '1 day')
  order by i.created_at desc
  limit 50;
$$;


--
-- Name: inbox_submit(uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inbox_submit(p_id uuid, p_request_id uuid, p_step text, p_answer jsonb) RETURNS public.cmo_inbox
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_item public.cmo_inbox;
  v_run public.cmo_runs;
begin
  if p_request_id is null or p_answer is null or jsonb_typeof(p_answer) <> 'object' or octet_length(p_answer::text) > 131072 then
    raise exception 'This answer is not valid.' using errcode = '22023';
  end if;
  select * into v_item from public.cmo_inbox where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Inbox item not found.' using errcode = 'P0002';
  end if;
  if v_item.last_request_id = p_request_id then
    return v_item;
  end if;
  if v_item.status not in ('open', 'claimed') or v_item.expires_at <= now() then
    raise exception 'This inbox item is no longer waiting for an answer.' using errcode = 'P0001';
  end if;
  if v_item.step <> p_step then
    raise exception 'This inbox item now waits for step "%". Read it again.', v_item.step using errcode = 'P0001';
  end if;
  if v_item.rounds >= public.cmo_inbox_max_rounds() then
    raise exception 'This inbox item took too many answers. It will come back with the next schedule.' using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, status, input, credits)
  values (v_user, v_item.kind, 'queued', v_item.input || jsonb_build_object('brain', 'claude', 'inbox', v_item.id), 0)
  returning * into v_run;

  update public.cmo_inbox
  set answers = answers || jsonb_build_object(p_step, p_answer), status = 'submitted', submitted_at = now(),
      rounds = rounds + 1, last_request_id = p_request_id, feedback = null, run_id = v_run.id
  where id = p_id
  returning * into v_item;
  return v_item;
end;
$$;


--
-- Name: is_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_paid(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(
    (select p.plan in ('starter', 'creator')
       from public.profiles p
      where p.id = p_user
        and (auth.uid() is null or auth.uid() = p_user)),
    false);
$$;


--
-- Name: jcs(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jcs(p jsonb) RETURNS text
    LANGUAGE plpgsql STABLE STRICT
    SET search_path TO 'public'
    AS $$
begin
  case jsonb_typeof(p)
    when 'object' then
      return '{' || coalesce((
        select string_agg(to_jsonb(k)::text || ':' || public.jcs(v), ',' order by k collate "C")
        from jsonb_each(p) as e(k, v)), '') || '}';
    when 'array' then
      return '[' || coalesce((
        select string_agg(public.jcs(v), ',' order by i)
        from jsonb_array_elements(p) with ordinality as a(v, i)), '') || ']';
    else
      return p::text;
  end case;
end;
$$;


--
-- Name: job_credits_spent(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_credits_spent(p_job_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.credit_held('job', p_job_id);
$$;


--
-- Name: job_hold_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_hold_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 10 $$;


--
-- Name: list_projects(timestamp with time zone, uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_projects(p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 24) RETURNS SETOF public.jobs
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_limit int := least(greatest(coalesce(p_limit, 24), 1), 50);
  v_query text := nullif(trim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  if v_query is not null then
    -- `%` and `_` the user types are text, not wildcards. Escape `\` first, or the next two
    -- replacements escape the backslashes they just added.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select j.*
  from public.projects p
  join public.jobs j on j.id = p.job_id
  where p.user_id = v_user
    and p.kind = 'clip'
    and (
      p_cursor_created_at is null
      or p_cursor_id is null
      or (j.created_at, j.id) < (p_cursor_created_at, p_cursor_id)
    )
    and (
      v_pattern is null
      or coalesce(j.name, '') ilike v_pattern escape '\'
      or coalesce(j.title, '') ilike v_pattern escape '\'
    )
  order by j.created_at desc, j.id desc
  limit v_limit;
end;
$$;


--
-- Name: live_source_paths(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.live_source_paths() RETURNS TABLE(path text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select substring(j.source_url from 11)
  from public.jobs j
  where j.source_url like 'storage://%'
    and (
      j.status in ('queued', 'running')
      or (j.status in ('failed', 'done') and j.expires_at > now())
    );
$$;


--
-- Name: lock_credit_owner(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_credit_owner(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform 1 from public.profiles where id = p_user_id for update;
end;
$$;


--
-- Name: look_check_begin(uuid, text, uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.look_check_begin(p_user uuid, p_ref_kind text, p_ref_id uuid, p_order uuid, p_doc_key text, p_files jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: look_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.look_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    ref_kind text NOT NULL,
    ref_id uuid NOT NULL,
    order_id uuid,
    round smallint NOT NULL,
    doc_key text NOT NULL,
    task_id uuid,
    status text DEFAULT 'checking'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    claimed_at timestamp with time zone,
    raised_at timestamp with time zone,
    CONSTRAINT look_checks_doc_key_check CHECK ((char_length(doc_key) <= 100)),
    CONSTRAINT look_checks_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['editor_project'::text, 'short_batch'::text, 'studio_step'::text]))),
    CONSTRAINT look_checks_result_check CHECK (((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 65536)))),
    CONSTRAINT look_checks_round_check CHECK ((round = ANY (ARRAY[0, 1]))),
    CONSTRAINT look_checks_status_check CHECK ((status = ANY (ARRAY['checking'::text, 'passed'::text, 'failed'::text, 'sent_back'::text, 'claimed'::text, 'error'::text, 'superseded'::text])))
);


--
-- Name: look_check_raise(public.look_checks); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.look_check_raise(p_check public.look_checks) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: look_check_raise_safe(public.look_checks); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.look_check_raise_safe(p_check public.look_checks) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.look_check_raise(p_check);
  return true;
exception when others then
  raise warning 'look check % could not raise its card: %', p_check.id, sqlerrm;
  return false;
end;
$$;


--
-- Name: mark_finished(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_finished(p_clip_id uuid, p_document_hash text) RETURNS public.editor_projects
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
  v_order uuid;
begin
  perform public.owned_clip(p_clip_id, v_user);
  select * into v_row from public.editor_projects where clip_id = p_clip_id for update;
  if not found then
    raise exception 'This edit has nothing to finish yet.' using errcode = 'P0002';
  end if;
  if p_document_hash is null or p_document_hash is distinct from public.editor_document_hash(v_row.document) then
    raise exception 'This edit changed. Look at it again before marking it finished.' using errcode = 'P0001';
  end if;
  if v_row.finished_hash is distinct from p_document_hash then
    update public.editor_projects set finished_at = now(), finished_hash = p_document_hash
    where clip_id = p_clip_id
    returning * into v_row;
  end if;
  -- Marking it finished in the editor or Studio is the same decision as approving card 3, in either order: the card
  -- closes, and a video order making this edit is done with the edit as its deliverable.
  perform public.approval_close('editor_project', p_clip_id, 'approved');
  -- Only a built video finishes its order (the order reached its render); before that a waiting card 2 still runs.
  select s.order_id into v_order from public.studio_steps s join public.work_orders o on o.id = s.order_id
  where s.clip_id = p_clip_id and o.kind = 'build_video' and o.status not in ('done', 'failed', 'cancelled')
    and s.next->>'tool' = 'render'
  order by s.created_at desc limit 1;
  if v_order is not null then
    insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status)
    values (v_user, v_order, 'video', 'clip', p_clip_id, 'decided')
    on conflict (ref_kind, ref_id) do nothing;
    perform public.work_order_move(v_order, 'done', 'Finished “' || coalesce(nullif((select hook from public.clips where id = p_clip_id), ''), 'the video') || '”');
  end if;
  return v_row;
end;
$$;


--
-- Name: mark_generation_sent(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_generation_sent(p_task_id uuid, p_attempt_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_rows int;
begin
  -- Locks the task first, as the cancel path does, so a cancel either lands before (false: the worker
  -- stops without paying) or after (the credits stay spent).
  perform 1 from public.tasks
  where id = p_task_id and kind = 'generate' and status = 'running' and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then return false; end if;
  update public.generations set sent_at = coalesce(sent_at, now())
  where task_id = p_task_id and status = 'running';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;


--
-- Name: mcp_admit(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_admit(p_count integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_window_start timestamptz;
  v_count int;
begin
  if p_count is null or p_count < 1 or p_count > 20 then
    raise exception 'Send 1 to 20 messages per request.' using errcode = '22023';
  end if;
  -- Before counting: a free account's refused requests must not fill a bucket it cannot use.
  if not public.is_paid(v_user) then
    return 'free_plan';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
  insert into public.rate_limits (user_id, bucket, window_start, count)
  values (v_user, 'mcp', v_window_start, p_count)
  on conflict (user_id, bucket, window_start)
  do update set count = public.rate_limits.count + p_count
  returning count into v_count;

  return case when v_count <= 600 then 'ok' else 'rate_limited' end;
end;
$$;


--
-- Name: mcp_confirm_use(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_confirm_use(p_nonce uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_count int;
begin
  if p_nonce is null then
    raise exception 'That confirm code is not valid. Ask for the price again.' using errcode = '22023';
  end if;
  delete from public.mcp_confirms where user_id = v_user and used_at < now() - interval '1 day';
  if (select count(*) from public.mcp_confirms where user_id = v_user and used_at > now() - interval '1 hour') >= 600 then
    raise exception 'Too many confirm codes in the last hour. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.mcp_confirms (user_id, nonce) values (v_user, p_nonce) on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;


--
-- Name: mcp_grant_record(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_grant_record(p_client_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  if p_client_id is null or char_length(p_client_id) not between 1 and 200 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;
  -- The consent route checks this too; here it holds for any caller.
  if not public.is_paid(v_user) then
    raise exception 'Connecting apps to OpenCMO is part of the paid plans.' using errcode = 'P0001';
  end if;
  insert into public.mcp_grants (user_id, client_id) values (v_user, p_client_id)
  on conflict (user_id, client_id) do update set created_at = now(), revoked_at = null;
end;
$$;


--
-- Name: mcp_grant_revoke(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mcp_grant_revoke(p_client_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  update public.mcp_grants set revoked_at = now()
  where user_id = v_user and client_id = p_client_id and revoked_at is null;
end;
$$;


--
-- Name: nonneg(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nonneg(p bigint) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select case when p is null then null else greatest(0, p) end $$;


--
-- Name: normalize_capture_url(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_capture_url(p_url text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_parts text[];
  v_scheme text;
  v_authority text;
  v_rest text;
  v_host text;
  v_port text;
  v_ip inet;
begin
  if v_url = '' then
    raise exception 'Give the address of the page to capture.' using errcode = '22023';
  end if;
  if char_length(v_url) > 2048 then
    raise exception 'That address is too long.' using errcode = '22023';
  end if;
  if v_url ~ '[[:space:][:cntrl:]]' then
    raise exception 'That address is not allowed.' using errcode = '22023';
  end if;
  v_parts := regexp_match(v_url, '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^#]*)');
  if v_parts is null or lower(v_parts[1]) not in ('http', 'https') then
    raise exception 'Only http and https pages can be captured.' using errcode = '22023';
  end if;
  v_scheme := lower(v_parts[1]);
  v_authority := lower(v_parts[2]);
  v_rest := coalesce(nullif(v_parts[3], ''), '/');
  if v_rest !~ '^[/?]' then
    v_rest := '/' || v_rest;
  end if;
  -- No credentials in the address, no IPv6 literals (a public page has a name).
  if v_authority = '' or position('@' in v_authority) > 0 or position('[' in v_authority) > 0 then
    raise exception 'That address is not allowed.' using errcode = '22023';
  end if;
  v_host := split_part(v_authority, ':', 1);
  v_port := nullif(substr(v_authority, char_length(v_host) + 2), '');
  if v_port is not null and v_port <> (case when v_scheme = 'http' then '80' else '443' end) then
    raise exception 'That address is not allowed.' using errcode = '22023';
  end if;
  v_host := rtrim(v_host, '.');
  if v_host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' then
    begin
      v_ip := v_host::inet;
    exception when others then
      raise exception 'That address is not allowed.' using errcode = '22023';
    end;
    if v_ip << '0.0.0.0/8' or v_ip << '10.0.0.0/8' or v_ip << '100.64.0.0/10' or v_ip << '127.0.0.0/8'
       or v_ip << '169.254.0.0/16' or v_ip << '172.16.0.0/12' or v_ip << '192.0.0.0/24'
       or v_ip << '192.0.2.0/24' or v_ip << '192.168.0.0/16' or v_ip << '198.18.0.0/15'
       or v_ip << '198.51.100.0/24' or v_ip << '203.0.113.0/24' or v_ip << '224.0.0.0/3' then
      raise exception 'That address is not allowed.' using errcode = '22023';
    end if;
  -- A name with a dot and a real top-level label: no `localhost`, no single-label intranet names,
  -- no numeric tricks like `0x7f.1` that browsers read as an IP address.
  elsif v_host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or v_host ~ '(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|onion|test|invalid|example)$' then
    raise exception 'That address is not allowed.' using errcode = '22023';
  end if;
  return v_scheme || '://' || v_host || v_rest;
end;
$_$;


--
-- Name: notify_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notify_settings (
    user_id uuid NOT NULL,
    email_digest boolean DEFAULT true NOT NULL,
    push boolean DEFAULT true NOT NULL,
    unsubscribe_token uuid DEFAULT gen_random_uuid() NOT NULL,
    unsubscribed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notify_settings_for(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_settings_for(p_user uuid) RETURNS public.notify_settings
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.notify_settings;
begin
  insert into public.notify_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into v_row from public.notify_settings where user_id = p_user;
  return v_row;
end;
$$;


--
-- Name: notify_settings_save(boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_settings_save(p_email_digest boolean, p_push boolean) RETURNS public.notify_settings
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.notify_settings;
begin
  if p_email_digest is null or p_push is null then
    raise exception 'Choose on or off for email and push.' using errcode = '22023';
  end if;
  insert into public.notify_settings (user_id, email_digest, push, unsubscribed_at, updated_at)
  values (v_user, p_email_digest, p_push, case when not p_email_digest then now() end, now())
  on conflict (user_id) do update
    set email_digest = excluded.email_digest, push = excluded.push,
        unsubscribed_at = case when excluded.email_digest then null else coalesce(notify_settings.unsubscribed_at, now()) end,
        updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: opportunity_reply_url(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.opportunity_reply_url(p_id uuid, p_url text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_opp public.opportunities;
  v_url text := trim(coalesce(p_url, ''));
  v_base text;
begin
  select * into v_opp from public.opportunities where id = p_id and user_id = v_user and status = 'replied';
  if not found then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  v_base := regexp_replace(v_opp.url, '^https://(www\.|old\.)?reddit\.com', '');
  if char_length(v_url) > 500
     or not ((v_opp.platform = 'hn' and v_url ~ '^https://news\.ycombinator\.com/item\?id=[0-9]{1,12}$')
          or (v_opp.platform = 'reddit' and v_url ~ '^https://(www\.|old\.)?reddit\.com/r/'
              and position(rtrim(v_base, '/') || '/' in regexp_replace(v_url, '^https://(www\.|old\.)?reddit\.com', '')) = 1)) then
    raise exception 'Paste the link to your reply in this thread.' using errcode = '22023';
  end if;
  update public.cmo_draft_outcomes set outcome_url = v_url
  where user_id = v_user and department = 'sales' and item_id = p_id and action = 'replied';
end;
$_$;


--
-- Name: orphan_keep_paths(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orphan_keep_paths(p_bucket text) RETURNS TABLE(path text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select r.object_name
    from public.upload_reservations r
   where r.bucket = p_bucket and r.expires_at > now() - interval '1 day'
  union
  select s.path from public.live_source_paths() s where p_bucket = 'sources'
  union
  select substring(m.storage_path from 7)
    from public.media_assets m
   where p_bucket = 'media' and m.storage_path like 'media/%';
$$;


--
-- Name: orphan_safe_paths(text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orphan_safe_paths(p_bucket text, p_paths text[]) RETURNS TABLE(path text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
begin
  if p_bucket not in ('sources', 'media') or p_bucket is null
     or p_paths is null or cardinality(p_paths) > 100 then
    raise exception 'Invalid orphan candidates.' using errcode = '22023';
  end if;
  return query
    select distinct candidate.path from unnest(p_paths) candidate(path)
    where candidate.path is not null
      and not exists (select 1 from public.orphan_keep_paths(p_bucket) k where k.path = candidate.path)
      -- Cả job đã hết hạn nhưng đang đợi task cũng cần nguồn; manifest xử lý sau.
      and not exists (select 1 from public.jobs j
        where p_bucket = 'sources' and j.source_url = 'storage://' || candidate.path)
      -- Giữ bảo thủ khi manifest nhắc cùng object ở bucket khác; không bao giờ
      -- coi đường dẫn có tham chiếu là orphan chỉ vì field bucket còn thiếu.
      and not exists (select 1 from public.jobs j where jsonb_path_exists(
        j.media_manifest, '$.**.object ? (@ == $path)', jsonb_build_object('path',candidate.path)))
      and not exists (select 1 from public.tasks t where jsonb_path_exists(
        t.output, '$.**.object ? (@ == $path)', jsonb_build_object('path',candidate.path)));
end;
$_$;


--
-- Name: orphan_scan_page(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orphan_scan_page(p_bucket text, p_limit integer DEFAULT 100) RETURNS TABLE(path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare v_after text; v_paths text[];
begin
  if p_bucket is null or p_bucket not in ('sources','media') or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid orphan scan.' using errcode = '22023';
  end if;
  insert into public.orphan_scan_cursors(bucket) values(p_bucket) on conflict do nothing;
  select c.after_path into v_after from public.orphan_scan_cursors c where c.bucket = p_bucket for update;
  select array_agg(candidate.name order by candidate.name) into v_paths from (
    select o.name from storage.objects o
    where o.bucket_id = p_bucket and o.name > v_after
      -- Khớp hợp đồng reserve_upload: nguồn <uid>/<file>, B-roll
      -- <uid>/<project>/<file>. Artifact lồng sâu vẫn do manifest xử lý.
      and ((p_bucket = 'sources' and o.name ~ '^[^/]+/[^/]+$')
        or (p_bucket = 'media' and o.name ~ '^[^/]+/[^/]+/[^/]+$'))
      and o.created_at < now() - interval '6 hours'
    order by o.name limit p_limit
  ) candidate;
  update public.orphan_scan_cursors set after_path = coalesce(v_paths[cardinality(v_paths)], '')
    where bucket = p_bucket;
  return query select unnest(v_paths);
end;
$_$;


--
-- Name: clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    idx integer NOT NULL,
    hook text,
    start_seconds numeric NOT NULL,
    end_seconds numeric NOT NULL,
    score numeric,
    reason text,
    storage_path text,
    preview_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_start numeric,
    source_end numeric,
    kind text DEFAULT 'full'::text NOT NULL,
    settings jsonb,
    settings_hash text,
    parent_clip_id uuid,
    CONSTRAINT clips_kind_check CHECK ((kind = ANY (ARRAY['full'::text, 'blank'::text, 'short'::text, 'slideshow'::text]))),
    CONSTRAINT clips_parent_short_check CHECK (((parent_clip_id IS NULL) OR (kind = 'short'::text))),
    CONSTRAINT clips_settings_hash_check CHECK ((((settings IS NULL) AND (settings_hash IS NULL)) OR ((jsonb_typeof(settings) = 'object'::text) AND COALESCE((settings_hash ~ '^[0-9a-f]{64}$'::text), false)))),
    CONSTRAINT clips_settings_size_check CHECK (((settings IS NULL) OR (pg_column_size(settings) < 65536))),
    CONSTRAINT clips_source_range_check CHECK ((source_end > source_start))
);


--
-- Name: owned_clip(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.owned_clip(p_clip_id uuid, p_user uuid) RETURNS public.clips
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_clip public.clips;
begin
  select c.* into v_clip
  from public.clips c
  join public.jobs j on j.id = c.job_id
  where c.id = p_clip_id and j.user_id = p_user and j.purging_at is null;

  if not found then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;
  return v_clip;
end;
$$;


--
-- Name: plan_quota(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plan_quota(p_plan text) RETURNS TABLE(previews_per_day integer, exports_per_day integer)
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select
    case coalesce(p_plan, 'free')
      when 'creator' then 300
      when 'starter' then 100
      else 20
    end,
    case coalesce(p_plan, 'free')
      when 'creator' then 100
      when 'starter' then 30
      else 5
    end;
$$;


--
-- Name: plan_usage_limits(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plan_usage_limits(p_plan text) RETURNS TABLE(preview_daily integer, export_daily integer, stored_bytes bigint, stored_objects integer)
    LANGUAGE sql IMMUTABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case coalesce(p_plan, 'free')
    when 'creator' then 300 when 'starter' then 100 else 20 end,
  case coalesce(p_plan, 'free')
    when 'creator' then 100 when 'starter' then 30 else 5 end,
  case coalesce(p_plan, 'free')
    when 'creator' then 26843545600::bigint when 'starter' then 10737418240::bigint else 2147483648::bigint end,
  case coalesce(p_plan, 'free')
    when 'creator' then 2500 when 'starter' then 1000 else 200 end;
$$;


--
-- Name: platform_profile(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.platform_profile(p_id text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_id
    when 'x' then '{"kind": "post", "limit": 280, "title": null, "hashtags": 0, "label": "X"}'::jsonb
    when 'threads' then '{"kind": "post", "limit": 500, "title": null, "hashtags": 0, "label": "Threads"}'::jsonb
    when 'linkedin' then '{"kind": "post", "limit": 3000, "title": null, "hashtags": 0, "label": "LinkedIn"}'::jsonb
    when 'instagram_caption' then '{"kind": "caption", "limit": 2200, "title": null, "hashtags": 5, "label": "Instagram caption"}'::jsonb
    when 'tiktok_caption' then '{"kind": "caption", "limit": 2200, "title": null, "hashtags": 5, "label": "TikTok caption"}'::jsonb
    when 'youtube' then '{"kind": "youtube", "limit": 5000, "title": 100, "hashtags": 3, "label": "YouTube title and description"}'::jsonb
  end
$$;


--
-- Name: platform_profile_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.platform_profile_id(p_label text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case lower(trim(coalesce(p_label, '')))
    when 'x' then 'x'
    when 'twitter' then 'x'
    when 'threads' then 'threads'
    when 'linkedin' then 'linkedin'
    when 'instagram' then 'instagram_caption'
    when 'instagram_caption' then 'instagram_caption'
    when 'reels' then 'instagram_caption'
    when 'tiktok' then 'tiktok_caption'
    when 'tiktok_caption' then 'tiktok_caption'
    when 'youtube' then 'youtube'
    when 'shorts' then 'youtube'
    when 'youtube shorts' then 'youtube'
    else null end
$$;


--
-- Name: process_polar_event(text, text, timestamp with time zone, jsonb, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_polar_event(p_event_id text, p_event_type text, p_event_at timestamp with time zone, p_data jsonb, p_purchase_plan text, p_credits integer, p_entitlement_plan text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
 v_customer text := coalesce(nullif(p_data->>'customer_id',''),nullif(p_data#>>'{customer,id}',''));
 v_email text := coalesce(p_data#>>'{customer,email}',p_data#>>'{user,email}',p_data->>'customer_email');
 -- `customer_external_id` do link checkout của ta gắn vào (`app/app/billing`).
 -- Nó là `profiles.id`, nên khớp bằng nó là khớp CHẮC; email chỉ là đường lùi
 -- cho những lần mua không đi qua link của ta.
 v_external text := coalesce(
   nullif(p_data#>>'{customer,external_id}',''),
   nullif(p_data->>'customer_external_id',''),
   nullif(p_data#>>'{customer,metadata,user_id}','')
 );
 v_external_user uuid;
 v_id text := nullif(p_data->>'id','');
 v_user uuid; v_link text; v_result jsonb; v_purchase public.polar_purchases%rowtype;
 v_sub jsonb; v_sub_id text; v_status text; v_version timestamptz; v_priority integer;
 v_granted integer := 0; v_rows integer; v_plan text;
begin
 if v_customer is null and nullif(v_email,'') is null and v_external is null then
  return jsonb_build_object('ok',true,'skipped','no email on event');
 end if;
 if p_event_id is null or p_event_id='' or p_event_at is null or v_id is null or v_customer is null then
  raise exception 'Invalid billing event.' using errcode='22023';
 end if;
 if p_event_type not in ('order.paid','order.refunded','subscription.active','subscription.canceled','subscription.revoked','subscription.past_due') then
  return jsonb_build_object('ok',true,'ignored',p_event_type);
 end if;
 if nullif(p_data#>>'{customer,id}','') is not null and p_data#>>'{customer,id}'<>v_customer then
  raise exception 'Conflicting billing customer.' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('polar:event:'||p_event_id,0));
 select result into v_result from public.polar_webhook_receipts where event_id=p_event_id;
 if found then return v_result || jsonb_build_object('duplicate',true,'credits',0); end if;
 perform pg_advisory_xact_lock(hashtextextended('polar:customer:'||v_customer,0));
 select user_id into v_user from public.polar_customers where customer_id=v_customer;
 if found then
  if v_user is null then return jsonb_build_object('ok',true,'skipped','account no longer exists'); end if;
  perform 1 from public.profiles where id=v_user for update;
  if not found then return jsonb_build_object('ok',true,'skipped','account no longer exists'); end if;
 else
  -- Khớp bằng external_id TRƯỚC. Email là chuỗi người mua tự gõ ở trang Polar;
  -- gõ khác email đăng nhập là tiền vào mà credit không bao giờ cộng, và route
  -- trả 200 nên Polar không gửi lại. `external_id` do ta gắn vào link checkout
  -- nên không có chỗ cho người dùng gõ sai.
  --
  -- Ép kiểu có canh regex: `external_id` là chuỗi tuỳ ý bên Polar, và một giá
  -- trị không phải uuid sẽ ném lỗi 22P02 — tức 500 và Polar retry vĩnh viễn.
  if v_external is not null
     and v_external ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
   select id,polar_customer_id into v_external_user,v_link
   from public.profiles where id=v_external::uuid for update;
   if found then v_user := v_external_user; end if;
  end if;

  if v_user is null then
   if nullif(v_email,'') is null then return jsonb_build_object('ok',true,'skipped','no email on event'); end if;
   if (select count(*) from public.profiles where lower(email)=lower(v_email))<>1 then
    return jsonb_build_object('ok',true,'skipped','no matching account');
   end if;
   select id,polar_customer_id into v_user,v_link from public.profiles where lower(email)=lower(v_email) for update;
  end if;

  if v_link is not null and v_link<>v_customer then
   -- A second Polar customer for the same account. Matched by email it proves nothing: skip. Matched by
   -- the external id our checkout link set, the payment is the account's: credit it, keep the first link.
   if v_external_user is null then return jsonb_build_object('ok',true,'skipped','account already linked'); end if;
   raise warning 'polar: order % for user % comes from customer %, account is linked to %', v_id, v_user, v_customer, v_link;
   -- Map the second customer too: its later events (a refund, a cancelled subscription) may carry no
   -- external id, and the email path would skip them as "account already linked".
   insert into public.polar_customers(customer_id,user_id) values(v_customer,v_user) on conflict (customer_id) do nothing;
  else
   update public.profiles set polar_customer_id=v_customer where id=v_user;
   insert into public.polar_customers(customer_id,user_id) values(v_customer,v_user);
  end if;
 end if;
 if p_event_type in ('order.paid','order.refunded') then
  insert into public.polar_purchases(order_id,customer_id,user_id,product_id,total_amount,currency)
  values(v_id,v_customer,v_user,p_data->>'product_id',coalesce((p_data->>'total_amount')::bigint,0),p_data->>'currency') on conflict(order_id) do nothing;
  select * into v_purchase from public.polar_purchases where order_id=v_id for update;
  if v_purchase.customer_id<>v_customer or v_purchase.user_id is distinct from v_user then
   raise exception 'Purchase belongs to another account.' using errcode='22023';
  end if;
  if p_event_type='order.paid' then
   if p_purchase_plan is null or p_purchase_plan not in ('starter','creator') or p_credits is null or p_credits<=0 then
    raise exception 'Invalid paid product.' using errcode='22023';
   end if;
   if not v_purchase.granted then
    if exists(select 1 from public.credit_ledger where external_id='polar:'||v_id and user_id is distinct from v_user) then
     raise exception 'Purchase belongs to another account.' using errcode='22023';
    end if;
    insert into public.credit_ledger(user_id,delta,reason,external_id) values(v_user,p_credits,p_purchase_plan||' plan purchase','polar:'||v_id)
    on conflict(external_id) where external_id is not null do nothing;
    get diagnostics v_rows=row_count;
    if v_rows=1 then v_granted:=p_credits; end if;
    update public.polar_purchases set granted=true,credits=p_credits,plan=p_purchase_plan,paid_at=p_event_at where order_id=v_id;
   end if;
   v_sub:=p_data->'subscription'; v_sub_id:=nullif(v_sub->>'id',''); v_status:=v_sub->>'status';
   v_version:=coalesce((v_sub->>'modified_at')::timestamptz,(v_sub->>'created_at')::timestamptz,p_event_at);
  else
   if coalesce((p_data->>'refunded_amount')::bigint,0)<0 or coalesce((p_data->>'refunded_tax_amount')::bigint,0)<0 then
    raise exception 'Invalid refund amount.' using errcode='22023';
   end if;
   update public.polar_purchases set
    refunded_amount=greatest(refunded_amount,coalesce((p_data->>'refunded_amount')::bigint,0)),
    refunded_tax_amount=greatest(refunded_tax_amount,coalesce((p_data->>'refunded_tax_amount')::bigint,0)),
    refunded_at=greatest(refunded_at,p_event_at) where order_id=v_id;
  end if;
 else
  v_sub:=p_data; v_sub_id:=v_id; v_status:=substr(p_event_type,length('subscription.')+1);
  v_version:=coalesce((p_data->>'modified_at')::timestamptz,p_event_at);
 end if;
 if v_sub_id is not null and v_status in ('active','past_due','canceled','revoked')
  and (p_event_type<>'order.paid' or p_entitlement_plan is not null) then
  v_priority:=case v_status when 'active' then 0 when 'past_due' then 1 when 'canceled' then 2 else 3 end;
  perform pg_advisory_xact_lock(hashtextextended('polar:subscription:'||v_sub_id,0));
  if exists(select 1 from public.polar_subscriptions where subscription_id=v_sub_id and (customer_id<>v_customer or user_id is distinct from v_user)) then
   raise exception 'Subscription belongs to another account.' using errcode='22023';
  end if;
  select plan into v_plan from public.polar_subscriptions where subscription_id=v_sub_id;
  v_plan:=coalesce(p_entitlement_plan,v_plan);
  -- A retired product with no stored subscription has no entitlement to change.
  -- This branch is unreachable for paid orders because their plan is validated above.
  if v_plan is null then return jsonb_build_object('ok',true,'skipped','unmapped subscription product'); end if;
  if v_plan not in ('starter','creator') then raise exception 'Invalid subscription product.' using errcode='22023'; end if;
  insert into public.polar_subscriptions(subscription_id,customer_id,user_id,plan,status,current_period_end,provider_updated_at,status_priority,event_id)
  values(v_sub_id,v_customer,v_user,v_plan,v_status,(v_sub->>'current_period_end')::timestamptz,v_version,v_priority,p_event_id)
  on conflict(subscription_id) do update set plan=excluded.plan,status=excluded.status,
   current_period_end=coalesce(excluded.current_period_end,polar_subscriptions.current_period_end),
   provider_updated_at=excluded.provider_updated_at,status_priority=excluded.status_priority,event_id=excluded.event_id
  where (excluded.provider_updated_at,excluded.status_priority)>(polar_subscriptions.provider_updated_at,polar_subscriptions.status_priority)
   and polar_subscriptions.customer_id=excluded.customer_id and polar_subscriptions.user_id=excluded.user_id;
  select plan into v_plan from public.polar_subscriptions where user_id=v_user and status<>'revoked'
  order by case plan when 'creator' then 2 else 1 end desc limit 1;
  update public.profiles set plan=coalesce(v_plan,'free') where id=v_user;
 end if;
 v_result:=jsonb_build_object('ok',true,'credits',v_granted);
 insert into public.polar_webhook_receipts(event_id,event_type,occurred_at,user_id,result) values(p_event_id,p_event_type,p_event_at,v_user,v_result);
 return v_result;
end;
$_$;


--
-- Name: product_mentioned(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.product_mentioned(p_user uuid, p_text text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_name text;
begin
  select nullif(trim(body->>'name'), '') into v_name from public.marketing_documents
  where user_id = p_user and kind = 'product' order by version desc, created_at desc limit 1;
  if v_name is null or char_length(v_name) < 3 or p_text is null then
    return false;
  end if;
  return p_text ~* ('(^|[^[:alnum:]])' || regexp_replace(v_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '($|[^[:alnum:]])');
end;
$_$;


--
-- Name: project_from_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.project_from_job() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.projects (user_id, job_id, kind, created_at)
  values (new.user_id, new.id, case when new.kind = 'edit' then 'edit' else 'clip' end, new.created_at)
  on conflict (job_id) do nothing;
  return new;
end;
$$;


--
-- Name: publish_media_queue(uuid, uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_media_queue(p_slot uuid, p_user uuid, p_order uuid, p_object text, p_upload_url text, p_public_url text) RETURNS uuid
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


--
-- Name: schedule_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_slots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    deliverable_id uuid NOT NULL,
    platform text NOT NULL,
    account_id uuid,
    mode text DEFAULT 'publish'::text NOT NULL,
    publish_at timestamp with time zone NOT NULL,
    jitter_seconds integer DEFAULT 0 NOT NULL,
    window_ends_at timestamp with time zone NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    approval_id uuid,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text DEFAULT (gen_random_uuid())::text NOT NULL,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    external_id text,
    external_url text,
    error jsonb,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    media_task_id uuid,
    CONSTRAINT schedule_slots_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT schedule_slots_check CHECK ((window_ends_at > publish_at)),
    CONSTRAINT schedule_slots_error_check CHECK (((error IS NULL) OR ((jsonb_typeof(error) = 'object'::text) AND (error ? 'message'::text) AND (octet_length((error)::text) <= 2048)))),
    CONSTRAINT schedule_slots_external_id_check CHECK ((char_length(external_id) <= 200)),
    CONSTRAINT schedule_slots_external_url_check CHECK (((external_url ~ '^https://'::text) AND (char_length(external_url) <= 1000))),
    CONSTRAINT schedule_slots_jitter_seconds_check CHECK (((jitter_seconds >= '-240'::integer) AND (jitter_seconds <= 240))),
    CONSTRAINT schedule_slots_mode_check CHECK ((mode = ANY (ARRAY['publish'::text, 'intent'::text]))),
    CONSTRAINT schedule_slots_options_check CHECK (((jsonb_typeof(options) = 'object'::text) AND (octet_length((options)::text) <= 1024))),
    CONSTRAINT schedule_slots_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'threads'::text, 'linkedin'::text, 'tiktok'::text, 'youtube'::text, 'instagram'::text]))),
    CONSTRAINT schedule_slots_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'waiting'::text, 'due'::text, 'reminded'::text, 'publishing'::text, 'published'::text, 'missed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: publish_slot_guard(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_slot_guard(p_slot uuid, p_user uuid, p_order uuid) RETURNS public.schedule_slots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_slot public.schedule_slots;
begin
  select * into v_slot from public.schedule_slots where id = p_slot and user_id = p_user for update;
  if not found or not exists (select 1 from public.work_orders
      where id = p_order and user_id = p_user and kind = 'publish_post' and brief->>'slot_id' = p_slot::text) then
    raise exception 'Slot not found.' using errcode = 'P0002';
  end if;
  return v_slot;
end;
$$;


--
-- Name: publish_slot_read(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_slot_read(p_slot uuid, p_user uuid, p_order uuid) RETURNS jsonb
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


--
-- Name: publish_slot_start(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_slot_start(p_slot uuid, p_user uuid, p_order uuid) RETURNS public.schedule_slots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_slot public.schedule_slots := public.publish_slot_guard(p_slot, p_user, p_order);
begin
  if v_slot.status = 'publishing' then
    return v_slot;
  end if;
  if v_slot.status <> 'due' then
    raise exception 'This post is not due (it is %).', v_slot.status using errcode = 'P0001';
  end if;
  if now() >= v_slot.window_ends_at then
    raise exception 'This post missed its time window.' using errcode = 'P0001';
  end if;
  if public.cmo_paused(v_slot.user_id) then
    raise exception 'Your CMO is paused.' using errcode = 'P0001';
  end if;
  if not public.schedule_approval_holds(v_slot) then
    raise exception 'This post changed after it was approved.' using errcode = 'P0001';
  end if;
  -- A new attempt uploads again: the export of what is approved now, never an earlier attempt's file.
  update public.schedule_slots set status = 'publishing', attempts = attempts + 1, media_task_id = null, updated_at = now()
  where id = v_slot.id returning * into v_slot;
  return v_slot;
end;
$$;


--
-- Name: publish_status(uuid, text, text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_status(p_slot uuid, p_status text, p_external_id text DEFAULT NULL::text, p_url text DEFAULT NULL::text, p_error jsonb DEFAULT NULL::jsonb, p_zernio_account_id text DEFAULT NULL::text) RETURNS public.schedule_slots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_slot public.schedule_slots;
  v_d public.deliverables;
  v_url text := case when p_url ~ '^https://' and char_length(p_url) <= 500 then p_url end;
begin
  if char_length(p_external_id) > 200 then
    raise exception 'The post id is too long.' using errcode = '22023';
  end if;
  if p_slot is not null then
    select * into v_slot from public.schedule_slots where id = p_slot for update;
  elsif nullif(trim(coalesce(p_external_id, '')), '') is not null then
    select * into v_slot from public.schedule_slots where external_id = p_external_id order by updated_at desc limit 1 for update;
  end if;
  if v_slot.id is null then
    raise exception 'Slot not found.' using errcode = 'P0002';
  end if;
  if p_zernio_account_id is not null and not exists (select 1 from public.social_accounts
      where id = v_slot.account_id and zernio_account_id = p_zernio_account_id) then
    raise exception 'That post is not on this account.' using errcode = 'P0001';
  end if;
  if v_slot.status in ('published', 'cancelled') then
    return v_slot;
  end if;
  case p_status
    when 'publishing', 'accepted' then
      if v_slot.status in ('due', 'publishing') then
        update public.schedule_slots set status = 'publishing', external_id = coalesce(p_external_id, external_id),
          updated_at = now()
        where id = v_slot.id returning * into v_slot;
      end if;
    when 'published' then
      update public.schedule_slots
      set status = 'published', external_id = coalesce(p_external_id, external_id),
          external_url = coalesce(v_url, external_url), published_at = now(), lease_until = null, updated_at = now()
      where id = v_slot.id returning * into v_slot;
      -- Live: a Retry card left from an earlier failure is done with.
      perform public.approval_close('schedule_slot', v_slot.id, 'approved');
      select * into v_d from public.deliverables where id = v_slot.deliverable_id;
      if v_d.ref_kind = 'content_item' then
        update public.content_items set status = 'published', published_at = coalesce(published_at, now()),
          external_url = coalesce(v_url, external_url), updated_at = now()
        where id = v_d.ref_id and status <> 'published';
      end if;
    when 'failed' then
      if v_slot.status <> 'failed' then
        if p_error is null or jsonb_typeof(p_error) <> 'object' or jsonb_typeof(p_error->'message') <> 'string' then
          raise exception 'Say why it failed.' using errcode = '22023';
        end if;
        update public.schedule_slots
        set status = 'failed', lease_until = null, updated_at = now(),
            error = jsonb_build_object('code', left(coalesce(p_error->>'code', 'failed'), 40),
              'message', left(p_error->>'message', 500), 'retryable', coalesce(p_error->'retryable', 'true'::jsonb))
        where id = v_slot.id returning * into v_slot;
        perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
      end if;
    when 'intent' then
      if v_slot.status <> 'failed' then
        update public.schedule_slots
        set status = 'failed', mode = 'intent', account_id = null, lease_until = null, updated_at = now(),
            error = jsonb_build_object('code', 'no_account', 'retryable', true,
              'message', 'No connected ' || public.schedule_platform_label(v_slot.platform)
                || ' account: copy it and post it yourself, or connect the account and retry.')
        where id = v_slot.id returning * into v_slot;
        perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
      end if;
    else
      raise exception 'Unknown post status.' using errcode = '22023';
  end case;
  return v_slot;
end;
$$;


--
-- Name: purge_expired_jobs(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_expired_jobs(p_job_ids uuid[] DEFAULT NULL::uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_rows int;
begin
  -- Cờ này tắt trigger ghi manifest cho ĐÚNG transaction purge: đường dẫn đã
  -- nằm trong hàng đợi từ lúc tombstone và đã được xác nhận xoá xong.
  perform set_config('opencmo.purge', 'on', true);
  delete from public.jobs j
  where j.purging_at is not null
    and (p_job_ids is null or j.id = any(p_job_ids))
    and not exists (select 1 from public.storage_deletions d where d.job_id = j.id);
  get diagnostics v_rows = row_count;
  -- Trả cờ về ngay sau lệnh xoá: mọi trigger cascade đã chạy xong, và hàm này
  -- có thể được gọi giữa một transaction còn làm việc khác sau đó.
  perform set_config('opencmo.purge', 'off', true);
  return v_rows;
end;
$$;


--
-- Name: purge_in_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_in_progress() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select coalesce(current_setting('opencmo.purge', true), '') = 'on';
$$;


--
-- Name: purge_stale_rate_limits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_stale_rate_limits() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_rows int;
begin
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rows = row_count;
  delete from public.upload_reservations
   where status = 'reserved' and expires_at < now() - interval '1 day';
  delete from public.polar_webhook_receipts where received_at < now() - interval '90 days';
  return v_rows;
end;
$$;


--
-- Name: purge_unpaid_accounts(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_unpaid_accounts(p_limit integer DEFAULT 50) RETURNS SETOF uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500.';
  end if;

  for v_user in
    select p.id
    from public.profiles p
    where p.retention_from + interval '30 days' < now()
      and not public.account_is_paid(p.id)
      -- Work still running (the worker holds a lease): leave it to the next cron run.
      and not exists (
        select 1 from public.tasks t
        where t.user_id = p.id and t.status in ('queued', 'running')
      )
    order by p.retention_from
    limit p_limit
    for update of p skip locked
  loop
    insert into public.storage_deletions (bucket, path, user_id)
    select o.bucket_id, o.name, v_user
    from storage.objects o
    where o.bucket_id in ('clips', 'sources', 'renders', 'media', 'exports', 'brand', 'captures')
      and o.name like v_user::text || '/%'
      and not exists (
        select 1 from public.storage_deletions d where d.bucket = o.bucket_id and d.path = o.name
      );
    return next v_user;
  end loop;
end;
$$;


--
-- Name: push_done(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_done(p_subscription uuid, p_status integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_status in (404, 410) then
    delete from public.push_subscriptions where id = p_subscription;
    return false;
  end if;
  update public.push_subscriptions
  set last_pushed_at = case when p_status between 200 and 299 then now() else last_pushed_at end,
      failed_at = case when p_status between 200 and 299 then null else now() end
  where id = p_subscription;
  return true;
end;
$$;


--
-- Name: push_due(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_due(p_limit integer) RETURNS TABLE(subscription_id uuid, user_id uuid, endpoint text, waiting integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select s.id, s.user_id, s.endpoint,
    (select count(*)::integer from public.approvals a where a.user_id = s.user_id and a.status = 'waiting')
  from public.push_subscriptions s
  where public.push_endpoint_allowed(s.endpoint)
    and not exists (select 1 from public.notify_settings n where n.user_id = s.user_id and not n.push)
    and exists (select 1 from public.approvals a where a.user_id = s.user_id and a.status = 'waiting'
                and coalesce(a.released_at, a.created_at) > coalesce(s.last_pushed_at, s.created_at))
  order by s.user_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;


--
-- Name: push_endpoint_allowed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_endpoint_allowed(p_endpoint text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
  select p_endpoint is not null and char_length(p_endpoint) <= 1000
    and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^\s]+$';
$_$;


--
-- Name: push_subscribe(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_id uuid;
begin
  if not public.push_endpoint_allowed(p_endpoint) then
    raise exception 'This browser''s push service is not supported.' using errcode = '22023';
  end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{20,200}={0,2}$' or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{8,100}={0,2}$' then
    raise exception 'The push keys are not valid.' using errcode = '22023';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = v_user and endpoint <> p_endpoint) >= 10 then
    raise exception 'Push is on in 10 browsers already. Turn it off in one first.' using errcode = 'P0001';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_user, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, failed_at = null
  returning id into v_id;
  return v_id;
end;
$_$;


--
-- Name: push_unsubscribe(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_unsubscribe(p_endpoint text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_user;
  return found;
end;
$$;


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    job_id uuid NOT NULL,
    kind text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_id uuid,
    CONSTRAINT artifacts_data_check CHECK ((pg_column_size(data) < 8000000)),
    CONSTRAINT artifacts_kind_check CHECK ((kind = ANY (ARRAY['source'::text, 'transcript'::text, 'moments'::text, 'render_settings'::text, 'face_track'::text])))
);


--
-- Name: put_artifact(uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.put_artifact(p_job_id uuid, p_attempt_id uuid, p_kind text, p_data jsonb) RETURNS public.artifacts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_job public.jobs;
  v_artifact public.artifacts;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_attempt_id is null or v_job.attempt_id is distinct from p_attempt_id
     or v_job.status not in ('running', 'done') then
    raise exception 'This processing attempt is no longer active.' using errcode = 'P0001';
  end if;
  select * into v_artifact from public.artifacts
  where job_id = p_job_id and kind = p_kind and attempt_id = p_attempt_id;
  if found then
    if v_artifact.data is distinct from p_data then
      raise exception 'This artifact was already saved with different content.' using errcode = '22023';
    end if;
    return v_artifact;
  end if;
  insert into public.artifacts(job_id, kind, version, data, attempt_id)
  select p_job_id, p_kind, coalesce(max(version), 0) + 1, p_data, p_attempt_id
  from public.artifacts where job_id = p_job_id and kind = p_kind
  returning * into v_artifact;
  return v_artifact;
end;
$$;


--
-- Name: put_editor_transcript(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.put_editor_transcript(p_clip_id uuid, p_body text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_json jsonb;
  v_hash text;
begin
  if p_body is null or octet_length(p_body) >= 524288 then
    raise exception 'This transcript is too large to save.' using errcode = '22023';
  end if;

  begin
    v_json := p_body::jsonb;
  exception when others then
    raise exception 'This transcript is not valid JSON.' using errcode = '22023';
  end;

  -- Hình dạng mà `resolveTranscript` của DS đọc thẳng bằng `JSON.parse`: một
  -- mảng đoạn, mỗi đoạn có `text` và mảng `words`. Sai hình dạng thì phụ đề
  -- rỗng, không lỗi nào — nên chặn ở đây.
  if jsonb_typeof(v_json) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_json) as segment
    where jsonb_typeof(segment) <> 'object'
       or jsonb_typeof(segment -> 'text') is distinct from 'string'
       or jsonb_typeof(segment -> 'words') is distinct from 'array'
  ) then
    raise exception 'This transcript has an unexpected shape.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  v_hash := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');

  insert into public.editor_transcripts (clip_id, hash, body)
  values (p_clip_id, v_hash, p_body)
  on conflict (clip_id, hash) do nothing;

  return v_hash;
end;
$$;


--
-- Name: queue_asset_transcript(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_asset_transcript(p_asset_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_asset public.media_assets;
  v_used numeric;
  v_status text;
begin
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found then return null; end if;
  if v_asset.transcript_status in ('queued', 'running', 'ready') then
    return v_asset.transcript_status;
  end if;
  if v_asset.status <> 'ready' or v_asset.storage_path not like 'media/%' then
    return v_asset.transcript_status;
  end if;
  if v_asset.has_audio is distinct from true or v_asset.duration is null or v_asset.duration < 0.5 then
    v_status := 'none';
  elsif v_asset.duration > public.captions_max_seconds() then
    v_status := 'skipped';
  else
    -- Lock per user so two uploads finishing together cannot both slip under the cap.
    perform public.lock_credit_owner(v_asset.user_id);
    select coalesce(sum(a.duration), 0) into v_used
    from public.tasks t join public.media_assets a on a.id = t.asset_id
    where t.user_id = v_asset.user_id and t.kind = 'transcribe_asset'
      and t.status in ('queued', 'running', 'done')
      and t.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    if v_used + v_asset.duration > public.auto_transcript_daily_seconds() then
      v_status := 'skipped';
    else
      insert into public.tasks (user_id, kind, job_id, asset_id, payload, status, request_id)
      values (v_asset.user_id, 'transcribe_asset', v_asset.job_id, v_asset.id,
              jsonb_build_object('scope', 'file', 'auto', true, 'credits', 0), 'queued', gen_random_uuid());
      v_status := 'queued';
    end if;
  end if;
  update public.media_assets set transcript_status = v_status where id = v_asset.id;
  return v_status;
end;
$$;


--
-- Name: rate_limit_hit(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_bucket text;
  v_plan text;
  v_quota record;
  v_expected int;
  v_window_start timestamptz;
  v_legacy_count int := 0;
  v_count int;
  v_allowed boolean := false;
begin
  v_bucket := case p_bucket
    when 'daily_preview' then 'preview'
    when 'daily_export' then 'export'
    else p_bucket
  end;

  if v_bucket in ('preview', 'export') then
    select coalesce(plan, 'free') into v_plan
    from public.profiles where id = v_user;
    select * into v_quota from public.plan_quota(v_plan);
    v_expected := case
      when v_bucket = 'preview' then v_quota.previews_per_day
      else v_quota.exports_per_day
    end;
    v_allowed := p_limit = v_expected and p_window_seconds = 86400;
    if p_bucket = 'preview' and p_limit = 2 and p_window_seconds = 60 then
      v_allowed := true;
    end if;
  else
    v_allowed := (p_bucket = 'presets' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'uploads' and p_limit = 30 and p_window_seconds = 3600)
      or (p_bucket = 'jobs' and p_limit = 10 and p_window_seconds = 3600)
      or (p_bucket = 'retry' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'draft' and p_limit = 120 and p_window_seconds = 60)
      or (p_bucket = 'project-write' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'mcp' and p_limit = 600 and p_window_seconds = 3600)
      -- P4: connecting and disconnecting social accounts (each call reaches Zernio).
      or (p_bucket = 'accounts' and p_limit = 30 and p_window_seconds = 3600)
      -- P4: moving a slot on the calendar and "I posted it" (`/api/v1/schedule/slots/[id]`).
      or (p_bucket = 'schedule' and p_limit = 120 and p_window_seconds = 3600)
      or (p_bucket = 'editor-write' and p_limit = 240 and p_window_seconds = 60)
      or (p_bucket = 'zip' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'media' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'scene_codes' and p_limit = 300 and p_window_seconds = 3600)
      or (p_bucket = 'feedback' and p_limit = 20 and p_window_seconds = 3600)
      -- 30 until motion quality A3 (PR #104) raised MCP previews to 60: both, so either PR can merge first.
      or (p_bucket = 'mcp_preview' and p_limit = 30 and p_window_seconds = 3600)
      or (p_bucket = 'mcp_preview' and p_limit = 60 and p_window_seconds = 3600)
      -- POST /api/v1/generations: each request can run a paid moderation call.
      or (p_bucket = 'generations' and p_limit = 120 and p_window_seconds = 3600)
      -- `create_generation` itself: a direct PostgREST call skips the route's bucket.
      or (p_bucket = 'generation_create' and p_limit = 120 and p_window_seconds = 3600)
      or (p_bucket = 'mcp_look' and p_limit = 60 and p_window_seconds = 3600);
  end if;

  if not v_allowed then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;

  -- The short preview/export window counts in its own row: in the first minute after UTC
  -- midnight the 60-second and the daily window share a `window_start`, and used to add up
  -- into the daily quota (CI red at 00:00:24 UTC on 04/10).
  if v_bucket in ('preview', 'export') and p_window_seconds <> 86400 then
    v_bucket := v_bucket || ':' || p_window_seconds;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  if v_bucket in ('preview', 'export') and p_window_seconds = 86400 then
    select coalesce(max(count), 0) into v_legacy_count
    from public.rate_limits
      where user_id = v_user
      and bucket = 'daily_' || v_bucket
      and window_start = v_window_start;
  end if;

  insert into public.rate_limits(user_id, bucket, window_start, count)
  values(v_user, v_bucket, v_window_start, v_legacy_count + 1)
  on conflict (user_id, bucket, window_start)
  do update set count = greatest(public.rate_limits.count, v_legacy_count) + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;


--
-- Name: reclaim_expired_jobs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reclaim_expired_jobs(p_max_attempts integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  r record;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, user_id, attempt, attempt_id
    from public.jobs
    where status = 'running' and attempt_id is not null and lease_until < now()
    order by lease_until
    limit 50
  loop
    if r.attempt < p_max_attempts then
      update public.jobs
      set status = 'queued', attempt_id = null, lease_until = null,
          heartbeat_at = null, call_id = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_requeued := v_requeued + 1;
      end if;
    else
      perform public.lock_credit_owner(r.user_id);

      update public.jobs
      set status = 'failed',
          error = 'Processing was interrupted too many times.',
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();

      if found then
        perform public.credit_refund(r.user_id, 'job', r.id, 'Refund: job failed', r.id);
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;


--
-- Name: reclaim_expired_tasks(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reclaim_expired_tasks(p_max_attempts integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  r record;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, attempt, attempt_id
    from public.tasks
    where status = 'running' and attempt_id is not null and lease_until < now()
    order by lease_until
    limit 50
  loop
    if r.attempt < p_max_attempts then
      update public.tasks
      set status = 'queued', attempt_id = null, lease_until = null, heartbeat_at = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_requeued := v_requeued + 1;
      end if;
    else
      update public.tasks
      set status = 'failed',
          error = 'Rendering stopped unexpectedly. Please try again.',
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_failed := v_failed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;


--
-- Name: record_clip_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_clip_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.purge_in_progress() then
    insert into public.storage_deletions (bucket, path, job_id)
    select 'clips', p, old.job_id
    from unnest(array[old.storage_path, old.preview_path]) as p
    where p is not null and p <> '' and p not like '%..%'
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;


--
-- Name: record_job_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_job_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.purge_in_progress() then
    insert into public.storage_deletions (bucket, path, job_id, user_id)
    select source.bucket, source.path, old.id, old.user_id
    from (
      select coalesce(section.value->>'bucket', 'sources') as bucket, section.value->>'object' as path
        from jsonb_array_elements(
          case when jsonb_typeof(old.media_manifest->'sections') = 'array'
               then old.media_manifest->'sections' else '[]'::jsonb end) section
      union
      select coalesce(proxy.value->>'bucket', 'sources'), proxy.value->>'object'
        from jsonb_each(
          case when jsonb_typeof(old.media_manifest->'proxies') = 'object'
               then old.media_manifest->'proxies' else '{}'::jsonb end) proxy
      union
      select 'sources', substring(old.source_url from 11) where old.source_url like 'storage://%'
    ) as source
    where source.path is not null and source.path <> '' and source.path not like '%..%'
      and source.bucket in ('clips', 'sources', 'renders', 'media')
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;


--
-- Name: record_media_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_media_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.purge_in_progress() and old.storage_path like 'media/%' then
    insert into public.storage_deletions (bucket, path, job_id, user_id)
    values ('media', substring(old.storage_path from 7), old.job_id, old.user_id)
    on conflict (bucket, path) do nothing;
  end if;
  return old;
end;
$$;


--
-- Name: record_task_storage_deletions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_task_storage_deletions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;


--
-- Name: refund_caption_translation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_caption_translation(p_charge_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.caption_translations;
begin
  -- Called by the web server (service role) after its own LLM call failed. A user who could call it
  -- would refund a translation while the paid LLM call was still running.
  select * into v_row from public.caption_translations where id = p_charge_id for update;
  if not found or v_row.status <> 'charged' then
    return false;
  end if;
  update public.caption_translations set status = 'refunded' where id = v_row.id;
  perform public.credit_refund(v_row.user_id, 'caption_translation', v_row.id, 'Caption translation refund',
    (select job_id from public.clips where id = v_row.clip_id));
  return true;
end;
$$;


--
-- Name: refund_job(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_job(p_job_id uuid, p_reason text DEFAULT 'Refund: job failed'::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    return 0;
  end if;

  perform public.lock_credit_owner(v_user);

  return public.credit_refund(v_user, 'job', p_job_id, p_reason, p_job_id);
end;
$$;


--
-- Name: refund_media_captions_from_task(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_media_captions_from_task() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_credits int := coalesce((new.payload ->> 'credits')::int, 0);
begin
  if new.kind = 'transcribe_media' and new.status in ('failed', 'cancelled')
     and old.status not in ('failed', 'cancelled', 'done') and v_credits > 0 then
    perform public.credit_refund(new.user_id, 'captions', new.id, 'Captions refund', new.job_id);
  end if;
  return new;
end;
$$;


--
-- Name: refuse_email_signup(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refuse_email_signup(event jsonb) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select case
    when event #>> '{user,app_metadata,provider}' = 'email'
      then jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'New accounts sign up with Google.'))
    else '{}'::jsonb
  end;
$$;


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    storage_path text NOT NULL,
    name text NOT NULL,
    duration numeric,
    width integer,
    height integer,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    words jsonb,
    has_audio boolean,
    transcript_status text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT media_assets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'rejected'::text]))),
    CONSTRAINT media_assets_transcript_status_check CHECK ((transcript_status = ANY (ARRAY['none'::text, 'queued'::text, 'running'::text, 'ready'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT media_assets_words_check CHECK (((words IS NULL) OR ((jsonb_typeof(words) = 'array'::text) AND (octet_length((words)::text) < 524288))))
);


--
-- Name: register_media_asset(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_media_asset(p_job_id uuid, p_storage_path text, p_name text) RETURNS public.media_assets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare v_user uuid := public.require_user(); v_segments text[]; v_name text:=trim(coalesce(p_name,'')); v_count int; v_asset public.media_assets; v_object text;
begin
  perform 1 from public.jobs where id=p_job_id and user_id=v_user for update;
  if not found then raise exception 'Project not found.' using errcode='P0002'; end if;
  v_segments:=string_to_array(coalesce(p_storage_path,''),'/');
  if array_length(v_segments,1) is distinct from 4 or v_segments[1]<>'media' or v_segments[2]<>v_user::text or v_segments[3]<>p_job_id::text or v_segments[4]!~'^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{2,5}$'
    then raise exception 'That media file is no longer available. Please try again.' using errcode='22023'; end if;
  if v_name='' then raise exception 'This media file needs a name.' using errcode='22023'; end if;
  v_name:=left(v_name,200);
  select * into v_asset from public.media_assets where storage_path=p_storage_path and user_id=v_user and job_id=p_job_id;
  if found then return v_asset; end if;
  select count(*) into v_count from public.media_assets where job_id=p_job_id;
  if v_count>=50 then raise exception 'This project already has 50 media files.' using errcode='P0001'; end if;
  v_object:=substring(p_storage_path from 7);
  perform public.consume_upload_reservation('media',v_object,p_job_id);
  insert into public.media_assets(user_id,job_id,storage_path,name) values(v_user,p_job_id,p_storage_path,v_name)
    on conflict(storage_path) do nothing returning * into v_asset;
  if not found then select * into v_asset from public.media_assets where storage_path=p_storage_path and user_id=v_user and job_id=p_job_id; end if;
  if not found then raise exception 'That media file is no longer available. Please try again.' using errcode='22023'; end if;
  return v_asset;
end; $_$;


--
-- Name: register_media_asset(uuid, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_media_asset(p_job_id uuid, p_storage_path text, p_name text, p_request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid:=public.require_user(); v_asset public.media_assets; v_task public.tasks;
begin
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_request_id::text,1704));
  v_asset:=public.register_media_asset(p_job_id,p_storage_path,p_name);
  select * into v_task from public.tasks where asset_id=v_asset.id and kind='probe_media' order by created_at desc limit 1;
  if not found then
    perform 1 from public.tasks where request_id=p_request_id;
    if found then
      raise exception 'That request id was already used for a different media file.' using errcode='22023';
    end if;
    insert into public.tasks(user_id,kind,asset_id,job_id,request_id)
      values(v_user,'probe_media',v_asset.id,p_job_id,p_request_id) returning * into v_task;
  end if;
  if v_task.user_id is distinct from v_user or v_task.kind<>'probe_media' or v_task.asset_id is distinct from v_asset.id or v_task.job_id is distinct from p_job_id
    then raise exception 'That request id was already used for a different media file.' using errcode='22023'; end if;
  return jsonb_build_object('asset',to_jsonb(v_asset),'task_id',v_task.id);
end; $$;


--
-- Name: reject_credit_ledger_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_credit_ledger_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and old.user_id is not null
     and new.user_id is null
     and new.id is not distinct from old.id
     and new.delta is not distinct from old.delta
     and new.reason is not distinct from old.reason
     and new.job_id is not distinct from old.job_id
     and new.external_id is not distinct from old.external_id
     and new.created_at is not distinct from old.created_at
     and not exists(select 1 from auth.users where id = old.user_id) then
    return new;
  end if;
  raise exception 'Credit ledger entries cannot be changed or deleted.' using errcode = '55000';
end;
$$;


--
-- Name: release_rate_limit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_rate_limit(p_bucket text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.release_rate_limit_for(public.require_user(), p_bucket, now());
end;
$$;


--
-- Name: release_rate_limit_for(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_rate_limit_for(p_user_id uuid, p_bucket text, p_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_window_seconds int;
  v_window_start timestamptz;
begin
  if p_user_id is null or p_bucket not in ('preview', 'export') or p_at is null then
    raise exception 'Invalid rate limit release.' using errcode = '22023';
  end if;
  v_window_seconds := 86400;
  v_window_start := to_timestamp(
    floor(extract(epoch from p_at) / v_window_seconds) * v_window_seconds
  );
  update public.rate_limits
  set count = greatest(count - 1, 0)
  where user_id = p_user_id
    and bucket = p_bucket
    and window_start = v_window_start
    and count > 0;
  return found;
end;
$$;


--
-- Name: remove_video_pack_leftovers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_video_pack_leftovers() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_rows int;
begin
  perform public.refund_job(j.id, 'Refund: video packs were removed')
  from public.jobs j
  where j.status in ('queued', 'running')
    and not exists (select 1 from public.projects p where p.job_id = j.id);
  delete from public.jobs j
  where not exists (select 1 from public.projects p where p.job_id = j.id);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;


--
-- Name: rename_blank_edit(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rename_blank_edit(p_clip_id uuid, p_name text) RETURNS text
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


--
-- Name: rename_project(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rename_project(p_job_id uuid, p_name text) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := trim(coalesce(p_name, ''));
  v_job public.jobs;
begin
  if v_name = '' then
    raise exception 'Name this project before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Keep the project name under 120 characters.' using errcode = '22023';
  end if;

  update public.jobs set name = v_name
  where id = p_job_id and user_id = v_user
  returning * into v_job;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  return v_job;
end;
$$;


--
-- Name: request_document_export(uuid, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_document_export(p_clip_id uuid, p_revision_id uuid, p_request_id uuid, p_resolution integer DEFAULT 1080) RETURNS public.tasks
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


--
-- Name: request_media_captions(uuid, uuid, numeric, numeric, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_media_captions(p_clip_id uuid, p_media_id uuid, p_source_in numeric DEFAULT 0, p_source_out numeric DEFAULT NULL::numeric, p_request_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_asset public.media_assets;
  v_in numeric;
  v_out numeric;
  v_credits int;
  v_task public.tasks;
  v_body text;
  v_hash text;
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  select * into v_asset from public.media_assets
  where id = p_media_id and user_id = v_user and job_id = v_clip.job_id
    and status <> 'rejected' and storage_path like 'media/%';
  if not found then
    raise exception 'This file is not stored with this project. Wait for it to finish uploading.' using errcode = 'P0002';
  end if;
  -- The library says "synced" as soon as the upload ends, before the worker has measured the
  -- file: the client sees "still being processed" (409), waits and calls again.
  if v_asset.status <> 'ready' then
    raise exception 'This file is still being processed. Try again in a moment.' using errcode = 'P0001';
  end if;
  if v_asset.duration is null or v_asset.duration <= 0 then
    raise exception 'This file has no audio to caption.' using errcode = '22023';
  end if;

  v_in := greatest(0, coalesce(p_source_in, 0));
  v_out := least(v_asset.duration, coalesce(p_source_out, v_asset.duration));
  if v_out - v_in < 0.5 then
    raise exception 'Choose a longer part of the file to caption.' using errcode = '22023';
  end if;

  if p_request_id is not null then
    select * into v_task from public.tasks where request_id = p_request_id and user_id = v_user;
    if found then
      return jsonb_build_object('task_id', v_task.id, 'credits', (v_task.payload ->> 'credits')::int);
    end if;
  end if;

  -- Reuse: the file's own transcript, sliced to this window, for free.
  select body into v_body from public.media_transcripts where asset_id = v_asset.id;
  if v_body is not null then
    v_hash := public.store_transcript_slice(p_clip_id, v_body::jsonb, v_in, v_out);
    insert into public.tasks (user_id, kind, clip_id, job_id, asset_id, payload, status, request_id,
                              started_at, finished_at, output)
    values (v_user, 'transcribe_media', p_clip_id, v_clip.job_id, p_media_id,
            jsonb_build_object('source_in', v_in, 'source_out', v_out, 'credits', 0, 'reused', true),
            'done', coalesce(p_request_id, gen_random_uuid()), now(), now(),
            jsonb_build_object('hash', v_hash, 'src', 'assets/transcripts/' || v_hash || '.json'))
    returning * into v_task;
    return jsonb_build_object('task_id', v_task.id, 'credits', 0);
  end if;

  if v_out - v_in > public.captions_max_seconds() then
    raise exception 'Captions work on up to % minutes at a time. Trim the clip first.', public.captions_max_seconds() / 60
      using errcode = '22023';
  end if;
  v_credits := public.captions_credits(v_out - v_in);

  perform public.lock_credit_owner(v_user);
  select * into v_task from public.tasks
  where user_id = v_user and kind = 'transcribe_media' and clip_id = p_clip_id and asset_id = p_media_id
    and status in ('queued', 'running')
    and (payload ->> 'source_in')::numeric = v_in and (payload ->> 'source_out')::numeric = v_out
  limit 1;
  if found then
    return jsonb_build_object('task_id', v_task.id, 'credits', (v_task.payload ->> 'credits')::int);
  end if;

  if public.credit_balance(v_user) < v_credits then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_credits, public.credit_balance(v_user) using errcode = 'P0001';
  end if;
  insert into public.tasks (user_id, kind, clip_id, job_id, asset_id, payload, status, request_id)
  values (v_user, 'transcribe_media', p_clip_id, v_clip.job_id, p_media_id,
          jsonb_build_object('source_in', v_in, 'source_out', v_out, 'credits', v_credits),
          'queued', coalesce(p_request_id, gen_random_uuid()))
  returning * into v_task;
  perform public.credit_hold(v_user, 'captions', v_task.id, v_credits, 'Captions', v_clip.job_id);
  return jsonb_build_object('task_id', v_task.id, 'credits', v_credits);
end;
$$;


--
-- Name: request_media_transcript(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_media_transcript(p_media_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_asset public.media_assets;
begin
  select * into v_asset from public.media_assets
  where id = p_media_id and user_id = v_user and status <> 'rejected' and storage_path like 'media/%';
  if not found then
    raise exception 'This file is not stored with this project. Wait for it to finish uploading.' using errcode = 'P0002';
  end if;
  if v_asset.transcript_status = 'failed' then
    update public.media_assets set transcript_status = 'none' where id = v_asset.id;
  end if;
  return public.queue_asset_transcript(v_asset.id);
end;
$$;


--
-- Name: request_stills_export(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_stills_export(p_clip_id uuid, p_revision_id uuid, p_request_id uuid) RETURNS public.tasks
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


--
-- Name: require_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_user() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  return v_user;
end;
$$;


--
-- Name: reserve_upload(text, text, bigint, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_upload(p_bucket text, p_object_name text, p_size bigint, p_content_type text, p_project_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
declare
  v_user uuid := public.require_user();
  v_plan text;
  v_limits record;
  v_bytes bigint;
  v_objects bigint;
  v_existing public.upload_reservations;
  v_row public.upload_reservations;
  v_parts text[] := string_to_array(coalesce(p_object_name, ''), '/');
begin
  if p_bucket not in ('sources', 'media', 'exports') or p_size is null or p_size <= 0
     or p_size > 2147483648 or coalesce(p_content_type, '') not like 'video/%' then
    raise exception 'That video cannot be uploaded.' using errcode = '22023';
  end if;
  if v_parts[1] is distinct from v_user::text
     or (p_bucket = 'sources' and array_length(v_parts, 1) <> 2)
     or (p_bucket in ('media', 'exports') and array_length(v_parts, 1) <> 3) then
    raise exception 'Invalid upload path.' using errcode = '22023';
  end if;
  if p_bucket = 'sources' and p_project_id is not null then
    raise exception 'A source upload cannot belong to an existing project.' using errcode = '22023';
  end if;
  if p_bucket = 'media' and (
    p_project_id is null or v_parts[2] is distinct from p_project_id::text or
    not exists(select 1 from public.jobs where id = p_project_id and user_id = v_user)
  ) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if p_bucket = 'exports' and (
    p_project_id is null or not exists(
      select 1 from public.clips c
      join public.jobs j on j.id = c.job_id
      where c.id::text = v_parts[2]
        and c.job_id = p_project_id
        and j.user_id = v_user
        and j.purging_at is null
    )
  ) then
    raise exception 'Clip not found.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':upload', 1703));
  delete from public.upload_reservations
    where user_id = v_user and status = 'reserved' and expires_at <= now();

  select * into v_existing from public.upload_reservations
    where bucket = p_bucket and object_name = p_object_name;
  if found then
    if v_existing.user_id = v_user and v_existing.declared_size = p_size
       and v_existing.content_type = p_content_type
       and v_existing.project_id is not distinct from p_project_id
       and v_existing.status = 'reserved' and v_existing.expires_at > now() then
      return jsonb_build_object('bucket', v_existing.bucket, 'object_name', v_existing.object_name,
        'expires_at', v_existing.expires_at);
    end if;
    raise exception 'That upload path is already in use.' using errcode = '22023';
  end if;

  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0), count(*)
    into v_bytes, v_objects
    from storage.objects o
    where o.bucket_id in ('sources', 'media', 'exports')
      and (storage.foldername(o.name))[1] = v_user::text;
  select v_bytes + coalesce(sum(r.declared_size), 0), v_objects + count(*)
    into v_bytes, v_objects
    from public.upload_reservations r
    where r.user_id = v_user and r.status = 'reserved' and r.expires_at > now()
      and not exists(select 1 from storage.objects o where o.bucket_id = r.bucket and o.name = r.object_name);
  if v_bytes + p_size > v_limits.stored_bytes or v_objects + 1 > v_limits.stored_objects then
    raise exception 'You have reached your storage limit for this plan.' using errcode = 'P0001';
  end if;

  insert into public.upload_reservations(user_id, bucket, object_name, declared_size, content_type, project_id)
    values(v_user, p_bucket, p_object_name, p_size, p_content_type, p_project_id)
    returning * into v_row;
  return jsonb_build_object('bucket', v_row.bucket, 'object_name', v_row.object_name,
    'expires_at', v_row.expires_at);
end;
$$;


--
-- Name: reset_editor_project(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_editor_project(p_clip_id uuid, p_expected_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
begin
  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if v_row.generated_document is null then
    raise exception 'This project has no original version to go back to.' using errcode = '22023';
  end if;
  if v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  update public.editor_projects
  set document = v_row.generated_document,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id
    and document is distinct from v_row.generated_document;

  return public.editor_json(p_clip_id);
end;
$$;


--
-- Name: retry_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retry_job(p_job_id uuid) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_spent int;
  v_balance int;
  v_status public.job_status;
  v_job public.jobs;
begin
  -- Khoá hồ sơ TRƯỚC khi đọc số dư, đúng thứ tự của `create_job`: hai tab bấm
  -- Retry cùng lúc không được tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  -- Same caps as create_upload_edit: the route's limit alone is skipped by calling this RPC directly.
  if (select count(*) from public.jobs
      where user_id = v_user and status in ('queued', 'running') and purging_at is null) >= 3
  then
    raise exception 'You already have 3 projects in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;
  if not public.rate_limit_hit('retry', 20, 3600) then
    raise exception 'Too many retries. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;

  select status into v_status
  from public.jobs
  where id = p_job_id and user_id = v_user and purging_at is null
  for update;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_status not in ('failed', 'cancelled') then
    raise exception 'Only a failed project can be run again.' using errcode = '22023';
  end if;

  -- Lần chạy trước có thể đã được hoàn credit (`finalize_job_failure`). Giữ lại
  -- đúng phần còn thiếu để một job không bao giờ bị tính tiền hai lần.
  v_spent := public.job_credits_spent(p_job_id);
  if v_spent < v_hold then
    select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;

    if v_balance < v_hold - v_spent then
      raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
        v_hold - v_spent, v_balance using errcode = 'P0001';
    end if;

    perform public.credit_hold(v_user, 'job', p_job_id, v_hold - v_spent, 'Hold for retry', p_job_id);
  end if;

  update public.jobs
  set status = 'queued',
      stage = 'queued',
      error = null,
      finished_at = null,
      -- attempt_id để null: worker của lần chạy cũ (nếu còn sống) ghi bằng
      -- attempt_id cũ sẽ bị mọi RPC có fence từ chối.
      attempt_id = null,
      lease_until = null,
      heartbeat_at = null,
      attempt_started_at = now(),
      call_id = null,
      attempt = 0
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;


--
-- Name: revoke_api_key(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_api_key(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  update public.api_keys set revoked_at = now()
  where id = p_id and user_id = v_user and revoked_at is null;
  return found;
end;
$$;


--
-- Name: sales_mention_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sales_mention_count() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select public.sales_mention_count_for(public.require_user()) $$;


--
-- Name: sales_mention_count_for(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sales_mention_count_for(p_user uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select count(*) filter (where mentioned_product)::integer from (
    select mentioned_product from public.cmo_draft_outcomes
    where user_id = p_user and department = 'sales' and action = 'replied'
    order by decided_at desc limit 10) last_ten
$$;


--
-- Name: sales_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_settings (
    user_id uuid NOT NULL,
    excluded_subreddits text[] DEFAULT '{}'::text[] NOT NULL,
    co_occurrence jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_settings_co_occurrence_check CHECK (((jsonb_typeof(co_occurrence) = 'array'::text) AND (jsonb_array_length(co_occurrence) <= 20) AND (octet_length((co_occurrence)::text) <= 4096))),
    CONSTRAINT sales_settings_excluded_subreddits_check CHECK ((cardinality(excluded_subreddits) <= 50))
);


--
-- Name: sales_settings_save(text[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sales_settings_save(p_excluded text[], p_pairs jsonb) RETURNS public.sales_settings
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_excluded text[];
  v_pairs jsonb;
  v_row public.sales_settings;
begin
  select coalesce(array_agg(distinct n order by n), '{}') into v_excluded
  from (select regexp_replace(lower(btrim(e)), '^/?r/', '') as n from unnest(coalesce(p_excluded, '{}')) e) s
  where n <> '';
  if cardinality(v_excluded) > 50 then
    raise exception 'Exclude at most 50 subreddits.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_excluded) n where n !~ '^[a-z0-9_]{2,21}$') then
    raise exception 'A subreddit name has 2 to 21 letters, digits or underscores.' using errcode = '22023';
  end if;
  if p_pairs is null or jsonb_typeof(p_pairs) <> 'array' then
    raise exception 'Term pairs must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_pairs) > 20 then
    raise exception 'Add at most 20 term pairs.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_pairs) p
             where jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 2
               or jsonb_typeof(p->0) <> 'string' or jsonb_typeof(p->1) <> 'string') then
    raise exception 'Each pair has exactly two terms.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(a, b)), '[]'::jsonb) into v_pairs
  from (select lower(btrim(p->>0)) as a, lower(btrim(p->>1)) as b from jsonb_array_elements(p_pairs) p) s;
  if exists (select 1 from jsonb_array_elements(v_pairs) p
             where char_length(p->>0) not between 1 and 60 or char_length(p->>1) not between 1 and 60 or p->>0 = p->>1) then
    raise exception 'Each term has 1 to 60 characters, and the two terms of a pair differ.' using errcode = '22023';
  end if;
  insert into public.sales_settings (user_id, excluded_subreddits, co_occurrence, updated_at)
  values (v_user, v_excluded, v_pairs, now())
  on conflict (user_id) do update
    set excluded_subreddits = excluded.excluded_subreddits, co_occurrence = excluded.co_occurrence, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$_$;


--
-- Name: brand_kits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_kits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    kit jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brand_kits_kit_check CHECK (((jsonb_typeof(kit) = 'object'::text) AND (octet_length((kit)::text) <= 16384))),
    CONSTRAINT brand_kits_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))
);


--
-- Name: save_brand_kit(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_brand_kit(p_id uuid, p_name text, p_kit jsonb) RETURNS public.brand_kits
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.brand_kits;
begin
  if v_name = '' then
    raise exception 'Name this brand kit before saving it.' using errcode = '22023';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Keep the brand kit name under 60 characters.' using errcode = '22023';
  end if;
  if octet_length(coalesce(p_kit::text, '')) > 16384 then
    raise exception 'This brand kit is too large.' using errcode = '22023';
  end if;
  perform public.brand_check_kit(v_user, p_kit);

  begin
    if p_id is null then
      perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':brand', 1708));
      if (select count(*) from public.brand_kits where user_id = v_user) >= 20 then
        raise exception 'You can keep up to 20 brand kits.' using errcode = 'P0001';
      end if;
      -- Kit đầu tiên tự thành mặc định: tạo xong là clip mới dùng ngay.
      insert into public.brand_kits (user_id, name, kit, is_default)
      values (v_user, v_name, p_kit, not exists(select 1 from public.brand_kits where user_id = v_user))
      returning * into v_row;
    else
      update public.brand_kits set name = v_name, kit = p_kit, updated_at = now()
      where id = p_id and user_id = v_user
      returning * into v_row;
      if not found then
        raise exception 'Brand kit not found.' using errcode = 'P0002';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'A brand kit with this name already exists.' using errcode = '23505';
  end;
  return v_row;
end;
$$;


--
-- Name: save_cmo_settings(integer, text, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_cmo_settings(p_weekly_credit_budget integer, p_timezone text, p_digest_hour smallint) RETURNS TABLE(weekly_credit_budget integer, timezone text, digest_hour smallint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
begin
  if p_weekly_credit_budget is null or p_weekly_credit_budget < 0 or p_weekly_credit_budget > 10000 then
    raise exception 'The weekly budget must be between 0 and 10,000 credits.' using errcode = '22023';
  end if;
  -- pg_timezone_names is the list `at time zone` accepts; an unknown name would fail every digest later.
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'Choose a time zone from the list.' using errcode = '22023';
  end if;
  if p_digest_hour is not null and (p_digest_hour < 0 or p_digest_hour > 23) then
    raise exception 'The digest hour must be between 0 and 23.' using errcode = '22023';
  end if;
  update public.profiles p
  set weekly_credit_budget = p_weekly_credit_budget, timezone = p_timezone, digest_hour = p_digest_hour
  where p.id = v_user;
  if not found then
    raise exception 'Profile not found.' using errcode = 'P0002';
  end if;
  return query select p.weekly_credit_budget, p.timezone, p.digest_hour from public.profiles p where p.id = v_user;
end;
$$;


--
-- Name: save_editor_document(uuid, integer, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_editor_document(p_clip_id uuid, p_expected_version integer, p_document jsonb, p_manifest jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
  v_manifest jsonb;
begin
  if not public.editor_document_shape_ok(p_document) then
    raise exception 'This project could not be read.' using errcode = '22023';
  end if;
  if p_manifest is not null and jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'The project manifest must be an object.' using errcode = '22023';
  end if;
  if p_manifest is not null and pg_column_size(p_manifest) >= 65536 then
    raise exception 'This project has too many assets to save.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if v_row.version is distinct from p_expected_version then
    raise exception 'This clip was changed in another tab.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  v_manifest := coalesce(p_manifest, v_row.manifest);
  if v_row.document = p_document and v_row.manifest = v_manifest then
    return public.editor_json(p_clip_id);
  end if;

  update public.editor_projects
  set document = p_document,
      manifest = v_manifest,
      version = v_row.version + 1,
      updated_at = now()
  where clip_id = p_clip_id;

  return public.editor_json(p_clip_id);
end;
$$;


--
-- Name: editor_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editor_skills_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 50000))),
    CONSTRAINT editor_skills_description_check CHECK (((char_length(description) >= 1) AND (char_length(description) <= 300))),
    CONSTRAINT editor_skills_name_check CHECK (((name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (char_length(name) <= 64)))
);


--
-- Name: save_editor_skill(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_editor_skill(p_name text, p_description text, p_body text) RETURNS public.editor_skills
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_name text := lower(trim(coalesce(p_name, '')));
  v_row public.editor_skills;
begin
  if v_name !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_name) > 64 then
    raise exception 'A skill name uses lowercase letters, numbers and hyphens, up to 64 characters.' using errcode = '22023';
  end if;
  if char_length(trim(coalesce(p_description, ''))) not between 1 and 300 then
    raise exception 'A skill needs a one-line description (up to 300 characters).' using errcode = '22023';
  end if;
  if char_length(coalesce(p_body, '')) not between 1 and 50000 then
    raise exception 'A skill body is 1 to 50,000 characters.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.editor_skills s where s.user_id = v_user and s.name = v_name)
     and (select count(*) from public.editor_skills s where s.user_id = v_user) >= 50 then
    raise exception 'You have 50 skills already. Delete one first.' using errcode = 'P0001';
  end if;

  insert into public.editor_skills (user_id, name, description, body)
  values (v_user, v_name, trim(p_description), p_body)
  on conflict (user_id, name) do update
    set description = excluded.description, body = excluded.body, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$_$;


--
-- Name: save_marketing_document(text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_marketing_document(p_kind text, p_body jsonb, p_run uuid DEFAULT NULL::uuid) RETURNS public.marketing_documents
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_by text := 'user';
  v_row public.marketing_documents;
begin
  if p_kind is null or p_kind not in ('product', 'strategy', 'competitors', 'content_strategy', 'calendar') then
    raise exception 'Unknown document.' using errcode = '22023';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'This document is not valid.' using errcode = '22023';
  end if;
  if octet_length(p_body::text) > 65536 then
    raise exception 'This document is too long.' using errcode = '22023';
  end if;
  if p_run is not null then
    if not exists(select 1 from public.cmo_runs where id = p_run and user_id = v_user and status = 'running') then
      raise exception 'This task has already finished.' using errcode = 'P0002';
    end if;
    v_by := 'agent';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':doc:' || p_kind, 1713));
  insert into public.marketing_documents (user_id, kind, version, body, created_by)
  values (
    v_user, p_kind,
    coalesce((select max(version) from public.marketing_documents where user_id = v_user and kind = p_kind), 0) + 1,
    p_body, v_by
  )
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: save_scene_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_scene_code(p_code text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_hash text;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception 'Write the scene code first.' using errcode = '22023';
  end if;
  if char_length(p_code) > 32000 then
    raise exception 'The scene code is longer than 32000 characters.' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
  if not exists (select 1 from public.scene_codes where user_id = v_user and hash = v_hash) then
    if not public.rate_limit_hit('scene_codes', 300, 3600) then
      raise exception 'Too many 3D scenes in a short time. Try again later.' using errcode = 'P0001';
    end if;
    insert into public.scene_codes (user_id, hash, code) values (v_user, v_hash, p_code)
      on conflict do nothing;
  end if;
  return v_hash;
end;
$$;


--
-- Name: schedule_approval_holds(public.schedule_slots); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_approval_holds(p_slot public.schedule_slots) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from public.approvals a
    where a.id = p_slot.approval_id and a.ref_kind = 'schedule_slot' and a.ref_id = p_slot.id
      and a.status in ('approved', 'edited')
      and a.content_hash = public.approval_hash(public.approval_snapshot('schedule_slot', p_slot.id)))
$$;


--
-- Name: schedule_candidate_times(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_candidate_times(p_user uuid, p_platform text) RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (select array_agg(to_char(make_time(b.hour, 0, 0), 'HH24:MI') order by b.median_views_per_hour desc, b.hour)
     from (select * from public.best_slots where user_id = p_user and platform = p_platform
           order by median_views_per_hour desc, hour
           limit greatest(1, jsonb_array_length(public.schedule_rules()->'platforms'->p_platform->'times'))) b),
    (select array_agg(t) from jsonb_array_elements_text(public.schedule_rules()->'platforms'->p_platform->'times') t)
  )
$$;


--
-- Name: schedule_change(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_change(p_slot uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS public.approvals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_slot public.schedule_slots;
  v_rules jsonb := public.schedule_rules();
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_at timestamptz;
  v_account public.social_accounts;
  v_row public.approvals;
begin
  select * into v_slot from public.schedule_slots where id = p_slot and user_id = v_user for update;
  if not found then
    raise exception 'Slot not found.' using errcode = 'P0002';
  end if;
  if v_slot.status not in ('proposed', 'waiting', 'failed') then
    raise exception 'This post is already on its way.' using errcode = 'P0001';
  end if;
  case p_action
    when 'change_time' then
      begin
        v_at := (v_payload->>'publish_at')::timestamptz;
      exception when others then
        v_at := null;
      end;
      if v_at is null or v_payload->>'publish_at' !~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
        raise exception 'Pick a time, with its time zone.' using errcode = '22023';
      end if;
      if v_at < now() + interval '5 minutes' or v_at > now() + interval '60 days' then
        raise exception 'Pick a time between five minutes and 60 days from now.' using errcode = '22023';
      end if;
      if public.schedule_day_count(v_user, v_slot.platform, v_at, v_slot.id)
         >= (v_rules->'platforms'->v_slot.platform->>'dailyCap')::integer then
        raise exception 'That day already has % posts on %.', (v_rules->'platforms'->v_slot.platform->>'dailyCap'),
          public.schedule_platform_label(v_slot.platform) using errcode = 'P0001';
      end if;
      v_slot.publish_at := v_at;
      v_slot.window_ends_at := v_at + make_interval(mins => (v_rules->>'windowMinutes')::integer);
      v_slot.jitter_seconds := public.schedule_jitter();
    when 'change_account' then
      if v_payload->>'account_id' is null then
        v_slot.account_id := null;
        v_slot.mode := 'intent';
      else
        select * into v_account from public.social_accounts
        where id::text = v_payload->>'account_id' and user_id = v_user and platform = v_slot.platform and status = 'connected';
        if not found then
          raise exception 'Choose one of your connected % accounts.', public.schedule_platform_label(v_slot.platform)
            using errcode = '22023';
        end if;
        v_slot.account_id := v_account.id;
        v_slot.mode := 'publish';
      end if;
    when 'set_options' then
      v_slot.options := public.schedule_options_merge(v_slot.platform, v_slot.options, v_payload->'options');
      if octet_length(v_slot.options::text) > 1024 then
        raise exception 'The platform settings are too long.' using errcode = '22023';
      end if;
    else
      raise exception 'Choose a new time, another account or the platform settings.' using errcode = '22023';
  end case;
  begin
    update public.schedule_slots
    set publish_at = v_slot.publish_at, window_ends_at = v_slot.window_ends_at, jitter_seconds = v_slot.jitter_seconds,
        account_id = v_slot.account_id, mode = v_slot.mode, options = v_slot.options,
        status = 'proposed', error = null, updated_at = now()
    where id = v_slot.id;
  exception when unique_violation then
    raise exception 'This post already has another time on %.', public.schedule_platform_label(v_slot.platform)
      using errcode = 'P0001';
  end;
  perform public.approval_raise(v_user, 'schedule_slot', v_slot.id);
  select * into v_row from public.approvals where ref_kind = 'schedule_slot' and ref_id = v_slot.id and status = 'waiting';
  return v_row;
end;
$_$;


--
-- Name: schedule_claim_due(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_claim_due() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_slot public.schedule_slots;
  v_root public.work_orders;
  v_order public.work_orders;
  v_missed integer := 0;
  v_fired integer := 0;
  v_reminded integer := 0;
  v_failed integer := 0;
  v_unconfirmed integer := 0;
begin
  -- Never late: past its window, a slot that has not started posting is missed.
  for v_slot in
    select s.* from public.schedule_slots s
    where s.status in ('proposed', 'waiting', 'due') and s.window_ends_at <= now() and not public.cmo_paused(s.user_id)
    order by s.publish_at limit 200
    for update skip locked
  loop
    perform public.schedule_miss(v_slot, case when v_slot.status = 'proposed' then null
      else 'It could not go out within its time window.' end);
    v_missed := v_missed + 1;
  end loop;

  for v_slot in
    select s.* from public.schedule_slots s
    where s.status = 'waiting' and s.publish_at + make_interval(secs => s.jitter_seconds) <= now()
      and now() < s.window_ends_at and not public.cmo_paused(s.user_id)
    order by s.publish_at limit 100
    for update skip locked
  loop
    -- Approved, then changed (the words, the video, the account): never post what the founder did not see.
    if not public.schedule_approval_holds(v_slot) then
      perform public.schedule_miss(v_slot, 'It changed after you approved it.');
      v_missed := v_missed + 1;
      continue;
    end if;
    -- No connected account: the founder posts it. Their card (copy and open, "I posted it") comes now and waits for
    -- them, unlike a time card: the words are theirs to post whenever they get to it.
    if v_slot.mode = 'intent' then
      perform public.publish_status(v_slot.id, 'intent');
      update public.approvals set expires_at = null
      where ref_kind = 'schedule_slot' and ref_id = v_slot.id and status = 'waiting';
      v_reminded := v_reminded + 1;
      continue;
    end if;
    begin
      v_root := public.work_order_week_root(v_slot.user_id);
      v_order := public.work_order_create(v_slot.user_id, v_root.week, v_root.id, 'publish_post',
        'Post on ' || public.schedule_platform_label(v_slot.platform),
        jsonb_build_object('objective', 'Post the approved ' || public.schedule_platform_label(v_slot.platform) || ' post at its time.',
          'slot_id', v_slot.id),
        0, v_slot.window_ends_at, '{}', 'event', null, 'publish');
      perform public.cmo_enqueue(v_slot.user_id, 'publish_post',
        jsonb_build_object('slot_id', v_slot.id, 'order_id', v_order.id, 'source', 'event'));
      -- The lease lasts as long as the window: nothing else claims it, and it never fires after.
      update public.schedule_slots set status = 'due', lease_until = window_ends_at, updated_at = now() where id = v_slot.id;
      v_fired := v_fired + 1;
    exception when others then
      update public.schedule_slots
      set status = 'failed', updated_at = now(),
          error = jsonb_build_object('code', 'not_started', 'message', left('It could not start: ' || sqlerrm, 500))
      where id = v_slot.id;
      perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
      v_failed := v_failed + 1;
    end;
  end loop;

  -- Zernio took a post but never confirmed it an hour after its window: say so, and never post it again by ourselves.
  -- Its card waits for the founder (no expiry): "It went out" or a new time, never a blind Retry.
  for v_slot in
    select s.* from public.schedule_slots s
    where s.status = 'publishing' and s.window_ends_at + interval '1 hour' <= now()
    for update skip locked
  loop
    update public.schedule_slots
    set status = 'failed', lease_until = null, updated_at = now(),
        error = jsonb_build_object('code', 'unconfirmed', 'retryable', false,
          'message', 'We could not confirm it went out. Check your account before posting it again.')
    where id = v_slot.id;
    perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
    update public.approvals set expires_at = null
    where ref_kind = 'schedule_slot' and ref_id = v_slot.id and status = 'waiting';
    v_unconfirmed := v_unconfirmed + 1;
  end loop;

  return jsonb_build_object('fired', v_fired, 'reminded', v_reminded, 'missed', v_missed, 'failed', v_failed,
    'unconfirmed', v_unconfirmed);
end;
$$;


--
-- Name: schedule_content(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_content(p_deliverable uuid, p_platform text) RETURNS jsonb
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
  v_thread jsonb;
begin
  select * into v_d from public.deliverables where id = p_deliverable;
  if not found then
    return null;
  end if;
  if v_d.ref_kind = 'content_item' then
    select coalesce(body->>'text', ''), case when public.thread_valid(body) then body->'thread' end
    into v_text, v_thread from public.content_items where id = v_d.ref_id;
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
        || case when v_image is not null then jsonb_build_object('image', v_image->>'object') else '{}'::jsonb end
        || case when v_thread is not null then jsonb_build_object('thread', v_thread) else '{}'::jsonb end))
      || case when v_image is not null then jsonb_build_object('image', v_image) else '{}'::jsonb end
      || case when v_thread is not null then jsonb_build_object('thread', v_thread) else '{}'::jsonb end;
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


--
-- Name: schedule_day_count(uuid, text, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_day_count(p_user uuid, p_platform text, p_at timestamp with time zone, p_except uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select count(*)::integer from public.schedule_slots
  where user_id = p_user and platform = p_platform and id is distinct from p_except
    and status in ('proposed', 'waiting', 'due', 'reminded', 'publishing', 'published')
    and (publish_at at time zone public.schedule_timezone(p_user))::date
      = (p_at at time zone public.schedule_timezone(p_user))::date
$$;


--
-- Name: schedule_follow_content(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_follow_content() RETURNS trigger
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


--
-- Name: schedule_follow_deliverable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_follow_deliverable() RETURNS trigger
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


--
-- Name: schedule_image_changed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_image_changed(p_post uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: schedule_jitter(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_jitter() RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$ select (round((random() * 2 - 1) * (public.schedule_rules()->>'jitterSeconds')::integer))::integer $$;


--
-- Name: schedule_mark_posted(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_mark_posted(p_slot uuid) RETURNS public.approvals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_slot public.schedule_slots;
  v_d public.deliverables;
  v_row public.approvals;
begin
  select * into v_slot from public.schedule_slots where id = p_slot and user_id = v_user for update;
  if not found then
    raise exception 'Slot not found.' using errcode = 'P0002';
  end if;
  if v_slot.status <> 'published' then
    -- A post the founder posted themselves, or one we could not confirm that they checked is live.
    if not ((v_slot.mode = 'intent' and v_slot.status in ('failed', 'reminded'))
            or (v_slot.status = 'failed' and v_slot.error->>'code' = 'unconfirmed')) then
      raise exception 'Only a post you copy and post yourself can be marked as posted.' using errcode = 'P0001';
    end if;
    update public.schedule_slots
    set status = 'published', published_at = now(), lease_until = null, error = null, updated_at = now()
    where id = v_slot.id;
    perform public.approval_close('schedule_slot', v_slot.id, 'approved');
    select * into v_d from public.deliverables where id = v_slot.deliverable_id;
    if v_d.ref_kind = 'content_item' then
      update public.content_items set status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
      where id = v_d.ref_id and user_id = v_user and status <> 'published';
    end if;
  end if;
  select * into v_row from public.approvals
  where ref_kind = 'schedule_slot' and ref_id = v_slot.id order by created_at desc limit 1;
  return v_row;
end;
$$;


--
-- Name: schedule_miss(public.schedule_slots, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_miss(p_slot public.schedule_slots, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_new public.schedule_slots;
begin
  update public.schedule_slots
  set status = 'missed', lease_until = null, updated_at = now(),
      error = case when p_reason is null then error else jsonb_build_object('code', 'missed', 'message', p_reason) end
  where id = p_slot.id;
  update public.approvals set status = 'expired', decided_at = now()
  where ref_kind = 'schedule_slot' and ref_id = p_slot.id and status = 'waiting';
  begin
    perform public.schedule_propose(p_slot.deliverable_id);
    -- The new card says why it asks again (the slot keeps it in `last_error`).
    if p_reason is not null then
      for v_new in select * from public.schedule_slots
        where deliverable_id = p_slot.deliverable_id and platform = p_slot.platform and status = 'proposed' and id <> p_slot.id
      loop
        update public.schedule_slots set error = jsonb_build_object('code', 'missed', 'message', p_reason) where id = v_new.id;
        perform public.approval_raise(v_new.user_id, 'schedule_slot', v_new.id);
      end loop;
    end if;
  exception when others then
    raise warning 'schedule: could not propose again for slot %: %', p_slot.id, sqlerrm;
  end;
end;
$$;


--
-- Name: schedule_options_merge(text, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_options_merge(p_platform text, p_current jsonb, p_new jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
declare
  v_key text;
  v_value jsonb;
begin
  if p_new is null or jsonb_typeof(p_new) <> 'object' then
    raise exception 'The platform settings are malformed.' using errcode = '22023';
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_new) loop
    if v_key not in ('privacy', 'allow_comment', 'allow_duet', 'allow_stitch', 'brand_organic', 'brand_content', 'ai_label') then
      raise exception 'Unknown platform setting "%".', left(v_key, 40) using errcode = '22023';
    end if;
    if v_key <> 'ai_label' and p_platform <> 'tiktok' then
      raise exception 'That setting is only for TikTok.' using errcode = '22023';
    end if;
    if v_key = 'privacy' then
      if jsonb_typeof(v_value) <> 'string' or v_value #>> '{}' not in
         ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY') then
        raise exception 'Choose who can see it from TikTok''s list.' using errcode = '22023';
      end if;
    elsif jsonb_typeof(v_value) <> 'boolean' then
      raise exception 'A platform toggle is on or off.' using errcode = '22023';
    end if;
  end loop;
  return coalesce(p_current, '{}'::jsonb) || p_new;
end;
$$;


--
-- Name: schedule_pick_time(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_pick_time(p_user uuid, p_platform text, p_deliverable uuid) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_rules jsonb := public.schedule_rules();
  v_tz text := public.schedule_timezone(p_user);
  v_gap interval := make_interval(hours => (v_rules->>'minGapHours')::integer);
  v_earliest timestamptz := now() + make_interval(mins => (v_rules->>'leadMinutes')::integer);
  v_cap integer := (v_rules->'platforms'->p_platform->>'dailyCap')::integer;
  v_today date := (now() at time zone v_tz)::date;
  v_times text[] := public.schedule_candidate_times(p_user, p_platform);
  v_parent uuid;
  v_day integer;
  v_time text;
  v_at timestamptz;
begin
  if v_cap is null then
    return null;
  end if;
  select c.parent_clip_id into v_parent
  from public.deliverables d join public.clips c on c.id = d.ref_id
  where d.id = p_deliverable and d.ref_kind = 'clip';
  for v_day in 0 .. (v_rules->>'horizonDays')::integer loop
    foreach v_time in array v_times loop
      v_at := ((v_today + v_day) + v_time::time) at time zone v_tz;
      continue when v_at < v_earliest;
      continue when exists (select 1 from public.schedule_slots
        where user_id = p_user and platform = p_platform
          and status in ('proposed', 'waiting', 'due', 'reminded', 'publishing', 'published')
          and publish_at > v_at - v_gap and publish_at < v_at + v_gap);
      continue when public.schedule_day_count(p_user, p_platform, v_at, null) >= v_cap;
      continue when v_parent is not null and exists (select 1 from public.schedule_slots s
        join public.deliverables d on d.id = s.deliverable_id
        where s.user_id = p_user and s.platform = p_platform and d.ref_kind = 'clip' and d.ref_id = v_parent
          and s.status in ('proposed', 'waiting', 'due', 'reminded', 'publishing', 'published')
          and (s.publish_at at time zone v_tz)::date = (v_at at time zone v_tz)::date);
      return v_at;
    end loop;
  end loop;
  return null;
end;
$$;


--
-- Name: schedule_platform_label(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_platform_label(p_platform text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_platform when 'x' then 'X' when 'threads' then 'Threads' when 'linkedin' then 'LinkedIn'
    when 'tiktok' then 'TikTok' when 'instagram' then 'Instagram' when 'youtube' then 'YouTube' else p_platform end
$$;


--
-- Name: schedule_propose(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_propose(p_deliverable uuid) RETURNS integer
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


--
-- Name: schedule_ready_check(public.schedule_slots); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_ready_check(p_slot public.schedule_slots) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_slot.mode = 'intent' then
    if p_slot.platform in ('tiktok', 'instagram', 'youtube') then
      raise exception 'Connect your % account to post this.', public.schedule_platform_label(p_slot.platform)
        using errcode = 'P0001';
    end if;
    return;
  end if;
  if not exists (select 1 from public.social_accounts where id = p_slot.account_id and status = 'connected') then
    raise exception 'Reconnect your % account first.', public.schedule_platform_label(p_slot.platform) using errcode = 'P0001';
  end if;
  if p_slot.platform = 'tiktok' and jsonb_typeof(p_slot.options->'privacy') is distinct from 'string' then
    raise exception 'Choose who can see it on TikTok.' using errcode = 'P0001';
  end if;
end;
$$;


--
-- Name: schedule_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_rules() RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select '{"minGapHours": 3, "windowMinutes": 15, "leadMinutes": 30, "horizonDays": 14, "maxProposals": 3, "jitterSeconds": 240, "platforms": {"x": {"times": ["09:00"], "dailyCap": 5}, "threads": {"times": ["09:00", "12:00"], "dailyCap": 2}, "linkedin": {"times": ["16:00"], "dailyCap": 1}, "tiktok": {"times": ["09:00", "13:00"], "dailyCap": 2}, "instagram": {"times": ["09:00"], "dailyCap": 1}, "youtube": {"times": ["16:00", "19:00"], "dailyCap": 2}}}'::jsonb $$;


--
-- Name: schedule_timezone(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_timezone(p_user uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select coalesce((select timezone from public.profiles where id = p_user), 'UTC') $$;


--
-- Name: send_feedback(text, text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_feedback(p_category text, p_summary text, p_details text DEFAULT NULL::text, p_severity text DEFAULT NULL::text, p_clip_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_id uuid;
begin
  if p_category is null or p_category not in ('missing_capability', 'wrong_result', 'confusing_ux', 'failure', 'suggestion') then
    raise exception 'Unknown feedback category.' using errcode = '22023';
  end if;
  if p_summary is null or btrim(p_summary) = '' or char_length(p_summary) > 300 then
    raise exception 'Write a one-line summary under 300 characters.' using errcode = '22023';
  end if;
  if p_details is not null and char_length(p_details) > 4000 then
    raise exception 'Feedback details are longer than 4000 characters.' using errcode = '22023';
  end if;
  if p_severity is not null and p_severity not in ('low', 'medium', 'high') then
    raise exception 'Unknown feedback severity.' using errcode = '22023';
  end if;
  -- Clip của người khác: bỏ liên kết, không báo lỗi (phản hồi vẫn có giá trị).
  if p_clip_id is not null and not exists (
    select 1 from public.clips c join public.jobs j on j.id = c.job_id where c.id = p_clip_id and j.user_id = v_user
  ) then
    p_clip_id := null;
  end if;
  if not public.rate_limit_hit('feedback', 20, 3600) then
    raise exception 'Too much feedback in a short time. Try again later.' using errcode = 'P0001';
  end if;
  insert into public.editor_feedback (user_id, clip_id, category, summary, details, severity)
  values (v_user, p_clip_id, p_category, btrim(p_summary), nullif(btrim(coalesce(p_details, '')), ''), p_severity)
  returning id into v_id;
  return v_id;
end;
$$;


--
-- Name: set_default_brand_kit(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_default_brand_kit(p_id uuid) RETURNS public.brand_kits
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.brand_kits;
begin
  if not exists(select 1 from public.brand_kits where id = p_id and user_id = v_user) then
    raise exception 'Brand kit not found.' using errcode = 'P0002';
  end if;
  update public.brand_kits set is_default = false where user_id = v_user and is_default and id <> p_id;
  update public.brand_kits set is_default = true where id = p_id returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: set_job_storage_expiry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_job_storage_expiry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if new.status::text in ('done', 'failed', 'cancelled')
     and new.status is distinct from old.status then
    new.expires_at := coalesce(new.finished_at, now()) + interval '7 days';
  elsif new.status::text in ('queued', 'running')
        and old.status::text in ('done', 'failed', 'cancelled') then
    -- A retry needs a fresh window so the cron does not clean the source mid-run.
    new.expires_at := now() + interval '7 days';
  end if;
  return new;
end;
$$;


--
-- Name: set_project_pinned(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_project_pinned(p_job_id uuid, p_pinned boolean) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_user uuid:=public.require_user(); v_job public.jobs;
begin
  update public.jobs set pinned=coalesce(p_pinned,false) where id=p_job_id and user_id=v_user returning * into v_job;
  if not found then raise exception 'Project not found.' using errcode='P0002'; end if;
  return v_job;
end; $$;


--
-- Name: settle_job_credits(uuid, numeric, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_job_credits(p_job_id uuid, p_duration_seconds numeric, p_operation_key text DEFAULT NULL::text, p_attempt_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid;
  v_status public.job_status;
  v_attempt uuid;
  v_prev jsonb;
  v_ok boolean;
  v_spent int;
  v_actual int;
  v_diff int;
begin
  select user_id into v_user from public.jobs where id = p_job_id;
  if v_user is null then
    raise exception 'No such job: %', p_job_id;
  end if;

  perform public.lock_credit_owner(v_user);

  if p_operation_key is not null then
    select result into v_prev
    from public.worker_operations where operation_key = p_operation_key;
    if found then
      return (v_prev->>'ok')::boolean;
    end if;
  end if;

  select status, attempt_id into v_status, v_attempt
  from public.jobs where id = p_job_id;

  if v_status <> 'running'
     or (p_attempt_id is not null and v_attempt is distinct from p_attempt_id) then
    v_ok := null;
  else
    -- 1 credit = 1 phút nguồn, làm tròn lên. Video 30 giây vẫn tính 1 phút.
    v_actual := greatest(1, ceil(coalesce(p_duration_seconds, 0) / 60.0)::int);
    v_spent := public.job_credits_spent(p_job_id);
    v_diff := v_actual - v_spent;
    v_ok := true;

    if v_diff > 0 and public.credit_balance(v_user) < v_diff then
      perform public.credit_refund(v_user, 'job', p_job_id, 'Refund: not enough credits for the real length', p_job_id);
      v_ok := false;
    elsif v_diff <> 0 then
      -- đang giữ − số thật = −v_diff.
      perform public.credit_settle(v_user, 'job', p_job_id, v_actual, 'Adjusted to real video length', p_job_id);
    end if;
  end if;

  if p_operation_key is not null then
    insert into public.worker_operations (operation_key, job_id, kind, result)
    values (p_operation_key, p_job_id, 'settle', jsonb_build_object('ok', v_ok));
  end if;

  return v_ok;
end;
$$;


--
-- Name: short_batch_create(uuid, text, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.short_batch_create(p_parent_clip_id uuid, p_parent_hash text, p_order_id uuid, p_shorts jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_parent public.clips := public.owned_clip(p_parent_clip_id, v_user);
  v_project public.editor_projects;
  v_batch uuid;
  v_item jsonb;
  v_clip uuid;
  v_short uuid;
  v_idx integer;
  v_out jsonb := '[]'::jsonb;
  v_start numeric;
  v_end numeric;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  if v_parent.kind = 'short' then
    raise exception 'A short is not cut into shorts.' using errcode = 'P0001';
  end if;
  select * into v_project from public.editor_projects where clip_id = p_parent_clip_id for update;
  if not found or p_parent_hash is null or v_project.finished_hash is distinct from p_parent_hash
     or p_parent_hash is distinct from public.editor_document_hash(v_project.document) then
    raise exception 'This edit changed after it was marked finished. Mark it finished again to cut shorts.' using errcode = 'P0001';
  end if;
  if p_order_id is not null and not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_shorts is null or jsonb_typeof(p_shorts) <> 'array' or jsonb_array_length(p_shorts) not between 1 and 3 then
    raise exception 'A batch has 1 to 3 shorts.' using errcode = '22023';
  end if;
  -- One batch at a time per finished version: a retry of the same cut does not double it.
  if exists (select 1 from public.short_batches where parent_clip_id = p_parent_clip_id and parent_hash = p_parent_hash
             and status not in ('sent_back', 'failed', 'cancelled')) then
    raise exception 'Shorts are already being cut from this version.' using errcode = 'P0001';
  end if;
  -- Short edits take the next free negative index of the parent's job (uploads use 0 and up, blank edits -1).
  perform 1 from public.jobs where id = v_parent.job_id for update;
  insert into public.short_batches (user_id, parent_clip_id, parent_hash, order_id, status)
  values (v_user, p_parent_clip_id, p_parent_hash, p_order_id, 'rendering')
  returning id into v_batch;
  for v_item in select * from jsonb_array_elements(p_shorts) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item->'document') is distinct from 'object'
       or jsonb_typeof(v_item->'source_start') is distinct from 'number' or jsonb_typeof(v_item->'source_end') is distinct from 'number'
       or char_length(coalesce(v_item->>'hook', '')) not between 1 and 120
       or char_length(coalesce(v_item->>'title', '')) not between 1 and 60
       or char_length(coalesce(v_item->>'reason', '')) not between 1 and 300 then
      raise exception 'A short needs its range, hook, title, reason and edit.' using errcode = '22023';
    end if;
    v_start := (v_item->>'source_start')::numeric;
    v_end := (v_item->>'source_end')::numeric;
    v_idx := (select least(coalesce(min(idx), 0), -1) - 1 from public.clips where job_id = v_parent.job_id);
    insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, kind, parent_clip_id)
    values (v_parent.job_id, v_idx, v_item->>'title', 0, v_end - v_start, 'short', p_parent_clip_id)
    returning id into v_clip;
    insert into public.editor_projects (clip_id, document, manifest)
    values (v_clip, v_item->'document', v_project.manifest);
    -- Edited and voice-over transcripts are stored per clip: the short's captions read the parent's.
    insert into public.editor_transcripts (clip_id, hash, body)
    select v_clip, t.hash, t.body from public.editor_transcripts t
    where t.clip_id = p_parent_clip_id
      and t.hash in (select (regexp_matches((v_item->'document')::text, 'assets/transcripts/([0-9a-f]{64})\.json', 'g'))[1])
    on conflict do nothing;
    insert into public.shorts (user_id, batch_id, parent_clip_id, short_clip_id, source_start, source_end, hook, reason, status)
    values (v_user, v_batch, p_parent_clip_id, v_clip, v_start, v_end, v_item->>'hook', v_item->>'reason', 'rendering')
    returning id into v_short;
    v_out := v_out || jsonb_build_array(jsonb_build_object('short_id', v_short, 'short_clip_id', v_clip));
  end loop;
  return jsonb_build_object('batch_id', v_batch, 'shorts', v_out);
end;
$$;


--
-- Name: short_batch_settle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.short_batch_settle(p_batch_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: short_render_refused(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.short_render_refused(p_short_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_short public.shorts;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  select * into v_short from public.shorts where id = p_short_id and user_id = v_user for update;
  if not found then
    raise exception 'Short not found.' using errcode = 'P0002';
  end if;
  if v_short.status <> 'rendering' then
    return;
  end if;
  update public.shorts set status = 'failed' where id = v_short.id;
  perform public.short_batch_settle(v_short.batch_id);
end;
$$;


--
-- Name: signup_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signup_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 0 $$;


--
-- Name: slice_transcript(jsonb, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.slice_transcript(p_body jsonb, p_in numeric, p_out numeric) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select coalesce(jsonb_agg(segment order by ord), '[]'::jsonb)
  from (
    select s.ord,
      case when kept.total = kept.n then s.seg
           else jsonb_build_object('text', kept.text, 'words', kept.words) end as segment
    from jsonb_array_elements(p_body) with ordinality as s(seg, ord)
    cross join lateral (
      select count(*) filter (where (w ->> 'start')::numeric >= p_in and (w ->> 'start')::numeric < p_out) as n,
             count(*) as total,
             coalesce(jsonb_agg(w order by wi) filter (where (w ->> 'start')::numeric >= p_in and (w ->> 'start')::numeric < p_out), '[]'::jsonb) as words,
             string_agg(w ->> 'text', ' ' order by wi) filter (where (w ->> 'start')::numeric >= p_in and (w ->> 'start')::numeric < p_out) as text
      from jsonb_array_elements(s.seg -> 'words') with ordinality as x(w, wi)
    ) kept
    where kept.n > 0
  ) parts;
$$;


--
-- Name: snapshot_editor_revision(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_editor_revision(p_clip_id uuid, p_document_hash text) RETURNS public.editor_revisions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
  v_latest public.editor_revisions;
  v_number int;
  v_revision public.editor_revisions;
begin
  if p_document_hash is null or p_document_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row
  from public.editor_projects p
  where p.clip_id = p_clip_id
  for update;

  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;

  if public.editor_document_hash(v_row.document) <> p_document_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  select r.* into v_latest
  from public.editor_revisions r
  where r.clip_id = p_clip_id and r.kind = 'export'
  order by r.number desc
  limit 1;

  if found and v_latest.source_hash = p_document_hash then
    return v_latest;
  end if;

  select coalesce(max(r.number), 0) + 1 into v_number
  from public.editor_revisions r
  where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind)
  values (p_clip_id, v_number, p_document_hash, v_row.document, 'export')
  returning * into v_revision;

  return v_revision;
end;
$_$;


--
-- Name: snapshot_editor_variant(uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_editor_variant(p_clip_id uuid, p_document_hash text, p_document jsonb, p_label text) RETURNS public.editor_revisions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_row public.editor_projects;
  v_hash text;
  v_number int;
  v_revision public.editor_revisions;
begin
  if p_document_hash is null or p_document_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid project fingerprint.' using errcode = '22023';
  end if;
  if p_label is null or char_length(trim(p_label)) = 0 or char_length(p_label) > 200 then
    raise exception 'An export version needs a short label.' using errcode = '22023';
  end if;
  if not public.editor_document_shape_ok(p_document) or octet_length(p_document::text) >= 262144 then
    raise exception 'This version of the project could not be read.' using errcode = '22023';
  end if;

  perform public.owned_clip(p_clip_id, v_user);

  select p.* into v_row from public.editor_projects p where p.clip_id = p_clip_id for update;
  if not found then
    raise exception 'This clip has no editor project yet.' using errcode = 'P0002';
  end if;
  if public.editor_document_hash(v_row.document) <> p_document_hash then
    raise exception 'This project changed while it was being exported. Try again.'
      using errcode = 'P0409', detail = public.editor_json(p_clip_id)::text;
  end if;

  v_hash := public.editor_document_hash(p_document);
  select coalesce(max(r.number), 0) + 1 into v_number from public.editor_revisions r where r.clip_id = p_clip_id;

  insert into public.editor_revisions (clip_id, number, source_hash, document, kind, label)
  values (p_clip_id, v_number, v_hash, p_document, 'export', trim(p_label))
  returning * into v_revision;
  return v_revision;
end;
$_$;


--
-- Name: social_account_mark(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.social_account_mark(p_zernio_account_id text, p_status text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_account public.social_accounts;
  v_slot public.schedule_slots;
  v_n integer := 0;
begin
  if p_status not in ('connected', 'disconnected', 'error') then
    raise exception 'Unknown account status.' using errcode = '22023';
  end if;
  update public.social_accounts set status = p_status, updated_at = now()
  where zernio_account_id = p_zernio_account_id returning * into v_account;
  if v_account.id is null or p_status = 'connected' then
    return 0;
  end if;
  for v_slot in select * from public.schedule_slots where account_id = v_account.id and status = 'waiting' for update loop
    update public.schedule_slots set status = 'proposed', updated_at = now() where id = v_slot.id;
    perform public.approval_raise(v_slot.user_id, 'schedule_slot', v_slot.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;


--
-- Name: social_account_remove(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.social_account_remove(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_slots uuid[];
  v_slot uuid;
begin
  if not exists (select 1 from public.social_accounts where id = p_id and user_id = v_user) then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  -- Its slots not yet posting ask again without it: copy and open where the platform allows, else "connect it".
  with moved as (
    update public.schedule_slots
    set account_id = null, mode = 'intent', status = 'proposed', updated_at = now()
    where account_id = p_id and user_id = v_user and status in ('proposed', 'waiting')
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_slots from moved;
  delete from public.social_accounts where id = p_id and user_id = v_user;
  foreach v_slot in array v_slots loop
    perform public.approval_raise(v_user, 'schedule_slot', v_slot);
  end loop;
end;
$$;


--
-- Name: social_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text DEFAULT 'zernio'::text NOT NULL,
    platform text NOT NULL,
    handle text NOT NULL,
    avatar_url text,
    zernio_account_id text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_accounts_avatar_url_check CHECK (((avatar_url ~ '^https://'::text) AND (char_length(avatar_url) <= 1000))),
    CONSTRAINT social_accounts_handle_check CHECK (((char_length(handle) >= 1) AND (char_length(handle) <= 100))),
    CONSTRAINT social_accounts_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'threads'::text, 'linkedin'::text, 'tiktok'::text, 'youtube'::text, 'instagram'::text]))),
    CONSTRAINT social_accounts_provider_check CHECK ((provider = 'zernio'::text)),
    CONSTRAINT social_accounts_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'error'::text]))),
    CONSTRAINT social_accounts_zernio_account_id_check CHECK (((char_length(zernio_account_id) >= 1) AND (char_length(zernio_account_id) <= 100)))
);


--
-- Name: social_account_save(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.social_account_save(p_user uuid, p_platform text, p_handle text, p_avatar_url text, p_zernio_account_id text) RETURNS public.social_accounts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.social_accounts;
begin
  if not exists (select 1 from public.zernio_profiles where user_id = p_user) then
    raise exception 'Connect starts with a Zernio profile.' using errcode = 'P0001';
  end if;
  insert into public.social_accounts (user_id, platform, handle, avatar_url, zernio_account_id)
  values (p_user, p_platform, left(trim(p_handle), 100), nullif(trim(coalesce(p_avatar_url, '')), ''), p_zernio_account_id)
  on conflict (user_id, platform) do update
    set handle = excluded.handle, avatar_url = excluded.avatar_url, zernio_account_id = excluded.zernio_account_id,
        status = 'connected', connected_at = case when social_accounts.zernio_account_id = excluded.zernio_account_id
          then social_accounts.connected_at else now() end,
        updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: start_cmo_run(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_cmo_run(p_kind text, p_input jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_runs;
begin
  if p_kind is distinct from 'onboard' then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':cmo_run', 1713));

  update public.cmo_runs set status = 'failed', error = 'Timed out.', finished_at = now()
  where user_id = v_user and kind = 'onboard' and status = 'running' and created_at < now() - interval '10 minutes';

  if exists(select 1 from public.cmo_runs where user_id = v_user and kind = p_kind and status = 'running') then
    raise exception 'Your marketing plan is already being built. Give it a minute.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.cmo_runs
      where user_id = v_user and kind = p_kind and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You can rebuild your plan 5 times a day. Try again tomorrow, or edit the documents directly.' using errcode = 'P0001';
  end if;

  insert into public.cmo_runs (user_id, kind, input) values (v_user, p_kind, p_input) returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: store_transcript_slice(uuid, jsonb, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.store_transcript_slice(p_clip_id uuid, p_body jsonb, p_in numeric, p_out numeric) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_body text := public.slice_transcript(p_body, p_in, p_out)::text;
  v_hash text;
begin
  perform public.check_transcript_body(v_body);
  v_hash := encode(sha256(convert_to(v_body, 'UTF8')), 'hex');
  insert into public.editor_transcripts (clip_id, hash, body)
  values (p_clip_id, v_hash, v_body)
  on conflict (clip_id, hash) do nothing;
  return v_hash;
end;
$$;


--
-- Name: studio_brain_call(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_brain_call() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
begin
  return coalesce(auth.jwt()->>'opencmo_actor', '') = 'brain';
end;
$$;


--
-- Name: studio_look_sendback_unchanged(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_look_sendback_unchanged(p_check uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_check public.look_checks;
begin
  update public.look_checks set status = 'failed', settled_at = now()
  where id = p_check and status = 'claimed'
  returning * into v_check;
  if not found then
    return false;
  end if;
  perform public.look_check_raise(v_check);
  return true;
end;
$$;


--
-- Name: studio_look_sendbacks_claim(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_look_sendbacks_claim(p_limit integer) RETURNS TABLE(check_id uuid, ref_kind text, ref_id uuid, user_id uuid, order_id uuid, look jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_order_move(uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_order_move(p_id uuid, p_to text, p_text text DEFAULT NULL::text, p_error jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_status text := (select status from public.work_orders where id = p_id and kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image'));
begin
  if v_status is null or v_status in ('done', 'failed', 'cancelled') or v_status = p_to then
    return;
  end if;
  -- A card waits on the founder (a batch card raised while the runner was still finishing): it stays waiting. An
  -- approved card goes back to work through the claims' `running`, never straight to `waiting_order`.
  if p_to = 'waiting_order' and v_status = 'waiting_founder' then
    return;
  end if;
  if p_to = 'waiting_founder' then
    perform public.work_order_wait_founder(p_id, p_text);
  elsif p_to in ('waiting_order', 'running') then
    if v_status <> 'running' then
      perform public.work_order_move(p_id, 'running');
    end if;
    if p_to = 'waiting_order' then
      perform public.work_order_move(p_id, 'waiting_order', p_text);
    end if;
  elsif p_to = 'failed' then
    perform public.work_order_move(p_id, 'failed', p_text, p_error);
  else
    raise exception 'The order runner cannot move an order to %.', p_to using errcode = '22023';
  end if;
end;
$$;


--
-- Name: work_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    root_id uuid,
    parent_id uuid,
    week date NOT NULL,
    depends_on uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    department text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    brief jsonb DEFAULT '{}'::jsonb NOT NULL,
    budget_credits integer DEFAULT 0 NOT NULL,
    spent_credits integer DEFAULT 0 NOT NULL,
    due_at timestamp with time zone,
    status text DEFAULT 'queued'::text NOT NULL,
    error jsonb,
    done_reason text,
    run_id uuid,
    item_id uuid,
    created_by text DEFAULT 'loop'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT work_orders_brief_check CHECK (((jsonb_typeof(brief) = 'object'::text) AND (octet_length((brief)::text) <= 4096))),
    CONSTRAINT work_orders_budget_credits_check CHECK ((budget_credits >= 0)),
    CONSTRAINT work_orders_check CHECK (((parent_id IS NULL) = ((root_id IS NULL) OR (root_id = id)))),
    CONSTRAINT work_orders_created_by_check CHECK ((created_by = ANY (ARRAY['loop'::text, 'chat'::text, 'event'::text, 'mcp'::text, 'founder'::text]))),
    CONSTRAINT work_orders_department_check CHECK ((department = ANY (ARRAY['brain'::text, 'research'::text, 'writer'::text, 'studio'::text, 'sales'::text, 'schedule'::text, 'publish'::text]))),
    CONSTRAINT work_orders_depends_on_check CHECK ((cardinality(depends_on) <= 20)),
    CONSTRAINT work_orders_done_reason_check CHECK ((char_length(done_reason) <= 200)),
    CONSTRAINT work_orders_error_check CHECK (((error IS NULL) OR ((jsonb_typeof(error) = 'object'::text) AND (error ? 'code'::text) AND (error ? 'message'::text) AND (octet_length((error)::text) <= 2048)))),
    CONSTRAINT work_orders_kind_check CHECK ((kind ~ '^[a-z_]{1,40}$'::text)),
    CONSTRAINT work_orders_spent_credits_check CHECK ((spent_credits >= 0)),
    CONSTRAINT work_orders_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_founder'::text, 'waiting_order'::text, 'deferred'::text, 'done'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT work_orders_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT work_orders_week_check CHECK ((EXTRACT(isodow FROM week) = (1)::numeric))
);


--
-- Name: studio_orders_claim(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_orders_claim(p_order uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 3) RETURNS SETOF public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_id uuid;
begin
  for v_id in
    select o.id from public.work_orders o
    where o.status = 'queued' and o.kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image') and (p_order is null or o.id = p_order)
      and not public.cmo_paused(o.user_id)
      and not exists (select 1 from unnest(o.depends_on) d(id) left join public.work_orders w on w.id = d.id
                      where w.status is distinct from 'done')
    order by o.created_at
    limit greatest(1, least(coalesce(p_limit, 3), 10))
    for update skip locked
  loop
    return next public.work_order_move(v_id, 'running');
  end loop;
end;
$$;


--
-- Name: studio_post_image_rendering(uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_post_image_rendering(p_order_id uuid, p_clip_id uuid, p_post_id uuid, p_stills_task uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_post_image_settle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_post_image_settle(p_step uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_record_usage(uuid, text, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_record_usage(p_order_id uuid, p_model text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_total bigint;
  v_credits integer;
  v_held integer;
  v_charge integer;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user and kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image')) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_input is null or p_output is null or p_cache_read is null or p_cache_write is null
     or least(p_input, p_output, p_cache_read, p_cache_write) < 0 then
    raise exception 'Invalid usage.' using errcode = '22023';
  end if;
  perform public.lock_credit_owner(v_user);
  insert into public.work_order_usage (user_id, order_id, model, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, micro_usd)
  values (v_user, p_order_id, left(coalesce(nullif(p_model, ''), 'unknown'), 64), p_input, p_output, p_cache_read, p_cache_write,
    public.agent_micro_usd(p_model, p_input, p_output, p_cache_read, p_cache_write));
  select coalesce(sum(micro_usd), 0)::bigint into v_total from public.work_order_usage where order_id = p_order_id;
  v_credits := public.agent_credits(v_total);
  v_held := public.credit_held('work_order', p_order_id);
  if v_credits > v_held then
    v_charge := least(v_credits - v_held, greatest(public.credit_balance(v_user), 0));
    if v_charge > 0 then
      perform public.credit_settle(v_user, 'work_order', p_order_id, v_held + v_charge, 'CMO video team usage');
      perform public.work_order_spend(p_order_id, v_charge);
    end if;
  end if;
  return v_credits;
end;
$$;


--
-- Name: studio_slideshow_fresh(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_slideshow_fresh() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.kind = 'slideshow' and old.status = 'waiting' and new.status = 'done' and new.input ? 'mp4_task'
     and (select settings_hash from public.tasks where id = (new.input->>'mp4_task')::uuid)
       is distinct from (select public.editor_document_hash(document) from public.editor_projects where clip_id = new.clip_id) then
    raise exception 'The slideshow changed since it was rendered. Render it again.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;


--
-- Name: studio_slideshow_rendering(uuid, uuid, jsonb, jsonb, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_slideshow_rendering(p_order_id uuid, p_clip_id uuid, p_input jsonb, p_card jsonb, p_mp4_task uuid, p_stills_task uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_slideshow_rerender(uuid, uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_slideshow_rerender(p_step uuid, p_mp4_task uuid, p_stills_task uuid, p_card jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_slideshow_settle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_slideshow_settle(p_step uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: studio_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    clip_id uuid NOT NULL,
    tool text NOT NULL,
    kind text NOT NULL,
    input jsonb NOT NULL,
    card jsonb NOT NULL,
    price_credits integer NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    order_id uuid,
    redo_of uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decision text,
    decision_payload jsonb,
    generation_id uuid,
    next jsonb,
    wait_for uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    next_done_at timestamp with time zone,
    plan_input jsonb,
    claimed_at timestamp with time zone,
    CONSTRAINT studio_steps_card_check CHECK (((jsonb_typeof(card) = 'object'::text) AND (octet_length((card)::text) <= 32768))),
    CONSTRAINT studio_steps_decision_check CHECK ((decision = ANY (ARRAY['approve'::text, 'edit'::text, 'redo'::text, 'cancel'::text]))),
    CONSTRAINT studio_steps_decision_payload_check CHECK (((decision_payload IS NULL) OR ((jsonb_typeof(decision_payload) = 'object'::text) AND (octet_length((decision_payload)::text) <= 2048)))),
    CONSTRAINT studio_steps_error_check CHECK ((char_length(error) <= 500)),
    CONSTRAINT studio_steps_input_check CHECK (((jsonb_typeof(input) = 'object'::text) AND (octet_length((input)::text) <= 65536))),
    CONSTRAINT studio_steps_kind_check CHECK ((kind = ANY (ARRAY['script'::text, 'price'::text, 'slideshow'::text, 'post_image'::text]))),
    CONSTRAINT studio_steps_next_check CHECK (((next IS NULL) OR ((jsonb_typeof(next) = 'object'::text) AND (next ? 'tool'::text) AND (octet_length((next)::text) <= 65536)))),
    CONSTRAINT studio_steps_plan_input_check CHECK (((plan_input IS NULL) OR ((jsonb_typeof(plan_input) = 'object'::text) AND (octet_length((plan_input)::text) <= 65536)))),
    CONSTRAINT studio_steps_price_credits_check CHECK ((price_credits >= 0)),
    CONSTRAINT studio_steps_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'approved'::text, 'running'::text, 'done'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT studio_steps_tool_check CHECK ((tool ~ '^[a-z_]{1,40}$'::text)),
    CONSTRAINT studio_steps_wait_for_check CHECK ((cardinality(wait_for) <= 60))
);


--
-- Name: studio_step_finish(uuid, text, text, uuid, jsonb, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_step_finish(p_id uuid, p_status text, p_error text DEFAULT NULL::text, p_generation_id uuid DEFAULT NULL::uuid, p_next jsonb DEFAULT NULL::jsonb, p_wait_for uuid[] DEFAULT NULL::uuid[]) RETURNS public.studio_steps
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.studio_steps;
  v_ok boolean;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  select * into v_row from public.studio_steps where id = p_id and user_id = v_user for update;
  if not found then
    raise exception 'Step not found.' using errcode = 'P0002';
  end if;
  if v_row.status = p_status and p_next is null then
    return v_row;
  end if;
  v_ok := v_row.status = p_status or case v_row.status
    when 'waiting' then p_status = 'cancelled'
    when 'approved' then p_status in ('running', 'done', 'failed', 'cancelled')
    when 'running' then p_status in ('done', 'failed', 'cancelled')
    else false end;
  if not coalesce(v_ok, false) then
    raise exception 'A step cannot go from % to %.', v_row.status, p_status using errcode = 'P0001';
  end if;
  if p_status = 'failed' and nullif(trim(coalesce(p_error, '')), '') is null then
    raise exception 'A failed step needs its error.' using errcode = '22023';
  end if;
  if p_next is not null and (jsonb_typeof(p_next) <> 'object' or not p_next ? 'tool') then
    raise exception 'The next step is malformed.' using errcode = '22023';
  end if;
  -- A next step is set once, when the step itself runs: never on a step already done, failed or cancelled.
  if p_next is not null and v_row.status not in ('approved', 'running') then
    raise exception 'This step has already run.' using errcode = 'P0001';
  end if;
  -- The week's "credits used": what the step starts spending, recorded once as it leaves `approved` (a decide that
  -- failed spent nothing). A redone keyframe costs what its generation holds.
  if v_row.status = 'approved' and p_status in ('running', 'done') and v_row.order_id is not null then
    if v_row.decision = 'approve' then
      perform public.work_order_spend(v_row.order_id, v_row.price_credits);
    elsif v_row.decision = 'redo' and p_generation_id is not null then
      perform public.work_order_spend(v_row.order_id,
        coalesce((select credits_reserved from public.generations where id = p_generation_id and user_id = v_user), 0));
    end if;
  end if;
  if p_wait_for is not null and exists (select 1 from unnest(p_wait_for) w(id)
      where not exists (select 1 from public.generations g where g.id = w.id and g.user_id = v_user)) then
    raise exception 'A step only waits on the founder''s own generations.' using errcode = '22023';
  end if;
  update public.studio_steps
  set status = p_status,
      decision = case when v_row.status = 'waiting' then 'cancel' else decision end,
      decided_at = coalesce(decided_at, now()),
      error = case when p_status = 'failed' then left(p_error, 500) else error end,
      generation_id = coalesce(p_generation_id, generation_id),
      next = coalesce(p_next, next),
      wait_for = coalesce(p_wait_for, wait_for),
      next_done_at = case when p_next is not null then null else next_done_at end
  where id = p_id
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: studio_step_plan_input(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_step_plan_input(p_id uuid, p_input jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ update public.studio_steps set plan_input = p_input where id = p_id and plan_input is null $$;


--
-- Name: studio_step_raise(uuid, text, text, jsonb, jsonb, integer, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_step_raise(p_clip_id uuid, p_tool text, p_kind text, p_input jsonb, p_card jsonb, p_price_credits integer, p_order_id uuid DEFAULT NULL::uuid, p_redo_of uuid DEFAULT NULL::uuid) RETURNS public.studio_steps
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.studio_steps;
begin
  if not public.studio_brain_call() then
    raise exception 'Only OpenCMO''s Studio team can do this.' using errcode = '42501';
  end if;
  perform public.owned_clip(p_clip_id, v_user);
  if p_tool is null or p_tool not in ('generate_media', 'add_3d_scene', 'add_voiceover', 'replace_background',
      'create_video', 'animate_video', 'redo_keyframe', 'edit_video', 'add_explainer', 'plan_video', 'request_export',
      'add_captions', 'translate_captions') then
    raise exception 'This Studio tool is not priced on a card.' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('script', 'price') or (p_kind = 'script' and p_tool not in ('create_video', 'plan_video')) then
    raise exception 'Only a storyboard is a script card.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or p_card is null or jsonb_typeof(p_card) <> 'object' then
    raise exception 'This step is malformed.' using errcode = '22023';
  end if;
  -- A price card always says how long the video is (a redone keyframe too: the video it belongs to).
  if (p_kind = 'script' and jsonb_typeof(p_card->'beats') is distinct from 'array')
     or (p_kind = 'price' and (jsonb_typeof(p_card->'seconds') is distinct from 'number' or (p_card->>'seconds')::numeric <= 0
       or (p_card ? 'keyframes' and jsonb_typeof(p_card->'keyframes') <> 'array'))) then
    raise exception 'This step is malformed.' using errcode = '22023';
  end if;
  if p_price_credits is null or p_price_credits < 0 then
    raise exception 'A step needs its price.' using errcode = '22023';
  end if;
  if p_order_id is not null and not exists (select 1 from public.work_orders where id = p_order_id and user_id = v_user) then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_redo_of is not null and not exists (
      select 1 from public.studio_steps where id = p_redo_of and user_id = v_user and clip_id = p_clip_id) then
    raise exception 'The step this replaces was not found.' using errcode = 'P0002';
  end if;
  -- Cards are few by design (approval.md rule 3); a loop raising cards without end stops here.
  if (select count(*) from public.studio_steps where user_id = v_user and status = 'waiting') >= 20 then
    raise exception 'Too many Studio cards are waiting. Decide some first.' using errcode = 'P0001';
  end if;
  insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, redo_of)
  values (v_user, p_clip_id, p_tool, p_kind, p_input, p_card, p_price_credits, p_order_id, p_redo_of)
  returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: studio_steps_claim(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_steps_claim(p_limit integer DEFAULT 5) RETURNS SETOF public.studio_steps
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


--
-- Name: studio_steps_ready(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_steps_ready(p_limit integer DEFAULT 5) RETURNS SETOF public.studio_steps
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.studio_steps;
begin
  for v_row in
    select s.* from public.studio_steps s
    join public.work_orders o on o.id = s.order_id
    where s.next is not null and s.next_done_at is null and o.status not in ('done', 'failed', 'cancelled')
      and not public.cmo_paused(s.user_id)
      and not exists (select 1 from unnest(s.wait_for) w(id) join public.generations g on g.id = w.id
                      where g.status in ('queued', 'running'))
    order by s.decided_at
    limit greatest(1, least(coalesce(p_limit, 5), 10))
    for update of s skip locked
  loop
    update public.studio_steps set next_done_at = now(), status = case when status = 'running' then 'done' else status end
    where id = v_row.id returning * into v_row;
    return next v_row;
  end loop;
end;
$$;


--
-- Name: studio_steps_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_steps_sync() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    perform public.approval_close('studio_step', old.id, 'cancelled');
    return old;
  end if;
  if new.status = 'waiting' then
    perform public.approval_raise(new.user_id, 'studio_step', new.id);
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'waiting' then
    return new;
  end if;
  perform public.approval_close('studio_step', new.id, case new.decision
    when 'approve' then 'approved' when 'edit' then 'edited' when 'redo' then 'edited' when 'cancel' then 'skipped'
    else 'cancelled' end);
  return new;
end;
$$;


--
-- Name: studio_video_budget(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_video_budget() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 60 $$;


--
-- Name: studio_work_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.studio_work_count() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select (
    (select count(*) from public.work_orders o where o.status = 'queued' and o.kind in ('build_video', 'cut_shorts', 'build_slideshow', 'build_post_image')
       and not public.cmo_paused(o.user_id)
       and not exists (select 1 from unnest(o.depends_on) d(id) left join public.work_orders w on w.id = d.id
                       where w.status is distinct from 'done'))
    + (select count(*) from public.studio_steps s join public.work_orders o on o.id = s.order_id
       where s.status = 'approved' and o.status not in ('done', 'failed', 'cancelled') and not public.cmo_paused(s.user_id)
         and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes'))
    + (select count(*) from public.studio_steps s join public.work_orders o on o.id = s.order_id
       where s.next is not null and s.next_done_at is null and o.status not in ('done', 'failed', 'cancelled')
         and not public.cmo_paused(s.user_id)
         and not exists (select 1 from unnest(s.wait_for) w(id) join public.generations g on g.id = w.id
                         where g.status in ('queued', 'running')))
  )::integer
$$;


--
-- Name: sync_asset_transcript_from_task(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_asset_transcript_from_task() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.kind <> 'transcribe_asset' or new.asset_id is null or new.status is not distinct from old.status then
    return new;
  end if;
  update public.media_assets
  set transcript_status = case new.status
    when 'running' then 'running'
    when 'queued' then 'queued'
    when 'done' then 'ready'
    else 'failed' end
  where id = new.asset_id and transcript_status <> 'ready';
  return new;
end;
$$;


--
-- Name: sync_generation_from_task(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_generation_from_task() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_generation public.generations;
begin
  if new.kind <> 'generate' or new.status is not distinct from old.status then
    return new;
  end if;
  select * into v_generation from public.generations where task_id = new.id for update;
  if not found or v_generation.status in ('done', 'failed', 'cancelled') then
    return new;
  end if;
  if new.status = 'running' then
    update public.generations set status = 'running' where id = v_generation.id;
  elsif new.status = 'queued' then
    update public.generations set status = 'queued' where id = v_generation.id;
  elsif new.status = 'cancelled' and v_generation.sent_at is not null then
    -- The worker sent the paid request (`mark_generation_sent`, right before the provider call):
    -- cancelling stops the result, not the bill. Until then nothing was paid, so a cancel while the
    -- worker downloads or checks inputs is refunded below, and so is one after a reclaim that never
    -- reached the provider; a reclaimed task that had reached it keeps its credits even when queued.
    update public.generations
    set status = 'cancelled',
        credits_final = greatest(public.credit_held('generation', v_generation.id), 0),
        error = null,
        finished_at = now()
    where id = v_generation.id;
    update public.tasks
    set status = 'failed', error = 'The shot before this one did not finish. Your credits were refunded.',
        finished_at = now()
    where status = 'awaiting_input'
      and id in (select task_id from public.generations where after_id = v_generation.id);
  elsif new.status in ('failed', 'cancelled') then
    update public.generations
    set status = new.status,
        credits_final = 0,
        -- Lỗi chung của vòng lặp worker và của reclaim nói về "Rendering";
        -- người dùng đang sinh media, không render — thay bằng câu đúng việc.
        error = case when new.status = 'failed' then
          case when new.error is null or new.error ilike 'Rendering%'
            then 'Generation failed. Your credits were refunded.'
            else left(new.error, 500) end
        end,
        finished_at = now()
    where id = v_generation.id;
    perform public.credit_refund(v_generation.user_id, 'generation', v_generation.id, 'Generate refund', v_generation.job_id);
    -- Shots waiting to continue this one can never start: fail them too. Each runs this
    -- trigger in turn, so they are refunded and their own children follow.
    update public.tasks
    set status = 'failed', error = 'The shot before this one did not finish. Your credits were refunded.',
        finished_at = now()
    where status = 'awaiting_input'
      and id in (select task_id from public.generations where after_id = v_generation.id);
  end if;
  return new;
end;
$$;


--
-- Name: sync_page_capture_from_task(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_page_capture_from_task() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.kind <> 'capture_page' or new.status is not distinct from old.status
     or new.status not in ('failed', 'cancelled') then
    return new;
  end if;
  update public.page_captures
  set status = 'failed', finished_at = now(),
      error = left(coalesce(nullif(new.error, ''), 'That page could not be opened.'), 500)
  where task_id = new.id and status = 'pending';
  return new;
end;
$$;


--
-- Name: sync_profile_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_profile_email() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;


--
-- Name: task_progress(uuid, uuid, real); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.task_progress(p_task_id uuid, p_attempt_id uuid, p_progress real) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with touched as (
    update public.tasks
    set progress = least(1, greatest(0, p_progress))
    where id = p_task_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;


--
-- Name: tasks_look_check_settle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tasks_look_check_settle() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: tasks_studio_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tasks_studio_rules() RETURNS trigger
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


--
-- Name: thread_valid(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.thread_valid(p_body jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select jsonb_typeof(p_body->'thread') = 'array'
    and jsonb_array_length(p_body->'thread') between 5 and 8
    and not exists (select 1 from jsonb_array_elements(p_body->'thread') p
                    where jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') not between 1 and 280)
    and p_body->'thread'->>0 = p_body->>'text';
$$;


--
-- Name: upload_reservation_allows(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upload_reservation_allows(p_bucket text, p_name text, p_metadata jsonb) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(
    select 1 from public.upload_reservations r
    where r.user_id = auth.uid() and r.bucket = p_bucket and r.object_name = p_name
      and r.status = 'reserved' and r.expires_at > now()
  );
$$;


--
-- Name: upload_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upload_usage() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
declare
  v_user uuid := public.require_user(); v_plan text; v_limits record;
  v_bytes bigint; v_objects bigint;
begin
  select coalesce(plan, 'free') into v_plan from public.profiles where id = v_user;
  select * into v_limits from public.plan_usage_limits(v_plan);
  select coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0), count(*)
    into v_bytes, v_objects from storage.objects
    where bucket_id in ('sources','media','exports')
      and (storage.foldername(name))[1] = v_user::text;
  return jsonb_build_object('bytes', v_bytes, 'limit', v_limits.stored_bytes,
    'objects', v_objects, 'objectLimit', v_limits.stored_objects);
end;
$$;


--
-- Name: use_media_transcript(uuid, uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.use_media_transcript(p_clip_id uuid, p_media_id uuid, p_source_in numeric DEFAULT 0, p_source_out numeric DEFAULT NULL::numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_clip public.clips;
  v_asset public.media_assets;
  v_body text;
  v_in numeric;
  v_out numeric;
  v_hash text;
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  select * into v_asset from public.media_assets
  where id = p_media_id and user_id = v_user and job_id = v_clip.job_id
    and status <> 'rejected' and storage_path like 'media/%';
  if not found then
    raise exception 'This file is not stored with this project. Wait for it to finish uploading.' using errcode = 'P0002';
  end if;
  select body into v_body from public.media_transcripts where asset_id = v_asset.id;
  if v_body is null then
    return jsonb_build_object('status', case when v_asset.transcript_status in ('queued', 'running') then 'pending' else 'none' end);
  end if;
  v_in := greatest(0, coalesce(p_source_in, 0));
  v_out := coalesce(p_source_out, v_asset.duration, 1e9);
  if v_out <= v_in then
    raise exception 'Choose a longer part of the file.' using errcode = '22023';
  end if;
  v_hash := public.store_transcript_slice(p_clip_id, v_body::jsonb, v_in, v_out);
  return jsonb_build_object('status', 'ready', 'hash', v_hash, 'src', 'assets/transcripts/' || v_hash || '.json');
end;
$$;


--
-- Name: validate_reserved_upload_object(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_reserved_upload_object() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_size bigint := coalesce((new.metadata->>'size')::bigint, 0); v_res public.upload_reservations;
begin
  if new.bucket_id not in ('sources','media','exports') or v_size <= 0 then return new; end if;
  select * into v_res from public.upload_reservations
    where bucket=new.bucket_id and object_name=new.name and status='reserved' and expires_at>now();
  if not found then return new; end if;
  if v_size > v_res.declared_size
     or coalesce(new.metadata->>'mimetype',new.metadata->>'contentType','') not like 'video/%' then
    raise exception 'Upload does not match its reservation.' using errcode='22023';
  end if;
  return new;
end;
$$;


--
-- Name: voice_edit_phrase(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_edit_phrase(p_mode text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_mode
    when 'TOO_SALESY' then 'toned down the selling'
    when 'WRONG_VOICE' then 'rewrote it in their own voice'
    when 'INVENTED_CLAIM' then 'removed a claim that was not true'
    when 'TOO_LONG' then 'cut it shorter'
    when 'HOOK_REWRITTEN' then 'rewrote the first line'
    when 'CTA_REMOVED' then 'removed the closing ask'
    when 'FULL_REWRITE' then 'rewrote it'
    else null end
$$;


--
-- Name: voice_note_add(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_note_add(p_outcome_id uuid) RETURNS public.cmo_memories
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
begin
  select user_id into v_owner from public.cmo_draft_outcomes where id = p_outcome_id;
  if v_owner is null
     or (v_user is not null and v_owner <> v_user)
     or (v_user is null and coalesce(auth.role(), '') <> 'service_role') then
    raise exception 'Decision not found.' using errcode = 'P0002';
  end if;
  return public.voice_note_write(p_outcome_id);
end;
$$;


--
-- Name: voice_note_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_note_cap() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 60 $$;


--
-- Name: voice_note_days(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_note_days() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 60 $$;


--
-- Name: voice_note_delete(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_note_delete(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_outcome uuid;
begin
  delete from public.cmo_memories where id = p_id and user_id = v_user and source_outcome is not null
  returning source_outcome into v_outcome;
  if not found then
    raise exception 'Voice note not found.' using errcode = 'P0002';
  end if;
  update public.cmo_draft_outcomes set voice_note_deleted_at = now() where id = v_outcome;
end;
$$;


--
-- Name: voice_note_write(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_note_write(p_outcome uuid, p_reason text DEFAULT NULL::text) RETURNS public.cmo_memories
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_o public.cmo_draft_outcomes;
  v_item public.content_items;
  v_label text;
  v_body text;
  v_row public.cmo_memories;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into v_o from public.cmo_draft_outcomes where id = p_outcome;
  if not found or v_o.department <> 'post' or v_o.voice_note_deleted_at is not null then
    return null;
  end if;
  select * into v_row from public.cmo_memories where source_outcome = p_outcome;
  if found then
    return v_row;
  end if;
  select * into v_item from public.content_items where id = v_o.item_id and user_id = v_o.user_id;
  if not found then
    return null;
  end if;
  v_label := coalesce(public.platform_profile(coalesce(v_o.platform, 'x'))->>'label', 'X');
  v_body := case
    when v_o.action = 'skip' and v_reason is not null then
      'Skipped a draft on ' || v_label || ' about "' || left(v_item.idea, 120) || '": ' || v_reason
    when v_o.action = 'approve' and v_item.final_text is not null
         and (v_o.edit_mode = 'NO_MEANINGFUL_EDIT' or v_o.similarity >= public.cmo_as_written()) then
      'Approved as written on ' || v_label || ': "' || v_item.final_text || '"'
    when v_o.action = 'approve' and v_item.final_text is not null and public.voice_edit_phrase(v_o.edit_mode) is not null then
      'Edited on ' || v_label || ' before approving (' || public.voice_edit_phrase(v_o.edit_mode) || '): "'
        || v_item.final_text || '"'
    end;
  if v_body is null then
    return null;
  end if;
  insert into public.cmo_memories (user_id, type, kind, topic, importance, body, source_outcome, expires_at, created_at)
  values (v_o.user_id, 'agent', 'preference', 'post', 1, left(v_body, 600), p_outcome,
    now() + make_interval(days => public.voice_note_days()), now())
  on conflict (source_outcome) where source_outcome is not null do nothing
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.cmo_memories where source_outcome = p_outcome;
    return v_row;
  end if;
  -- Over the cap, the oldest notes go: they weigh least anyway.
  delete from public.cmo_memories where id in (
    select id from public.cmo_memories where user_id = v_o.user_id and source_outcome is not null
    order by created_at desc, id offset public.voice_note_cap());
  return v_row;
end;
$$;


--
-- Name: voice_notes(integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_notes(p_limit integer DEFAULT 20, p_platform text DEFAULT NULL::text) RETURNS TABLE(id uuid, body text, platform text, source text, edit_mode text, created_at timestamp with time zone, expires_at timestamp with time zone, weight real)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select * from public.voice_notes_of(public.require_user(), p_limit, p_platform) $$;


--
-- Name: voice_notes_for(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_notes_for(p_user uuid, p_limit integer DEFAULT 20, p_platform text DEFAULT NULL::text) RETURNS TABLE(id uuid, body text, platform text, source text, edit_mode text, created_at timestamp with time zone, expires_at timestamp with time zone, weight real)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ select * from public.voice_notes_of(p_user, p_limit, p_platform) $$;


--
-- Name: voice_notes_of(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_notes_of(p_user uuid, p_limit integer, p_platform text) RETURNS TABLE(id uuid, body text, platform text, source text, edit_mode text, created_at timestamp with time zone, expires_at timestamp with time zone, weight real)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select m.id, m.body, o.platform,
    case when o.action = 'skip' then 'skipped'
      when o.edit_mode = 'NO_MEANINGFUL_EDIT' or o.similarity >= public.cmo_as_written() then 'approved'
      else 'edited' end,
    case when o.edit_mode = 'NO_MEANINGFUL_EDIT' then null else o.edit_mode end,
    m.created_at, m.expires_at,
    greatest(0, least(1, extract(epoch from (m.expires_at - now()))
      / nullif(extract(epoch from (m.expires_at - m.created_at)), 0)))::real
  from public.cmo_memories m
  join public.cmo_draft_outcomes o on o.id = m.source_outcome
  where m.user_id = p_user and m.expires_at > now() and (p_platform is null or o.platform = p_platform)
  order by m.created_at desc, m.id
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;


--
-- Name: work_order_create(uuid, date, uuid, text, text, jsonb, integer, timestamp with time zone, uuid[], text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_create(p_user uuid, p_week date, p_parent uuid, p_kind text, p_title text, p_brief jsonb DEFAULT '{}'::jsonb, p_budget integer DEFAULT 0, p_due timestamp with time zone DEFAULT NULL::timestamp with time zone, p_depends_on uuid[] DEFAULT '{}'::uuid[], p_created_by text DEFAULT 'loop'::text, p_item uuid DEFAULT NULL::uuid, p_department text DEFAULT NULL::text) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_parent public.work_orders;
  v_row public.work_orders;
  v_free integer;
begin
  if p_parent is not null then
    select * into v_parent from public.work_orders where id = p_parent and user_id = p_user for update;
    if not found then
      raise exception 'Parent order not found.' using errcode = 'P0002';
    end if;
    v_free := v_parent.budget_credits - v_parent.spent_credits - coalesce((
      select sum(budget_credits - spent_credits) from public.work_orders
      where parent_id = p_parent and status not in ('done', 'failed', 'cancelled')), 0);
    if coalesce(p_budget, 0) > 0 and p_budget > v_free then
      raise exception 'The parent order has % credits left to hand out.', greatest(v_free, 0) using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from unnest(coalesce(p_depends_on, '{}')) d(id)
             where not exists (select 1 from public.work_orders o where o.id = d.id and o.user_id = p_user)) then
    raise exception 'An order can only wait on the founder''s own orders.' using errcode = '22023';
  end if;
  insert into public.work_orders (user_id, root_id, parent_id, week, depends_on, department, kind, title, brief,
    budget_credits, due_at, created_by, item_id)
  values (p_user, coalesce(v_parent.root_id, v_parent.id), p_parent, coalesce(v_parent.week, p_week),
    coalesce(p_depends_on, '{}'), coalesce(p_department, public.work_order_department(p_kind)), p_kind,
    left(coalesce(nullif(trim(p_title), ''), p_kind), 200), coalesce(p_brief, '{}'::jsonb), coalesce(p_budget, 0),
    p_due, p_created_by, p_item)
  returning * into v_row;
  if p_parent is null then
    update public.work_orders set root_id = id where id = v_row.id returning * into v_row;
  end if;
  perform public.work_order_event(v_row, 'created', 'Planned “' || v_row.title || '”');
  return v_row;
end;
$$;


--
-- Name: work_order_department(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_department(p_kind text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select case p_kind
    when 'post_draft' then 'writer' when 'sales_scan' then 'sales'
    when 'competitor_research' then 'research' when 'pull_metrics' then 'research' when 'review_week' then 'research'
    when 'build_video' then 'studio' when 'cut_shorts' then 'studio' when 'build_slideshow' then 'studio' when 'build_post_image' then 'studio'
    when 'niche_video_research' then 'research'
    when 'publish_post' then 'publish' when 'write_caption' then 'writer' when 'write_video_brief' then 'writer' when 'write_slides' then 'writer'
    else 'brain' end
$$;


--
-- Name: work_order_event(public.work_orders, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_event(p_order public.work_orders, p_kind text, p_text text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into public.work_order_events (user_id, order_id, department, kind, text)
  values (p_order.user_id, p_order.id, p_order.department, p_kind, left(p_text, 200))
$$;


--
-- Name: work_order_finish_run(public.cmo_runs, public.work_orders); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_finish_run(p_run public.cmo_runs, p_order public.work_orders) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_ref record;
  v_target public.work_orders;
  v_targets uuid[] := array[p_order.id];
  v_refunded boolean := coalesce((p_run.output->>'refund')::boolean, false);
begin
  if p_run.status = 'failed' then
    -- Only an order the run was linked to for sure fails with it. A guessed planned order goes back to the queue:
    -- failing it could blame the wrong calendar item.
    if p_order.item_id is not null and not (p_run.input ? 'order_id') then
      update public.work_orders set run_id = null where id = p_order.id;
      perform public.work_order_move(p_order.id, 'queued',
        'A ' || replace(p_run.kind, '_', ' ') || ' run failed: ' || left(coalesce(p_run.error, 'Something went wrong.'), 120));
      return;
    end if;
    perform public.work_order_move(p_order.id, 'failed', null,
      jsonb_build_object('code', 'run_failed', 'message', left(coalesce(p_run.error, 'Something went wrong.'), 300),
        'retryable', true, 'repair_hint', null));
    return;
  end if;
  for v_ref in
    select 'post' as kind, 'content_item' as ref_kind, id, status = 'in_review' as waiting, id as item_id
      from public.content_items where run_id = p_run.id and department = 'post' and status <> 'planned'
    union all select 'reply', 'opportunity', id, status = 'in_review', null::uuid from public.opportunities where run_id = p_run.id
    union all select 'insight', 'insight', id, false, null::uuid from public.cmo_insights where run_id = p_run.id
  loop
    select * into v_target from public.work_orders where item_id = v_ref.item_id and v_ref.item_id is not null limit 1;
    if not found then
      v_target := p_order;
    end if;
    insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status)
    values (p_run.user_id, v_target.id, v_ref.kind, v_ref.ref_kind, v_ref.id, case when v_ref.waiting then 'waiting_founder' else 'ready' end)
    on conflict (ref_kind, ref_id) do nothing;
    if v_target.id <> p_order.id then
      update public.work_orders set run_id = p_run.id, updated_at = now() where id = v_target.id and run_id is null;
      v_targets := v_targets || v_target.id;
    end if;
  end loop;
  if not v_refunded and p_run.credits > 0 then
    perform public.work_order_spend(p_order.id, p_run.credits);
  end if;
  for v_target in select * from public.work_orders where id = any(v_targets) and status not in ('done', 'failed', 'cancelled') loop
    if v_target.status = 'queued' and exists (select 1 from public.deliverables where order_id = v_target.id) then
      v_target := public.work_order_move(v_target.id, 'running');
    end if;
    if exists (select 1 from public.deliverables where order_id = v_target.id and status = 'waiting_founder') then
      perform public.work_order_move(v_target.id, 'waiting_founder');
    elsif exists (select 1 from public.deliverables where order_id = v_target.id) then
      perform public.work_order_move(v_target.id, 'done');
    elsif v_target.id = p_order.id and cardinality(v_targets) = 1 then
      perform public.work_order_move(v_target.id, 'done', null, null,
        coalesce(left(p_run.output->>'reason', 200), 'Finished with nothing to approve this time.'));
    end if;
  end loop;
  -- The guess went to another order: this one is free for the next run of its kind.
  if exists (select 1 from public.work_orders where id = p_order.id and status = 'running') then
    update public.work_orders set run_id = null where id = p_order.id;
    perform public.work_order_move(p_order.id, 'queued');
  end if;
end;
$$;


--
-- Name: work_order_for_run(public.cmo_runs); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_for_run(p_run public.cmo_runs) RETURNS public.work_orders
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


--
-- Name: work_order_mark_replanned(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_mark_replanned(p_id uuid, p_problem text) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.work_orders;
begin
  select * into v_row from public.work_orders where id = p_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_row.brief ? 'replanned_at' then
    raise exception 'This order was already replanned once.' using errcode = 'P0001';
  end if;
  if v_row.status not in ('failed', 'done', 'cancelled') then
    v_row := public.work_order_move(p_id, 'failed', null,
      jsonb_build_object('code', 'stuck', 'message', left(coalesce(p_problem, 'No progress.'), 300), 'retryable', true,
        'repair_hint', 'Plan around it with a different item.'));
  end if;
  update public.work_orders set brief = brief || jsonb_build_object('replanned_at', now()), updated_at = now()
  where id = p_id returning * into v_row;
  perform public.work_order_event(v_row, 'note', 'Asked the Planner to replan “' || v_row.title || '”');
  return v_row;
end;
$$;


--
-- Name: work_order_move(uuid, text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_move(p_id uuid, p_to text, p_text text DEFAULT NULL::text, p_error jsonb DEFAULT NULL::jsonb, p_reason text DEFAULT NULL::text) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.work_orders;
  v_ok boolean;
begin
  select * into v_row from public.work_orders where id = p_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_row.status = p_to then
    return v_row;
  end if;
  v_ok := case v_row.status
    -- `failed` from `queued`: the progress check fails an order that never started before it replans it.
    when 'queued' then p_to in ('running', 'deferred', 'waiting_order', 'failed', 'cancelled')
    when 'running' then p_to in ('waiting_founder', 'waiting_order', 'deferred', 'queued', 'done', 'failed', 'cancelled')
    when 'waiting_founder' then p_to in ('queued', 'running', 'done', 'failed', 'cancelled')
    when 'waiting_order' then p_to in ('queued', 'running', 'done', 'failed', 'cancelled')
    when 'deferred' then p_to in ('queued', 'running', 'done', 'failed', 'cancelled')
    else false end;
  if not v_ok then
    raise exception 'An order cannot go from % to %.', v_row.status, p_to using errcode = 'P0001';
  end if;
  if p_to = 'running' and exists (
    select 1 from unnest(v_row.depends_on) d(id)
    left join public.work_orders o on o.id = d.id
    where o.status is distinct from 'done') then
    raise exception 'This order waits on another order.' using errcode = 'P0001';
  end if;
  if p_to = 'done' and nullif(trim(coalesce(p_reason, '')), '') is null
     and not exists (select 1 from public.deliverables where order_id = p_id) then
    raise exception 'An order is done only with a deliverable or a reason.' using errcode = 'P0001';
  end if;
  if p_to = 'failed' and (p_error is null or not (p_error ? 'code' and p_error ? 'message')) then
    raise exception 'A failed order needs an error code and message.' using errcode = '22023';
  end if;
  update public.work_orders
  set status = p_to,
      error = case when p_to = 'failed' then p_error when p_to in ('queued', 'running') then null else error end,
      done_reason = case when p_to = 'done' then left(nullif(trim(coalesce(p_reason, '')), ''), 200) else done_reason end,
      finished_at = case when p_to in ('done', 'failed', 'cancelled') then now() else null end,
      updated_at = now()
  where id = p_id
  returning * into v_row;
  perform public.work_order_event(v_row, p_to, coalesce(p_text, case p_to
    when 'running' then 'Started “' || v_row.title || '”'
    when 'waiting_founder' then '“' || v_row.title || '” waits on you'
    when 'waiting_order' then '“' || v_row.title || '” waits on another order'
    when 'deferred' then '“' || v_row.title || '” continues later'
    when 'queued' then '“' || v_row.title || '” is queued again'
    when 'done' then 'Finished “' || v_row.title || '”'
    when 'failed' then '“' || v_row.title || '” failed: ' || (p_error->>'message')
    else 'Cancelled “' || v_row.title || '”' end));
  return v_row;
end;
$$;


--
-- Name: work_order_spend(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_spend(p_id uuid, p_credits integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.work_orders;
  v_within boolean := true;
begin
  if p_credits is null or p_credits <= 0 then
    return true;
  end if;
  for v_row in
    with recursive up as (
      select id, parent_id from public.work_orders where id = p_id
      union all
      select o.id, o.parent_id from public.work_orders o join up on o.id = up.parent_id
    )
    update public.work_orders o set spent_credits = o.spent_credits + p_credits, updated_at = now()
    from up where o.id = up.id
    returning o.*
  loop
    if v_row.spent_credits > v_row.budget_credits and v_row.spent_credits - p_credits <= v_row.budget_credits then
      perform public.work_order_event(v_row, 'note',
        'Over budget: “' || v_row.title || '” used ' || v_row.spent_credits || ' of ' || v_row.budget_credits || ' credits');
    end if;
    v_within := v_within and v_row.spent_credits <= v_row.budget_credits;
  end loop;
  return v_within;
end;
$$;


--
-- Name: work_order_wait_founder(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_wait_founder(p_id uuid, p_text text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_status text := (select status from public.work_orders where id = p_id);
begin
  if v_status is null or v_status in ('waiting_founder', 'done', 'failed', 'cancelled') then
    return;
  end if;
  if v_status <> 'running' then
    perform public.work_order_move(p_id, 'running');
  end if;
  perform public.work_order_move(p_id, 'waiting_founder', p_text);
end;
$$;


--
-- Name: work_order_week_root(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_order_week_root(p_user uuid) RETURNS public.work_orders
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_week date := date_trunc('week', current_date)::date;
  v_root public.work_orders;
  v_goal text;
  v_budget integer;
begin
  select * into v_root from public.work_orders where user_id = p_user and week = v_week and parent_id is null for update;
  if found then
    return v_root;
  end if;
  select goal into v_goal from public.cmo_goals where user_id = p_user and week = v_week and status = 'approved';
  select weekly_credit_budget into v_budget from public.profiles where id = p_user;
  return public.work_order_create(p_user, v_week, null, 'plan_week',
    coalesce('Week of ' || to_char(v_week, 'Mon DD') || ': ' || v_goal, 'Week of ' || to_char(v_week, 'Mon DD')),
    jsonb_build_object('objective', coalesce(v_goal, 'Plan and run this week''s marketing.')),
    coalesce(v_budget, 0), (v_week + 7)::timestamptz);
end;
$$;


--
-- Name: work_orders_brief_rules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_orders_brief_rules() RETURNS trigger
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


--
-- Name: work_orders_follow_approval(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_orders_follow_approval() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.work_orders;
  v_ref_kind text := case new.ref_kind when 'content_item' then 'content_item' when 'opportunity' then 'opportunity' end;
begin
  if old.status not in ('waiting', 'held') or new.status in ('waiting', 'held') or v_ref_kind is null then
    return new;
  end if;
  -- A cancelled card is not a decision. `approval_raise` cancels the old card before it inserts the new one, so a
  -- row still in review is getting a fresh card: its deliverable keeps waiting. A row that left review without the
  -- founder (deleted, or back to drafting) sends its order back: cancelled when the row is gone, else queued.
  if new.status = 'cancelled' then
    begin
      if (v_ref_kind = 'content_item' and exists (select 1 from public.content_items where id = new.ref_id and status = 'in_review'))
         or (v_ref_kind = 'opportunity' and exists (select 1 from public.opportunities where id = new.ref_id and status = 'in_review')) then
        return new;
      end if;
      update public.deliverables set status = 'ready' where ref_kind = v_ref_kind and ref_id = new.ref_id;
      for v_order in
        select o.* from public.work_orders o join public.deliverables d on d.order_id = o.id
        where d.ref_kind = v_ref_kind and d.ref_id = new.ref_id and o.status = 'waiting_founder'
      loop
        if not exists (select 1 from public.deliverables where order_id = v_order.id and status = 'waiting_founder') then
          if (v_ref_kind = 'content_item' and not exists (select 1 from public.content_items where id = new.ref_id))
             or (v_ref_kind = 'opportunity' and not exists (select 1 from public.opportunities where id = new.ref_id)) then
            perform public.work_order_move(v_order.id, 'cancelled', 'The draft of “' || v_order.title || '” was deleted');
          else
            update public.work_orders set run_id = null where id = v_order.id;
            perform public.work_order_move(v_order.id, 'queued', '“' || v_order.title || '” went back to drafting');
          end if;
        end if;
      end loop;
    exception when others then
      raise warning 'work orders did not follow card %: %', new.id, sqlerrm;
    end;
    return new;
  end if;
  begin
    update public.deliverables set status = 'decided' where ref_kind = v_ref_kind and ref_id = new.ref_id;
    for v_order in
      select o.* from public.work_orders o join public.deliverables d on d.order_id = o.id
      where d.ref_kind = v_ref_kind and d.ref_id = new.ref_id and o.status = 'waiting_founder'
    loop
      if not exists (select 1 from public.deliverables where order_id = v_order.id and status = 'waiting_founder') then
        perform public.work_order_move(v_order.id, 'done', case new.status
          when 'approved' then 'You approved “' || v_order.title || '”'
          when 'edited' then 'You edited and approved “' || v_order.title || '”'
          when 'skipped' then 'You skipped “' || v_order.title || '”'
          else 'Finished “' || v_order.title || '”' end);
      end if;
    end loop;
  exception when others then
    raise warning 'work orders did not follow card %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;


--
-- Name: work_orders_follow_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_orders_follow_run() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_order public.work_orders;
begin
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;
  -- Orders follow runs; they never hold one back. A fault rolls back only the tree's change.
  begin
    -- A plan run's credits count against the week it planned (its rows are the tree itself, not deliverables).
    if new.kind = 'plan_week' then
      if new.status = 'done' and new.credits > 0 and not coalesce((new.output->>'refund')::boolean, false) then
        select * into v_order from public.work_orders
        where user_id = new.user_id and parent_id is null and week = date_trunc('week', current_date)::date;
        if found then
          perform public.work_order_spend(v_order.id, new.credits);
        end if;
      end if;
      return new;
    end if;
    v_order := public.work_order_for_run(new);
    if v_order.id is null then
      return new;
    end if;
    if new.status = 'running' then
      perform public.work_order_move(v_order.id, 'running');
    elsif new.status = 'queued' and tg_op = 'UPDATE' then
      -- Deferred by the runner (`cmo_defer_run`) or put back after a lost lease.
      if v_order.status = 'running' then
        perform public.work_order_move(v_order.id, 'deferred');
      end if;
    elsif new.status in ('done', 'failed') then
      if v_order.status = 'queued' then
        perform public.work_order_move(v_order.id, 'running');
        v_order.status := 'running';
      end if;
      perform public.work_order_finish_run(new, v_order);
    end if;
  exception when others then
    raise warning 'work orders did not follow run %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;


--
-- Name: work_orders_plan_week(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.work_orders_plan_week(p_user uuid, p_run uuid) RETURNS public.work_orders
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


--
-- Name: write_budget_bytes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.write_budget_bytes() RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
  select 128::bigint * 1024 * 1024;
$$;


--
-- Name: write_budget_rows(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.write_budget_rows(p_table text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_table when 'marketing_documents' then 300 else 1200 end;
$$;


--
-- Name: writer_order_start(public.work_orders, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.writer_order_start(p_order public.work_orders, p_input jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  begin
    perform public.cmo_enqueue(p_order.user_id, p_order.kind, p_input || jsonb_build_object('order_id', p_order.id, 'source', 'event'));
  exception when others then
    perform public.work_order_move(p_order.id, 'failed', null, jsonb_build_object('code', 'not_started',
      'message', left(sqlerrm, 200), 'retryable', true));
  end;
end;
$$;


--
-- Name: zernio_profile_save(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.zernio_profile_save(p_user uuid, p_profile text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.zernio_profiles (user_id, zernio_profile_id) values (p_user, p_profile)
  on conflict (user_id) do nothing;
  if not exists (select 1 from public.zernio_profiles where user_id = p_user and zernio_profile_id = p_profile) then
    raise exception 'This founder already has another Zernio profile.' using errcode = 'P0001';
  end if;
end;
$$;


--
-- Name: zernio_receipt_claim(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.zernio_receipt_claim(p_event_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'The event id is not valid.' using errcode = '22023';
  end if;
  insert into public.zernio_receipts (event_id) values (p_event_id) on conflict do nothing;
  return found;
end;
$$;


--
-- Name: account_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid,
    platform text NOT NULL,
    handle text NOT NULL,
    day date NOT NULL,
    followers bigint,
    impressions bigint,
    engagements bigint,
    video_views bigint,
    posts integer,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_metrics_engagements_check CHECK ((engagements >= 0)),
    CONSTRAINT account_metrics_followers_check CHECK ((followers >= 0)),
    CONSTRAINT account_metrics_handle_check CHECK (((char_length(handle) >= 1) AND (char_length(handle) <= 100))),
    CONSTRAINT account_metrics_impressions_check CHECK ((impressions >= 0)),
    CONSTRAINT account_metrics_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'threads'::text, 'linkedin'::text, 'tiktok'::text, 'youtube'::text, 'instagram'::text]))),
    CONSTRAINT account_metrics_posts_check CHECK ((posts >= 0)),
    CONSTRAINT account_metrics_video_views_check CHECK ((video_views >= 0))
);


--
-- Name: agent_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_messages_content_check CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT agent_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: agent_tool_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    turn_id uuid NOT NULL,
    tool_use_id text NOT NULL,
    name text NOT NULL,
    input jsonb NOT NULL,
    status text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content jsonb,
    CONSTRAINT agent_tool_calls_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 64))),
    CONSTRAINT agent_tool_calls_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT agent_tool_calls_tool_use_id_check CHECK (((char_length(tool_use_id) >= 1) AND (char_length(tool_use_id) <= 128)))
);


--
-- Name: agent_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    turn_id uuid NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cache_read_tokens integer NOT NULL,
    cache_write_tokens integer NOT NULL,
    micro_usd bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_usage_cache_read_tokens_check CHECK ((cache_read_tokens >= 0)),
    CONSTRAINT agent_usage_cache_write_tokens_check CHECK ((cache_write_tokens >= 0)),
    CONSTRAINT agent_usage_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT agent_usage_micro_usd_check CHECK ((micro_usd >= 0)),
    CONSTRAINT agent_usage_output_tokens_check CHECK ((output_tokens >= 0))
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT api_keys_key_hash_check CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT api_keys_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))
);


--
-- Name: best_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.best_slots (
    user_id uuid NOT NULL,
    platform text NOT NULL,
    hour smallint NOT NULL,
    median_views_per_hour double precision NOT NULL,
    posts integer NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT best_slots_hour_check CHECK (((hour >= 0) AND (hour <= 23))),
    CONSTRAINT best_slots_median_views_per_hour_check CHECK ((median_views_per_hour >= (0)::double precision)),
    CONSTRAINT best_slots_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'threads'::text, 'linkedin'::text, 'tiktok'::text, 'youtube'::text, 'instagram'::text]))),
    CONSTRAINT best_slots_posts_check CHECK ((posts >= 1))
);


--
-- Name: caption_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caption_translations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    clip_id uuid NOT NULL,
    credits integer NOT NULL,
    status text DEFAULT 'charged'::text NOT NULL,
    hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT caption_translations_credits_check CHECK ((credits > 0)),
    CONSTRAINT caption_translations_hash_check CHECK (((hash IS NULL) OR (hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT caption_translations_status_check CHECK ((status = ANY (ARRAY['charged'::text, 'done'::text, 'refunded'::text])))
);


--
-- Name: card_budget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_budget (
    user_id uuid NOT NULL,
    day date NOT NULL,
    raised integer DEFAULT 0 NOT NULL,
    held integer DEFAULT 0 NOT NULL,
    CONSTRAINT card_budget_held_check CHECK ((held >= 0)),
    CONSTRAINT card_budget_raised_check CHECK ((raised >= 0))
);


--
-- Name: cmo_draft_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_draft_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    item_id uuid NOT NULL,
    department text NOT NULL,
    action text NOT NULL,
    chosen_version smallint,
    similarity real,
    edit_mode text,
    model text DEFAULT ''::text NOT NULL,
    prompt_version text DEFAULT ''::text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    classified_at timestamp with time zone,
    platform text,
    voice_note_deleted_at timestamp with time zone,
    mentioned_product boolean,
    outcome_url text,
    outcome_votes integer,
    outcome_replies integer,
    outcome_checked_at timestamp with time zone,
    outcome_status text,
    CONSTRAINT cmo_draft_outcomes_action_check CHECK ((action = ANY (ARRAY['approve'::text, 'skip'::text, 'replied'::text, 'dismissed'::text]))),
    CONSTRAINT cmo_draft_outcomes_chosen_version_check CHECK (((chosen_version >= 0) AND (chosen_version <= 2))),
    CONSTRAINT cmo_draft_outcomes_department_check CHECK ((department = ANY (ARRAY['post'::text, 'sales'::text]))),
    CONSTRAINT cmo_draft_outcomes_edit_mode_check CHECK ((edit_mode = ANY (ARRAY['NO_MEANINGFUL_EDIT'::text, 'TOO_SALESY'::text, 'WRONG_VOICE'::text, 'INVENTED_CLAIM'::text, 'TOO_LONG'::text, 'HOOK_REWRITTEN'::text, 'CTA_REMOVED'::text, 'FULL_REWRITE'::text]))),
    CONSTRAINT cmo_draft_outcomes_model_check CHECK ((char_length(model) <= 100)),
    CONSTRAINT cmo_draft_outcomes_outcome_replies_check CHECK (((outcome_replies >= 0) AND (outcome_replies <= 1000000))),
    CONSTRAINT cmo_draft_outcomes_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['found'::text, 'not_found'::text, 'gone'::text]))),
    CONSTRAINT cmo_draft_outcomes_outcome_url_check CHECK (((outcome_url ~ '^https://'::text) AND (char_length(outcome_url) <= 500))),
    CONSTRAINT cmo_draft_outcomes_outcome_votes_check CHECK (((outcome_votes >= '-100000'::integer) AND (outcome_votes <= 10000000))),
    CONSTRAINT cmo_draft_outcomes_platform_check CHECK (((platform IS NULL) OR (public.platform_profile(platform) IS NOT NULL))),
    CONSTRAINT cmo_draft_outcomes_prompt_version_check CHECK ((char_length(prompt_version) <= 40)),
    CONSTRAINT cmo_draft_outcomes_similarity_check CHECK (((similarity >= (0)::double precision) AND (similarity <= (1)::double precision)))
);


--
-- Name: cmo_draft_quality_weekly; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cmo_draft_quality_weekly WITH (security_invoker='true') AS
 WITH modes AS (
         SELECT (date_trunc('week'::text, cmo_draft_outcomes.decided_at))::date AS week,
            cmo_draft_outcomes.department,
            cmo_draft_outcomes.model,
            cmo_draft_outcomes.prompt_version,
            cmo_draft_outcomes.edit_mode,
            count(*) AS n
           FROM public.cmo_draft_outcomes
          WHERE (cmo_draft_outcomes.edit_mode IS NOT NULL)
          GROUP BY ((date_trunc('week'::text, cmo_draft_outcomes.decided_at))::date), cmo_draft_outcomes.department, cmo_draft_outcomes.model, cmo_draft_outcomes.prompt_version, cmo_draft_outcomes.edit_mode
        ), totals AS (
         SELECT (date_trunc('week'::text, cmo_draft_outcomes.decided_at))::date AS week,
            cmo_draft_outcomes.department,
            cmo_draft_outcomes.model,
            cmo_draft_outcomes.prompt_version,
            count(*) AS decided,
            count(*) FILTER (WHERE ((cmo_draft_outcomes.action = 'approve'::text) AND (cmo_draft_outcomes.similarity >= public.cmo_as_written()))) AS approved_as_written,
            count(*) FILTER (WHERE ((cmo_draft_outcomes.action = 'approve'::text) AND (cmo_draft_outcomes.similarity < public.cmo_as_written()))) AS approved_edited,
            count(*) FILTER (WHERE (cmo_draft_outcomes.action = 'replied'::text)) AS replied,
            count(*) FILTER (WHERE (cmo_draft_outcomes.action = ANY (ARRAY['skip'::text, 'dismissed'::text]))) AS skipped,
            round((avg(cmo_draft_outcomes.similarity))::numeric, 3) AS mean_similarity
           FROM public.cmo_draft_outcomes
          GROUP BY ((date_trunc('week'::text, cmo_draft_outcomes.decided_at))::date), cmo_draft_outcomes.department, cmo_draft_outcomes.model, cmo_draft_outcomes.prompt_version
        )
 SELECT week,
    department,
    model,
    prompt_version,
    decided,
    approved_as_written,
    approved_edited,
    replied,
    skipped,
    mean_similarity,
    COALESCE(( SELECT jsonb_object_agg(m.edit_mode, m.n) AS jsonb_object_agg
           FROM modes m
          WHERE ((m.week = t.week) AND (m.department = t.department) AND (m.model = t.model) AND (m.prompt_version = t.prompt_version))), '{}'::jsonb) AS edit_modes
   FROM totals t;


--
-- Name: cmo_lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_lessons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    week date NOT NULL,
    topic text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cmo_lessons_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 600))),
    CONSTRAINT cmo_lessons_topic_check CHECK ((topic = ANY (ARRAY['general'::text, 'post'::text, 'sales'::text, 'video'::text, 'research'::text]))),
    CONSTRAINT cmo_lessons_week_check CHECK ((EXTRACT(isodow FROM week) = (1)::numeric))
);


--
-- Name: credit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    delta integer NOT NULL,
    reason text NOT NULL,
    job_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_id text,
    ref_kind text,
    ref_id uuid,
    CONSTRAINT credit_ledger_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['job'::text, 'generation'::text, 'captions'::text, 'caption_translation'::text, 'agent_turn'::text, 'cmo_run'::text, 'work_order'::text]))),
    CONSTRAINT credit_ledger_ref_pair CHECK (((ref_kind IS NULL) = (ref_id IS NULL)))
);


--
-- Name: deliverables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliverables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid NOT NULL,
    kind text NOT NULL,
    ref_kind text NOT NULL,
    ref_id uuid NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_id uuid,
    post_id uuid,
    CONSTRAINT deliverables_kind_check CHECK ((kind = ANY (ARRAY['post'::text, 'caption'::text, 'video'::text, 'short'::text, 'slideshow'::text, 'image'::text, 'reply'::text, 'insight'::text, 'metric'::text]))),
    CONSTRAINT deliverables_parent_check CHECK (((parent_id IS NULL) OR (kind = 'caption'::text))),
    CONSTRAINT deliverables_post_image_check CHECK (((post_id IS NOT NULL) = (kind = 'image'::text))),
    CONSTRAINT deliverables_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['content_item'::text, 'opportunity'::text, 'insight'::text, 'clip'::text]))),
    CONSTRAINT deliverables_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'waiting_founder'::text, 'decided'::text])))
);


--
-- Name: editor_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    clip_id uuid,
    category text NOT NULL,
    summary text NOT NULL,
    details text,
    severity text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editor_feedback_category_check CHECK ((category = ANY (ARRAY['missing_capability'::text, 'wrong_result'::text, 'confusing_ux'::text, 'failure'::text, 'suggestion'::text]))),
    CONSTRAINT editor_feedback_details_check CHECK (((details IS NULL) OR (char_length(details) <= 4000))),
    CONSTRAINT editor_feedback_severity_check CHECK (((severity IS NULL) OR (severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT editor_feedback_summary_check CHECK (((char_length(summary) >= 1) AND (char_length(summary) <= 300)))
);


--
-- Name: editor_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_transcripts (
    clip_id uuid NOT NULL,
    hash text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editor_transcripts_body_check CHECK ((octet_length(body) < 524288)),
    CONSTRAINT editor_transcripts_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    day date NOT NULL,
    approval_ids uuid[] NOT NULL,
    status text DEFAULT 'claimed'::text NOT NULL,
    provider_id text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT email_log_approval_ids_check CHECK (((cardinality(approval_ids) >= 1) AND (cardinality(approval_ids) <= 50))),
    CONSTRAINT email_log_error_check CHECK ((char_length(error) <= 500)),
    CONSTRAINT email_log_kind_check CHECK ((kind = ANY (ARRAY['digest'::text, 'expiring'::text]))),
    CONSTRAINT email_log_provider_id_check CHECK ((char_length(provider_id) <= 100)),
    CONSTRAINT email_log_status_check CHECK ((status = ANY (ARRAY['claimed'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    clip_id uuid,
    kind text NOT NULL,
    model text NOT NULL,
    spec jsonb NOT NULL,
    spec_hash text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    credits_reserved integer NOT NULL,
    credits_final integer,
    task_id uuid,
    media_asset_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    after_id uuid,
    sent_at timestamp with time zone,
    quality jsonb,
    CONSTRAINT generations_credits_final_check CHECK ((credits_final >= 0)),
    CONSTRAINT generations_credits_reserved_check CHECK ((credits_reserved >= 0)),
    CONSTRAINT generations_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'voice'::text, 'audio'::text]))),
    CONSTRAINT generations_quality_check CHECK (((quality IS NULL) OR public.generation_quality_ok(quality))),
    CONSTRAINT generations_spec_hash_check CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT generations_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: marketing_documents_latest; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.marketing_documents_latest WITH (security_invoker='true') AS
 SELECT DISTINCT ON (user_id, kind) id,
    user_id,
    kind,
    version,
    body,
    created_by,
    created_at
   FROM public.marketing_documents
  ORDER BY user_id, kind, version DESC;


--
-- Name: mcp_confirms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_confirms (
    user_id uuid NOT NULL,
    nonce uuid NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_grants (
    user_id uuid NOT NULL,
    client_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT mcp_grants_client_id_check CHECK (((char_length(client_id) >= 1) AND (char_length(client_id) <= 200)))
);


--
-- Name: media_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_transcripts (
    asset_id uuid NOT NULL,
    user_id uuid NOT NULL,
    hash text NOT NULL,
    body text NOT NULL,
    seconds numeric NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_transcripts_body_check CHECK ((octet_length(body) < 524288)),
    CONSTRAINT media_transcripts_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_transcripts_seconds_check CHECK ((seconds > (0)::numeric)),
    CONSTRAINT media_transcripts_source_check CHECK ((source = ANY (ARRAY['scribe'::text, 'fake'::text, 'import'::text])))
);


--
-- Name: operation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    result text DEFAULT 'ok'::text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: orphan_scan_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orphan_scan_cursors (
    bucket text NOT NULL,
    after_path text DEFAULT ''::text NOT NULL,
    CONSTRAINT orphan_scan_cursors_bucket_check CHECK ((bucket = ANY (ARRAY['sources'::text, 'media'::text])))
);


--
-- Name: page_captures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    task_id uuid,
    title text,
    width integer,
    height integer,
    image_path text,
    boxes_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT page_captures_error_check CHECK ((char_length(error) <= 500)),
    CONSTRAINT page_captures_height_check CHECK ((height > 0)),
    CONSTRAINT page_captures_ready_check CHECK (((status <> 'ready'::text) OR ((image_path IS NOT NULL) AND (boxes_path IS NOT NULL) AND (width IS NOT NULL) AND (height IS NOT NULL)))),
    CONSTRAINT page_captures_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT page_captures_title_check CHECK ((char_length(title) <= 300)),
    CONSTRAINT page_captures_url_check CHECK (((char_length(url) >= 1) AND (char_length(url) <= 2048))),
    CONSTRAINT page_captures_width_check CHECK ((width > 0))
);


--
-- Name: polar_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polar_customers (
    customer_id text NOT NULL,
    user_id uuid
);


--
-- Name: polar_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polar_purchases (
    order_id text NOT NULL,
    customer_id text NOT NULL,
    user_id uuid,
    product_id text,
    plan text,
    credits integer DEFAULT 0 NOT NULL,
    granted boolean DEFAULT false NOT NULL,
    total_amount bigint DEFAULT 0 NOT NULL,
    currency text,
    refunded_amount bigint DEFAULT 0 NOT NULL,
    refunded_tax_amount bigint DEFAULT 0 NOT NULL,
    paid_at timestamp with time zone,
    refunded_at timestamp with time zone,
    CONSTRAINT polar_purchases_credits_check CHECK ((credits >= 0)),
    CONSTRAINT polar_purchases_refunded_amount_check CHECK ((refunded_amount >= 0)),
    CONSTRAINT polar_purchases_refunded_tax_amount_check CHECK ((refunded_tax_amount >= 0)),
    CONSTRAINT polar_purchases_total_amount_check CHECK ((total_amount >= 0))
);


--
-- Name: polar_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polar_subscriptions (
    subscription_id text NOT NULL,
    customer_id text NOT NULL,
    user_id uuid,
    plan text NOT NULL,
    status text NOT NULL,
    current_period_end timestamp with time zone,
    provider_updated_at timestamp with time zone NOT NULL,
    status_priority integer NOT NULL,
    event_id text NOT NULL,
    CONSTRAINT polar_subscriptions_plan_check CHECK ((plan = ANY (ARRAY['starter'::text, 'creator'::text]))),
    CONSTRAINT polar_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'revoked'::text])))
);


--
-- Name: polar_webhook_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polar_webhook_receipts (
    event_id text NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    user_id uuid,
    result jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: post_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    item_id uuid NOT NULL,
    url text NOT NULL,
    views bigint DEFAULT 0 NOT NULL,
    likes bigint DEFAULT 0 NOT NULL,
    replies bigint DEFAULT 0 NOT NULL,
    reposts bigint DEFAULT 0 NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'public'::text NOT NULL,
    impressions bigint,
    engagements bigint,
    CONSTRAINT post_metrics_engagements_check CHECK ((engagements >= 0)),
    CONSTRAINT post_metrics_impressions_check CHECK ((impressions >= 0)),
    CONSTRAINT post_metrics_likes_check CHECK ((likes >= 0)),
    CONSTRAINT post_metrics_replies_check CHECK ((replies >= 0)),
    CONSTRAINT post_metrics_reposts_check CHECK ((reposts >= 0)),
    CONSTRAINT post_metrics_source_check CHECK ((source = ANY (ARRAY['public'::text, 'zernio'::text]))),
    CONSTRAINT post_metrics_url_check CHECK ((char_length(url) <= 500)),
    CONSTRAINT post_metrics_views_check CHECK ((views >= 0))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text,
    plan text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    polar_customer_id text,
    credit_balance integer DEFAULT 0 NOT NULL,
    retention_from timestamp with time zone DEFAULT now() NOT NULL,
    retention_exempt boolean DEFAULT false NOT NULL,
    weekly_credit_budget integer DEFAULT 80 NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    digest_hour smallint DEFAULT 7,
    cmo_paused_at timestamp with time zone,
    CONSTRAINT profiles_digest_hour_check CHECK (((digest_hour >= 0) AND (digest_hour <= 23))),
    CONSTRAINT profiles_timezone_check CHECK (((char_length(timezone) >= 1) AND (char_length(timezone) <= 64))),
    CONSTRAINT profiles_weekly_credit_budget_check CHECK (((weekly_credit_budget >= 0) AND (weekly_credit_budget <= 10000)))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projects_kind_check CHECK ((kind = ANY (ARRAY['clip'::text, 'edit'::text])))
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failed_at timestamp with time zone,
    last_pushed_at timestamp with time zone,
    CONSTRAINT push_subscriptions_auth_check CHECK ((auth ~ '^[A-Za-z0-9_-]{8,100}={0,2}$'::text)),
    CONSTRAINT push_subscriptions_endpoint_check CHECK (public.push_endpoint_allowed(endpoint)),
    CONSTRAINT push_subscriptions_p256dh_check CHECK ((p256dh ~ '^[A-Za-z0-9_-]{20,200}={0,2}$'::text)),
    CONSTRAINT push_subscriptions_user_agent_check CHECK ((char_length(user_agent) <= 300))
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    user_id uuid NOT NULL,
    bucket text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count integer NOT NULL
);


--
-- Name: scene_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scene_codes (
    user_id uuid NOT NULL,
    hash text NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scene_codes_code_check CHECK (((char_length(code) >= 1) AND (char_length(code) <= 32000))),
    CONSTRAINT scene_codes_hash_check CHECK ((hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: short_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.short_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    parent_clip_id uuid NOT NULL,
    parent_hash text NOT NULL,
    order_id uuid,
    status text DEFAULT 'picking'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT short_batches_error_check CHECK ((char_length(error) <= 500)),
    CONSTRAINT short_batches_parent_hash_check CHECK ((parent_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT short_batches_status_check CHECK ((status = ANY (ARRAY['picking'::text, 'building'::text, 'rendering'::text, 'waiting_founder'::text, 'approved'::text, 'sent_back'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: shorts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shorts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    parent_clip_id uuid,
    short_clip_id uuid,
    source_start numeric NOT NULL,
    source_end numeric NOT NULL,
    hook text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shorts_check CHECK (((source_end > source_start) AND ((source_end - source_start) <= (180)::numeric))),
    CONSTRAINT shorts_hook_check CHECK (((char_length(hook) >= 1) AND (char_length(hook) <= 120))),
    CONSTRAINT shorts_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 300))),
    CONSTRAINT shorts_source_start_check CHECK ((source_start >= (0)::numeric)),
    CONSTRAINT shorts_status_check CHECK ((status = ANY (ARRAY['building'::text, 'rendering'::text, 'ready'::text, 'approved'::text, 'sent_back'::text, 'failed'::text])))
);


--
-- Name: storage_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_deletions (
    id bigint NOT NULL,
    bucket text NOT NULL,
    path text NOT NULL,
    job_id uuid,
    user_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    deferred_at timestamp with time zone,
    CONSTRAINT storage_deletions_bucket_check CHECK ((bucket = ANY (ARRAY['clips'::text, 'sources'::text, 'renders'::text, 'media'::text, 'exports'::text, 'brand'::text, 'captures'::text]))),
    CONSTRAINT storage_deletions_path_check CHECK (((path <> ''::text) AND (path !~~ '%..%'::text)))
);


--
-- Name: storage_deletions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_deletions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_deletions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_deletions_id_seq OWNED BY public.storage_deletions.id;


--
-- Name: subreddit_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subreddit_rules (
    subreddit text NOT NULL,
    verdict text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subreddit_rules_subreddit_check CHECK ((subreddit ~ '^[a-z0-9_]{2,21}$'::text)),
    CONSTRAINT subreddit_rules_summary_check CHECK ((char_length(summary) <= 200)),
    CONSTRAINT subreddit_rules_verdict_check CHECK ((verdict = ANY (ARRAY['mention_ok'::text, 'help_only'::text, 'skip'::text])))
);


--
-- Name: upload_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    bucket text NOT NULL,
    object_name text NOT NULL,
    declared_size bigint NOT NULL,
    content_type text NOT NULL,
    project_id uuid,
    status text DEFAULT 'reserved'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_reservations_bucket_check CHECK ((bucket = ANY (ARRAY['sources'::text, 'media'::text, 'exports'::text]))),
    CONSTRAINT upload_reservations_content_type_check CHECK ((content_type ~~ 'video/%'::text)),
    CONSTRAINT upload_reservations_declared_size_check CHECK (((declared_size > 0) AND (declared_size <= '2147483648'::bigint))),
    CONSTRAINT upload_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'consumed'::text])))
);


--
-- Name: work_order_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_order_events (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid NOT NULL,
    department text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    text text NOT NULL,
    CONSTRAINT work_order_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'running'::text, 'waiting_founder'::text, 'waiting_order'::text, 'deferred'::text, 'queued'::text, 'done'::text, 'failed'::text, 'cancelled'::text, 'note'::text]))),
    CONSTRAINT work_order_events_text_check CHECK (((char_length(text) >= 1) AND (char_length(text) <= 200)))
);


--
-- Name: work_order_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.work_order_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.work_order_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: work_order_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_order_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cache_read_tokens integer NOT NULL,
    cache_write_tokens integer NOT NULL,
    micro_usd bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_usage_cache_read_tokens_check CHECK ((cache_read_tokens >= 0)),
    CONSTRAINT work_order_usage_cache_write_tokens_check CHECK ((cache_write_tokens >= 0)),
    CONSTRAINT work_order_usage_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT work_order_usage_micro_usd_check CHECK ((micro_usd >= 0)),
    CONSTRAINT work_order_usage_model_check CHECK (((char_length(model) >= 1) AND (char_length(model) <= 64))),
    CONSTRAINT work_order_usage_output_tokens_check CHECK ((output_tokens >= 0))
);


--
-- Name: worker_draft_initializations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_draft_initializations (
    job_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    revisions jsonb NOT NULL
);


--
-- Name: worker_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_operations (
    operation_key text NOT NULL,
    job_id uuid NOT NULL,
    kind text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: write_budget_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.write_budget_ledger (
    user_id uuid NOT NULL,
    table_name text NOT NULL,
    bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: zernio_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zernio_profiles (
    user_id uuid NOT NULL,
    zernio_profile_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT zernio_profiles_zernio_profile_id_check CHECK (((char_length(zernio_profile_id) >= 1) AND (char_length(zernio_profile_id) <= 100)))
);


--
-- Name: zernio_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zernio_receipts (
    event_id text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT zernio_receipts_event_id_check CHECK (((char_length(event_id) >= 1) AND (char_length(event_id) <= 200)))
);


--
-- Name: storage_deletions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletions ALTER COLUMN id SET DEFAULT nextval('public.storage_deletions_id_seq'::regclass);


--
-- Name: account_metrics account_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_metrics
    ADD CONSTRAINT account_metrics_pkey PRIMARY KEY (id);


--
-- Name: account_metrics account_metrics_user_id_platform_handle_day_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_metrics
    ADD CONSTRAINT account_metrics_user_id_platform_handle_day_key UNIQUE (user_id, platform, handle, day);


--
-- Name: agent_messages agent_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);


--
-- Name: agent_messages agent_messages_session_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_session_id_seq_key UNIQUE (session_id, seq);


--
-- Name: agent_model_prices agent_model_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_model_prices
    ADD CONSTRAINT agent_model_prices_pkey PRIMARY KEY (pattern);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_pkey PRIMARY KEY (id);


--
-- Name: agent_turns agent_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_pkey PRIMARY KEY (id);


--
-- Name: agent_turns agent_turns_session_id_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_session_id_number_key UNIQUE (session_id, number);


--
-- Name: agent_usage agent_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_pkey PRIMARY KEY (id);


--
-- Name: ai_models ai_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (job_id, kind, version);


--
-- Name: best_slots best_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.best_slots
    ADD CONSTRAINT best_slots_pkey PRIMARY KEY (user_id, platform, hour);


--
-- Name: brand_kits brand_kits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_kits
    ADD CONSTRAINT brand_kits_pkey PRIMARY KEY (id);


--
-- Name: caption_translations caption_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caption_translations
    ADD CONSTRAINT caption_translations_pkey PRIMARY KEY (id);


--
-- Name: card_budget card_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_budget
    ADD CONSTRAINT card_budget_pkey PRIMARY KEY (user_id, day);


--
-- Name: clips clips_job_id_idx_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_job_id_idx_key UNIQUE (job_id, idx);


--
-- Name: clips clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_pkey PRIMARY KEY (id);


--
-- Name: cmo_corrections cmo_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_corrections
    ADD CONSTRAINT cmo_corrections_pkey PRIMARY KEY (id);


--
-- Name: cmo_draft_outcomes cmo_draft_outcomes_department_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_draft_outcomes
    ADD CONSTRAINT cmo_draft_outcomes_department_item_id_key UNIQUE (department, item_id);


--
-- Name: cmo_draft_outcomes cmo_draft_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_draft_outcomes
    ADD CONSTRAINT cmo_draft_outcomes_pkey PRIMARY KEY (id);


--
-- Name: cmo_goals cmo_goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_goals
    ADD CONSTRAINT cmo_goals_pkey PRIMARY KEY (id);


--
-- Name: cmo_goals cmo_goals_user_id_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_goals
    ADD CONSTRAINT cmo_goals_user_id_week_key UNIQUE (user_id, week);


--
-- Name: cmo_inbox cmo_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_inbox
    ADD CONSTRAINT cmo_inbox_pkey PRIMARY KEY (id);


--
-- Name: cmo_insights cmo_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_insights
    ADD CONSTRAINT cmo_insights_pkey PRIMARY KEY (id);


--
-- Name: cmo_lessons cmo_lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_lessons
    ADD CONSTRAINT cmo_lessons_pkey PRIMARY KEY (id);


--
-- Name: cmo_lessons cmo_lessons_user_id_week_topic_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_lessons
    ADD CONSTRAINT cmo_lessons_user_id_week_topic_key UNIQUE (user_id, week, topic);


--
-- Name: cmo_memories cmo_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_memories
    ADD CONSTRAINT cmo_memories_pkey PRIMARY KEY (id);


--
-- Name: cmo_runs cmo_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_runs
    ADD CONSTRAINT cmo_runs_pkey PRIMARY KEY (id);


--
-- Name: content_items content_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_pkey PRIMARY KEY (id);


--
-- Name: credit_ledger credit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);


--
-- Name: deliverables deliverables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_pkey PRIMARY KEY (id);


--
-- Name: deliverables deliverables_ref_kind_ref_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_ref_kind_ref_id_key UNIQUE (ref_kind, ref_id);


--
-- Name: editor_feedback editor_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_feedback
    ADD CONSTRAINT editor_feedback_pkey PRIMARY KEY (id);


--
-- Name: editor_projects editor_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_projects
    ADD CONSTRAINT editor_projects_pkey PRIMARY KEY (clip_id);


--
-- Name: editor_revisions editor_revisions_clip_id_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_revisions
    ADD CONSTRAINT editor_revisions_clip_id_number_key UNIQUE (clip_id, number);


--
-- Name: editor_revisions editor_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_revisions
    ADD CONSTRAINT editor_revisions_pkey PRIMARY KEY (id);


--
-- Name: editor_skills editor_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_skills
    ADD CONSTRAINT editor_skills_pkey PRIMARY KEY (id);


--
-- Name: editor_skills editor_skills_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_skills
    ADD CONSTRAINT editor_skills_user_id_name_key UNIQUE (user_id, name);


--
-- Name: editor_transcripts editor_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_transcripts
    ADD CONSTRAINT editor_transcripts_pkey PRIMARY KEY (clip_id, hash);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: generations generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: look_checks look_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.look_checks
    ADD CONSTRAINT look_checks_pkey PRIMARY KEY (id);


--
-- Name: marketing_documents marketing_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_documents
    ADD CONSTRAINT marketing_documents_pkey PRIMARY KEY (id);


--
-- Name: marketing_documents marketing_documents_user_id_kind_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_documents
    ADD CONSTRAINT marketing_documents_user_id_kind_version_key UNIQUE (user_id, kind, version);


--
-- Name: mcp_confirms mcp_confirms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_confirms
    ADD CONSTRAINT mcp_confirms_pkey PRIMARY KEY (user_id, nonce);


--
-- Name: mcp_grants mcp_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_grants
    ADD CONSTRAINT mcp_grants_pkey PRIMARY KEY (user_id, client_id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_storage_path_key UNIQUE (storage_path);


--
-- Name: media_transcripts media_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_transcripts
    ADD CONSTRAINT media_transcripts_pkey PRIMARY KEY (asset_id);


--
-- Name: notify_settings notify_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notify_settings
    ADD CONSTRAINT notify_settings_pkey PRIMARY KEY (user_id);


--
-- Name: notify_settings notify_settings_unsubscribe_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notify_settings
    ADD CONSTRAINT notify_settings_unsubscribe_token_key UNIQUE (unsubscribe_token);


--
-- Name: operation_log operation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_log
    ADD CONSTRAINT operation_log_pkey PRIMARY KEY (id);


--
-- Name: operation_log operation_log_user_id_platform_action_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_log
    ADD CONSTRAINT operation_log_user_id_platform_action_target_key UNIQUE (user_id, platform, action, target);


--
-- Name: opportunities opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);


--
-- Name: opportunities opportunities_user_id_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_user_id_url_key UNIQUE (user_id, url);


--
-- Name: orphan_scan_cursors orphan_scan_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orphan_scan_cursors
    ADD CONSTRAINT orphan_scan_cursors_pkey PRIMARY KEY (bucket);


--
-- Name: page_captures page_captures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_captures
    ADD CONSTRAINT page_captures_pkey PRIMARY KEY (id);


--
-- Name: polar_customers polar_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_customers
    ADD CONSTRAINT polar_customers_pkey PRIMARY KEY (customer_id);


--
-- Name: polar_purchases polar_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_purchases
    ADD CONSTRAINT polar_purchases_pkey PRIMARY KEY (order_id);


--
-- Name: polar_subscriptions polar_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_subscriptions
    ADD CONSTRAINT polar_subscriptions_pkey PRIMARY KEY (subscription_id);


--
-- Name: polar_webhook_receipts polar_webhook_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_webhook_receipts
    ADD CONSTRAINT polar_webhook_receipts_pkey PRIMARY KEY (event_id);


--
-- Name: post_metrics post_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_metrics
    ADD CONSTRAINT post_metrics_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: projects projects_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_job_id_key UNIQUE (job_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (user_id, bucket, window_start);


--
-- Name: sales_settings sales_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_settings
    ADD CONSTRAINT sales_settings_pkey PRIMARY KEY (user_id);


--
-- Name: scene_codes scene_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_codes
    ADD CONSTRAINT scene_codes_pkey PRIMARY KEY (user_id, hash);


--
-- Name: schedule_slots schedule_slots_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: schedule_slots schedule_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_pkey PRIMARY KEY (id);


--
-- Name: short_batches short_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.short_batches
    ADD CONSTRAINT short_batches_pkey PRIMARY KEY (id);


--
-- Name: shorts shorts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_pkey PRIMARY KEY (id);


--
-- Name: shorts shorts_short_clip_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_short_clip_id_key UNIQUE (short_clip_id);


--
-- Name: social_accounts social_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_pkey PRIMARY KEY (id);


--
-- Name: social_accounts social_accounts_user_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_user_id_platform_key UNIQUE (user_id, platform);


--
-- Name: social_accounts social_accounts_zernio_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_zernio_account_id_key UNIQUE (zernio_account_id);


--
-- Name: storage_deletions storage_deletions_bucket_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletions
    ADD CONSTRAINT storage_deletions_bucket_path_key UNIQUE (bucket, path);


--
-- Name: storage_deletions storage_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletions
    ADD CONSTRAINT storage_deletions_pkey PRIMARY KEY (id);


--
-- Name: studio_steps studio_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_steps
    ADD CONSTRAINT studio_steps_pkey PRIMARY KEY (id);


--
-- Name: subreddit_rules subreddit_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subreddit_rules
    ADD CONSTRAINT subreddit_rules_pkey PRIMARY KEY (subreddit);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_request_id_key UNIQUE (request_id);


--
-- Name: upload_reservations upload_reservations_bucket_object_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_reservations
    ADD CONSTRAINT upload_reservations_bucket_object_name_key UNIQUE (bucket, object_name);


--
-- Name: upload_reservations upload_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_reservations
    ADD CONSTRAINT upload_reservations_pkey PRIMARY KEY (id);


--
-- Name: work_order_events work_order_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_events
    ADD CONSTRAINT work_order_events_pkey PRIMARY KEY (id);


--
-- Name: work_order_usage work_order_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_usage
    ADD CONSTRAINT work_order_usage_pkey PRIMARY KEY (id);


--
-- Name: work_orders work_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);


--
-- Name: worker_draft_initializations worker_draft_initializations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_draft_initializations
    ADD CONSTRAINT worker_draft_initializations_pkey PRIMARY KEY (job_id, attempt_id);


--
-- Name: worker_operations worker_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_operations
    ADD CONSTRAINT worker_operations_pkey PRIMARY KEY (operation_key);


--
-- Name: zernio_profiles zernio_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zernio_profiles
    ADD CONSTRAINT zernio_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: zernio_profiles zernio_profiles_zernio_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zernio_profiles
    ADD CONSTRAINT zernio_profiles_zernio_profile_id_key UNIQUE (zernio_profile_id);


--
-- Name: zernio_receipts zernio_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zernio_receipts
    ADD CONSTRAINT zernio_receipts_pkey PRIMARY KEY (event_id);


--
-- Name: account_metrics_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_metrics_user_idx ON public.account_metrics USING btree (user_id, day DESC);


--
-- Name: agent_sessions_clip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_sessions_clip_idx ON public.agent_sessions USING btree (clip_id, created_at DESC);


--
-- Name: agent_sessions_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_sessions_job_idx ON public.agent_sessions USING btree (job_id, created_at DESC);


--
-- Name: agent_tool_calls_turn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tool_calls_turn_idx ON public.agent_tool_calls USING btree (turn_id, created_at);


--
-- Name: api_keys_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_user_idx ON public.api_keys USING btree (user_id, created_at DESC);


--
-- Name: approvals_held_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_held_idx ON public.approvals USING btree (held_until) WHERE (status = 'held'::text);


--
-- Name: approvals_one_waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approvals_one_waiting ON public.approvals USING btree (ref_kind, ref_id) WHERE (status = ANY (ARRAY['waiting'::text, 'held'::text]));


--
-- Name: approvals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_user_idx ON public.approvals USING btree (user_id, status, created_at);


--
-- Name: artifacts_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_attempt_idx ON public.artifacts USING btree (job_id, kind, attempt_id);


--
-- Name: brand_kits_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brand_kits_one_default_idx ON public.brand_kits USING btree (user_id) WHERE is_default;


--
-- Name: brand_kits_user_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brand_kits_user_name_idx ON public.brand_kits USING btree (user_id, lower(name));


--
-- Name: caption_translations_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX caption_translations_user_idx ON public.caption_translations USING btree (user_id, created_at DESC);


--
-- Name: clips_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clips_parent_idx ON public.clips USING btree (parent_clip_id) WHERE (parent_clip_id IS NOT NULL);


--
-- Name: cmo_corrections_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_corrections_mode_idx ON public.cmo_corrections USING btree (user_id, edit_mode, created_at DESC) WHERE (edit_mode IS NOT NULL);


--
-- Name: cmo_corrections_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_corrections_user_idx ON public.cmo_corrections USING btree (user_id, status, created_at DESC);


--
-- Name: cmo_draft_outcomes_unclassified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_draft_outcomes_unclassified_idx ON public.cmo_draft_outcomes USING btree (decided_at) WHERE ((classified_at IS NULL) AND (action = 'approve'::text));


--
-- Name: cmo_draft_outcomes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_draft_outcomes_user_idx ON public.cmo_draft_outcomes USING btree (user_id, decided_at DESC);


--
-- Name: cmo_goals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_goals_user_idx ON public.cmo_goals USING btree (user_id, week DESC);


--
-- Name: cmo_inbox_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_inbox_user_idx ON public.cmo_inbox USING btree (user_id, status, created_at DESC);


--
-- Name: cmo_insights_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_insights_user_idx ON public.cmo_insights USING btree (user_id, kind, created_at DESC);


--
-- Name: cmo_lessons_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_lessons_user_idx ON public.cmo_lessons USING btree (user_id, week DESC);


--
-- Name: cmo_memories_source_outcome_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cmo_memories_source_outcome_key ON public.cmo_memories USING btree (source_outcome) WHERE (source_outcome IS NOT NULL);


--
-- Name: cmo_memories_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_memories_topic_idx ON public.cmo_memories USING btree (user_id, topic, importance DESC, created_at DESC);


--
-- Name: cmo_memories_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_memories_user_idx ON public.cmo_memories USING btree (user_id, created_at DESC);


--
-- Name: cmo_memories_voice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_memories_voice_idx ON public.cmo_memories USING btree (user_id, created_at DESC) WHERE ((topic = 'post'::text) AND (kind = 'preference'::text));


--
-- Name: cmo_runs_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_runs_lease_idx ON public.cmo_runs USING btree (lease_until) WHERE (status = 'running'::text);


--
-- Name: cmo_runs_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_runs_queue_idx ON public.cmo_runs USING btree (created_at) WHERE (status = 'queued'::text);


--
-- Name: cmo_runs_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_runs_user_created_idx ON public.cmo_runs USING btree (user_id, created_at DESC);


--
-- Name: content_items_caption_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX content_items_caption_key ON public.content_items USING btree (clip_id, platform) WHERE (clip_id IS NOT NULL);


--
-- Name: content_items_clip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_items_clip_idx ON public.content_items USING btree (clip_id) WHERE (clip_id IS NOT NULL);


--
-- Name: content_items_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_items_user_status_idx ON public.content_items USING btree (user_id, status, day);


--
-- Name: credit_ledger_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_ledger_external_idx ON public.credit_ledger USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: credit_ledger_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_ledger_ref_idx ON public.credit_ledger USING btree (ref_kind, ref_id) WHERE (ref_kind IS NOT NULL);


--
-- Name: credit_ledger_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_ledger_user_idx ON public.credit_ledger USING btree (user_id, created_at DESC);


--
-- Name: deliverables_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliverables_order_idx ON public.deliverables USING btree (order_id);


--
-- Name: deliverables_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliverables_parent_idx ON public.deliverables USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: deliverables_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliverables_post_idx ON public.deliverables USING btree (post_id) WHERE (post_id IS NOT NULL);


--
-- Name: editor_feedback_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_feedback_created_idx ON public.editor_feedback USING btree (created_at DESC);


--
-- Name: editor_revisions_clip_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_revisions_clip_created_idx ON public.editor_revisions USING btree (clip_id, created_at);


--
-- Name: editor_revisions_clip_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_revisions_clip_number_idx ON public.editor_revisions USING btree (clip_id, number DESC);


--
-- Name: editor_transcripts_clip_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_transcripts_clip_created_idx ON public.editor_transcripts USING btree (clip_id, created_at);


--
-- Name: email_log_one_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_log_one_digest ON public.email_log USING btree (user_id, day) WHERE (kind = 'digest'::text);


--
-- Name: email_log_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_log_user_idx ON public.email_log USING btree (user_id, created_at DESC);


--
-- Name: generations_after_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_after_idx ON public.generations USING btree (after_id) WHERE (after_id IS NOT NULL);


--
-- Name: generations_live_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX generations_live_hash_idx ON public.generations USING btree (job_id, spec_hash) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text]));


--
-- Name: generations_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_task_idx ON public.generations USING btree (task_id);


--
-- Name: generations_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX generations_user_idx ON public.generations USING btree (user_id, created_at DESC);


--
-- Name: jobs_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_expiry_idx ON public.jobs USING btree (expires_at) WHERE (status = 'done'::public.job_status);


--
-- Name: jobs_expiry_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_expiry_sweep_idx ON public.jobs USING btree (expires_at, id) WHERE (purging_at IS NULL);


--
-- Name: jobs_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_lease_idx ON public.jobs USING btree (lease_until) WHERE ((status = 'running'::public.job_status) AND (attempt_id IS NOT NULL));


--
-- Name: jobs_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_queue_idx ON public.jobs USING btree (created_at) WHERE (status = 'queued'::public.job_status);


--
-- Name: jobs_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_user_created_idx ON public.jobs USING btree (user_id, created_at DESC);


--
-- Name: jobs_user_keyset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_user_keyset_idx ON public.jobs USING btree (user_id, created_at DESC, id DESC);


--
-- Name: look_checks_one_round; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX look_checks_one_round ON public.look_checks USING btree (ref_kind, COALESCE(order_id, ref_id), round) WHERE (status <> 'superseded'::text);


--
-- Name: look_checks_sent_back_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX look_checks_sent_back_idx ON public.look_checks USING btree (created_at) WHERE (status = ANY (ARRAY['sent_back'::text, 'claimed'::text]));


--
-- Name: look_checks_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX look_checks_task_idx ON public.look_checks USING btree (task_id);


--
-- Name: marketing_documents_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_documents_user_created_idx ON public.marketing_documents USING btree (user_id, created_at);


--
-- Name: mcp_confirms_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_confirms_used_at ON public.mcp_confirms USING btree (user_id, used_at);


--
-- Name: media_assets_job_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_job_created_idx ON public.media_assets USING btree (job_id, created_at);


--
-- Name: media_assets_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_user_idx ON public.media_assets USING btree (user_id, created_at DESC);


--
-- Name: operation_log_user_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operation_log_user_at_idx ON public.operation_log USING btree (user_id, platform, action, at DESC);


--
-- Name: opportunities_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opportunities_user_status_idx ON public.opportunities USING btree (user_id, status, created_at DESC);


--
-- Name: page_captures_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_captures_task_idx ON public.page_captures USING btree (task_id);


--
-- Name: page_captures_user_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX page_captures_user_recent_idx ON public.page_captures USING btree (user_id, created_at DESC);


--
-- Name: polar_customers_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX polar_customers_user_idx ON public.polar_customers USING btree (user_id);


--
-- Name: polar_subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX polar_subscriptions_user_idx ON public.polar_subscriptions USING btree (user_id);


--
-- Name: post_metrics_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_metrics_item_idx ON public.post_metrics USING btree (item_id, measured_at DESC);


--
-- Name: post_metrics_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX post_metrics_user_idx ON public.post_metrics USING btree (user_id, measured_at DESC);


--
-- Name: profiles_polar_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_polar_customer_idx ON public.profiles USING btree (polar_customer_id) WHERE (polar_customer_id IS NOT NULL);


--
-- Name: profiles_polar_customer_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_polar_customer_unique ON public.profiles USING btree (polar_customer_id) WHERE (polar_customer_id IS NOT NULL);


--
-- Name: projects_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_user_created_idx ON public.projects USING btree (user_id, created_at DESC, id DESC);


--
-- Name: push_subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions USING btree (user_id);


--
-- Name: schedule_slots_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_slots_due_idx ON public.schedule_slots USING btree (publish_at) WHERE (status = 'waiting'::text);


--
-- Name: schedule_slots_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_slots_external_idx ON public.schedule_slots USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: schedule_slots_one_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schedule_slots_one_live ON public.schedule_slots USING btree (deliverable_id, platform) WHERE (status = ANY (ARRAY['proposed'::text, 'waiting'::text, 'due'::text, 'reminded'::text, 'publishing'::text, 'published'::text]));


--
-- Name: schedule_slots_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_slots_user_idx ON public.schedule_slots USING btree (user_id, publish_at);


--
-- Name: short_batches_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX short_batches_parent_idx ON public.short_batches USING btree (parent_clip_id);


--
-- Name: short_batches_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX short_batches_user_idx ON public.short_batches USING btree (user_id, status, created_at);


--
-- Name: shorts_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shorts_batch_idx ON public.shorts USING btree (batch_id);


--
-- Name: shorts_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shorts_user_idx ON public.shorts USING btree (user_id, created_at);


--
-- Name: storage_deletions_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletions_job_idx ON public.storage_deletions USING btree (job_id);


--
-- Name: storage_deletions_work_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletions_work_idx ON public.storage_deletions USING btree (attempts, id);


--
-- Name: studio_steps_clip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_steps_clip_idx ON public.studio_steps USING btree (clip_id);


--
-- Name: studio_steps_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_steps_order_idx ON public.studio_steps USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: studio_steps_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_steps_user_idx ON public.studio_steps USING btree (user_id, status, created_at);


--
-- Name: tasks_editor_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_editor_revision_idx ON public.tasks USING btree (editor_revision_id, created_at DESC) WHERE (editor_revision_id IS NOT NULL);


--
-- Name: tasks_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_lease_idx ON public.tasks USING btree (lease_until) WHERE (status = 'running'::text);


--
-- Name: tasks_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_queue_idx ON public.tasks USING btree (created_at) WHERE (status = 'queued'::text);


--
-- Name: tasks_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_user_created_idx ON public.tasks USING btree (user_id, created_at DESC);


--
-- Name: upload_reservations_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upload_reservations_user_status_idx ON public.upload_reservations USING btree (user_id, status, expires_at);


--
-- Name: work_order_events_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_order_events_user_idx ON public.work_order_events USING btree (user_id, at DESC);


--
-- Name: work_order_usage_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_order_usage_order_idx ON public.work_order_usage USING btree (order_id);


--
-- Name: work_orders_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_item_idx ON public.work_orders USING btree (item_id) WHERE (item_id IS NOT NULL);


--
-- Name: work_orders_one_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX work_orders_one_root ON public.work_orders USING btree (user_id, week) WHERE (parent_id IS NULL);


--
-- Name: work_orders_root_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_root_idx ON public.work_orders USING btree (root_id);


--
-- Name: work_orders_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_run_idx ON public.work_orders USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: work_orders_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX work_orders_user_idx ON public.work_orders USING btree (user_id, week, status);


--
-- Name: write_budget_ledger_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX write_budget_ledger_user_idx ON public.write_budget_ledger USING btree (user_id, table_name, created_at);


--
-- Name: agent_messages agent_messages_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_messages_immutable BEFORE UPDATE ON public.agent_messages FOR EACH ROW EXECUTE FUNCTION public.agent_messages_immutable();


--
-- Name: credit_ledger apply_credit_ledger_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER apply_credit_ledger_insert AFTER INSERT ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.apply_credit_ledger_insert();


--
-- Name: approvals approvals_caption_approve; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_caption_approve AFTER UPDATE OF status ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.approvals_caption_approve();


--
-- Name: approvals approvals_caption_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_caption_rules AFTER INSERT ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.approvals_caption_rules();


--
-- Name: cmo_corrections approvals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_sync AFTER INSERT OR DELETE OR UPDATE ON public.cmo_corrections FOR EACH ROW EXECUTE FUNCTION public.approvals_sync('correction');


--
-- Name: cmo_goals approvals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_sync AFTER INSERT OR DELETE OR UPDATE ON public.cmo_goals FOR EACH ROW EXECUTE FUNCTION public.approvals_sync('goal');


--
-- Name: content_items approvals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_sync AFTER INSERT OR DELETE OR UPDATE ON public.content_items FOR EACH ROW EXECUTE FUNCTION public.approvals_sync('content_item');


--
-- Name: opportunities approvals_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approvals_sync AFTER INSERT OR DELETE OR UPDATE ON public.opportunities FOR EACH ROW EXECUTE FUNCTION public.approvals_sync('opportunity');


--
-- Name: clips clips_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clips_record_storage_deletions BEFORE DELETE ON public.clips FOR EACH ROW EXECUTE FUNCTION public.record_clip_storage_deletions();


--
-- Name: cmo_draft_outcomes cmo_draft_outcomes_learn; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cmo_draft_outcomes_learn AFTER INSERT OR UPDATE OF edit_mode ON public.cmo_draft_outcomes FOR EACH ROW EXECUTE FUNCTION public.cmo_draft_outcomes_learn();


--
-- Name: cmo_draft_outcomes cmo_draft_outcomes_platform; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cmo_draft_outcomes_platform BEFORE INSERT ON public.cmo_draft_outcomes FOR EACH ROW EXECUTE FUNCTION public.cmo_draft_outcomes_platform();


--
-- Name: cmo_memories cmo_memories_classify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cmo_memories_classify BEFORE INSERT ON public.cmo_memories FOR EACH ROW EXECUTE FUNCTION public.cmo_memories_classify();


--
-- Name: deliverables deliverables_caption_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliverables_caption_rules AFTER INSERT ON public.deliverables FOR EACH ROW EXECUTE FUNCTION public.deliverables_caption_rules();


--
-- Name: deliverables deliverables_parent_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliverables_parent_guard BEFORE INSERT OR UPDATE OF parent_id, user_id ON public.deliverables FOR EACH ROW EXECUTE FUNCTION public.deliverables_parent_guard();


--
-- Name: editor_projects editor_projects_clear_finished; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_projects_clear_finished BEFORE UPDATE OF document ON public.editor_projects FOR EACH ROW EXECUTE FUNCTION public.editor_projects_clear_finished();


--
-- Name: editor_projects editor_projects_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_projects_rules AFTER UPDATE ON public.editor_projects FOR EACH ROW EXECUTE FUNCTION public.editor_projects_rules();


--
-- Name: editor_revisions editor_revisions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_revisions_immutable BEFORE UPDATE ON public.editor_revisions FOR EACH ROW EXECUTE FUNCTION public.freeze_clip_revision();


--
-- Name: editor_revisions editor_revisions_write_budget; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_revisions_write_budget BEFORE INSERT ON public.editor_revisions FOR EACH ROW EXECUTE FUNCTION public.enforce_write_budget();


--
-- Name: editor_transcripts editor_transcripts_write_budget; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_transcripts_write_budget BEFORE INSERT ON public.editor_transcripts FOR EACH ROW EXECUTE FUNCTION public.enforce_write_budget();


--
-- Name: jobs jobs_project; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_project AFTER INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.project_from_job();


--
-- Name: jobs jobs_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_record_storage_deletions BEFORE DELETE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.record_job_storage_deletions();


--
-- Name: jobs jobs_storage_expiry; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_storage_expiry BEFORE UPDATE OF status, finished_at ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.set_job_storage_expiry();


--
-- Name: marketing_documents marketing_documents_write_budget; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER marketing_documents_write_budget BEFORE INSERT ON public.marketing_documents FOR EACH ROW EXECUTE FUNCTION public.enforce_write_budget();


--
-- Name: media_assets media_assets_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_assets_record_storage_deletions BEFORE DELETE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.record_media_storage_deletions();


--
-- Name: credit_ledger reject_credit_ledger_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_credit_ledger_change BEFORE DELETE OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.reject_credit_ledger_change();


--
-- Name: content_items schedule_follow_content; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedule_follow_content AFTER UPDATE OF status ON public.content_items FOR EACH ROW EXECUTE FUNCTION public.schedule_follow_content();


--
-- Name: deliverables schedule_follow_deliverable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedule_follow_deliverable AFTER INSERT OR UPDATE OF status ON public.deliverables FOR EACH ROW EXECUTE FUNCTION public.schedule_follow_deliverable();


--
-- Name: studio_steps studio_slideshow_fresh; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER studio_slideshow_fresh BEFORE UPDATE OF status ON public.studio_steps FOR EACH ROW EXECUTE FUNCTION public.studio_slideshow_fresh();


--
-- Name: studio_steps studio_steps_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER studio_steps_sync AFTER INSERT OR DELETE OR UPDATE ON public.studio_steps FOR EACH ROW EXECUTE FUNCTION public.studio_steps_sync();


--
-- Name: tasks tasks_look_check_settle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_look_check_settle AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tasks_look_check_settle();


--
-- Name: tasks tasks_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_record_storage_deletions BEFORE DELETE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.record_task_storage_deletions();


--
-- Name: tasks tasks_refund_media_captions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_refund_media_captions AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.refund_media_captions_from_task();


--
-- Name: tasks tasks_studio_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_studio_rules AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tasks_studio_rules();


--
-- Name: tasks tasks_sync_asset_transcript; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_sync_asset_transcript AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.sync_asset_transcript_from_task();


--
-- Name: tasks tasks_sync_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_sync_generation AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.sync_generation_from_task();


--
-- Name: tasks tasks_sync_page_capture; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_sync_page_capture AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.sync_page_capture_from_task();


--
-- Name: work_orders work_orders_brief_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_orders_brief_rules AFTER UPDATE OF status ON public.work_orders FOR EACH ROW EXECUTE FUNCTION public.work_orders_brief_rules();


--
-- Name: approvals work_orders_follow_approval; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_orders_follow_approval AFTER UPDATE OF status ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.work_orders_follow_approval();


--
-- Name: cmo_runs work_orders_follow_run; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER work_orders_follow_run AFTER INSERT OR UPDATE OF status ON public.cmo_runs FOR EACH ROW EXECUTE FUNCTION public.work_orders_follow_run();


--
-- Name: account_metrics account_metrics_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_metrics
    ADD CONSTRAINT account_metrics_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE SET NULL;


--
-- Name: account_metrics account_metrics_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_metrics
    ADD CONSTRAINT account_metrics_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agent_messages agent_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_sessions(id) ON DELETE CASCADE;


--
-- Name: agent_messages agent_messages_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.agent_turns(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: agent_sessions agent_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_sessions
    ADD CONSTRAINT agent_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agent_tool_calls agent_tool_calls_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.agent_turns(id) ON DELETE CASCADE;


--
-- Name: agent_turns agent_turns_checkpoint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_checkpoint_id_fkey FOREIGN KEY (checkpoint_id) REFERENCES public.editor_revisions(id) ON DELETE SET NULL;


--
-- Name: agent_turns agent_turns_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_turns
    ADD CONSTRAINT agent_turns_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.agent_sessions(id) ON DELETE CASCADE;


--
-- Name: agent_usage agent_usage_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_usage
    ADD CONSTRAINT agent_usage_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.agent_turns(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: approvals approvals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: artifacts artifacts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: best_slots best_slots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.best_slots
    ADD CONSTRAINT best_slots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: brand_kits brand_kits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_kits
    ADD CONSTRAINT brand_kits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: caption_translations caption_translations_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caption_translations
    ADD CONSTRAINT caption_translations_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: caption_translations caption_translations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caption_translations
    ADD CONSTRAINT caption_translations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: card_budget card_budget_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_budget
    ADD CONSTRAINT card_budget_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: clips clips_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: clips clips_parent_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_parent_clip_id_fkey FOREIGN KEY (parent_clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: cmo_corrections cmo_corrections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_corrections
    ADD CONSTRAINT cmo_corrections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_draft_outcomes cmo_draft_outcomes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_draft_outcomes
    ADD CONSTRAINT cmo_draft_outcomes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_goals cmo_goals_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_goals
    ADD CONSTRAINT cmo_goals_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: cmo_goals cmo_goals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_goals
    ADD CONSTRAINT cmo_goals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_inbox cmo_inbox_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_inbox
    ADD CONSTRAINT cmo_inbox_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: cmo_inbox cmo_inbox_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_inbox
    ADD CONSTRAINT cmo_inbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_insights cmo_insights_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_insights
    ADD CONSTRAINT cmo_insights_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: cmo_insights cmo_insights_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_insights
    ADD CONSTRAINT cmo_insights_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_lessons cmo_lessons_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_lessons
    ADD CONSTRAINT cmo_lessons_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: cmo_lessons cmo_lessons_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_lessons
    ADD CONSTRAINT cmo_lessons_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_memories cmo_memories_source_outcome_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_memories
    ADD CONSTRAINT cmo_memories_source_outcome_fkey FOREIGN KEY (source_outcome) REFERENCES public.cmo_draft_outcomes(id) ON DELETE SET NULL;


--
-- Name: cmo_memories cmo_memories_source_run_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_memories
    ADD CONSTRAINT cmo_memories_source_run_fkey FOREIGN KEY (source_run) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: cmo_memories cmo_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_memories
    ADD CONSTRAINT cmo_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cmo_runs cmo_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_runs
    ADD CONSTRAINT cmo_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: content_items content_items_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: content_items content_items_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: content_items content_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: credit_ledger credit_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: deliverables deliverables_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: deliverables deliverables_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.deliverables(id) ON DELETE CASCADE;


--
-- Name: deliverables deliverables_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.content_items(id) ON DELETE CASCADE;


--
-- Name: deliverables deliverables_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliverables
    ADD CONSTRAINT deliverables_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: editor_feedback editor_feedback_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_feedback
    ADD CONSTRAINT editor_feedback_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: editor_feedback editor_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_feedback
    ADD CONSTRAINT editor_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: editor_projects editor_projects_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_projects
    ADD CONSTRAINT editor_projects_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: editor_revisions editor_revisions_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_revisions
    ADD CONSTRAINT editor_revisions_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: editor_skills editor_skills_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_skills
    ADD CONSTRAINT editor_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: editor_transcripts editor_transcripts_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editor_transcripts
    ADD CONSTRAINT editor_transcripts_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: email_log email_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: generations generations_after_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_after_id_fkey FOREIGN KEY (after_id) REFERENCES public.generations(id) ON DELETE SET NULL;


--
-- Name: generations generations_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: generations generations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: generations generations_media_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_media_asset_id_fkey FOREIGN KEY (media_asset_id) REFERENCES public.media_assets(id) ON DELETE SET NULL;


--
-- Name: generations generations_model_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_model_fkey FOREIGN KEY (model) REFERENCES public.ai_models(id);


--
-- Name: generations generations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: look_checks look_checks_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.look_checks
    ADD CONSTRAINT look_checks_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE SET NULL;


--
-- Name: look_checks look_checks_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.look_checks
    ADD CONSTRAINT look_checks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: look_checks look_checks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.look_checks
    ADD CONSTRAINT look_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: marketing_documents marketing_documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_documents
    ADD CONSTRAINT marketing_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mcp_confirms mcp_confirms_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_confirms
    ADD CONSTRAINT mcp_confirms_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mcp_grants mcp_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_grants
    ADD CONSTRAINT mcp_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: media_transcripts media_transcripts_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_transcripts
    ADD CONSTRAINT media_transcripts_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: media_transcripts media_transcripts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_transcripts
    ADD CONSTRAINT media_transcripts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notify_settings notify_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notify_settings
    ADD CONSTRAINT notify_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: operation_log operation_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_log
    ADD CONSTRAINT operation_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: opportunities opportunities_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: opportunities opportunities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opportunities
    ADD CONSTRAINT opportunities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: page_captures page_captures_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_captures
    ADD CONSTRAINT page_captures_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: page_captures page_captures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_captures
    ADD CONSTRAINT page_captures_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: polar_customers polar_customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_customers
    ADD CONSTRAINT polar_customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: polar_purchases polar_purchases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_purchases
    ADD CONSTRAINT polar_purchases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: polar_subscriptions polar_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_subscriptions
    ADD CONSTRAINT polar_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: polar_webhook_receipts polar_webhook_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_webhook_receipts
    ADD CONSTRAINT polar_webhook_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: post_metrics post_metrics_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_metrics
    ADD CONSTRAINT post_metrics_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.content_items(id) ON DELETE CASCADE;


--
-- Name: post_metrics post_metrics_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_metrics
    ADD CONSTRAINT post_metrics_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: projects projects_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: projects projects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sales_settings sales_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_settings
    ADD CONSTRAINT sales_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: scene_codes scene_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_codes
    ADD CONSTRAINT scene_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule_slots schedule_slots_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.social_accounts(id) ON DELETE SET NULL;


--
-- Name: schedule_slots schedule_slots_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE SET NULL;


--
-- Name: schedule_slots schedule_slots_deliverable_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_deliverable_id_fkey FOREIGN KEY (deliverable_id) REFERENCES public.deliverables(id) ON DELETE CASCADE;


--
-- Name: schedule_slots schedule_slots_media_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_media_task_id_fkey FOREIGN KEY (media_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: schedule_slots schedule_slots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_slots
    ADD CONSTRAINT schedule_slots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: short_batches short_batches_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.short_batches
    ADD CONSTRAINT short_batches_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE SET NULL;


--
-- Name: short_batches short_batches_parent_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.short_batches
    ADD CONSTRAINT short_batches_parent_clip_id_fkey FOREIGN KEY (parent_clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: short_batches short_batches_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.short_batches
    ADD CONSTRAINT short_batches_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shorts shorts_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.short_batches(id) ON DELETE CASCADE;


--
-- Name: shorts shorts_parent_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_parent_clip_id_fkey FOREIGN KEY (parent_clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: shorts shorts_short_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_short_clip_id_fkey FOREIGN KEY (short_clip_id) REFERENCES public.clips(id) ON DELETE SET NULL;


--
-- Name: shorts shorts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shorts
    ADD CONSTRAINT shorts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: social_accounts social_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: studio_steps studio_steps_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_steps
    ADD CONSTRAINT studio_steps_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: studio_steps studio_steps_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_steps
    ADD CONSTRAINT studio_steps_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE SET NULL;


--
-- Name: studio_steps studio_steps_redo_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_steps
    ADD CONSTRAINT studio_steps_redo_of_fkey FOREIGN KEY (redo_of) REFERENCES public.studio_steps(id) ON DELETE SET NULL;


--
-- Name: studio_steps studio_steps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_steps
    ADD CONSTRAINT studio_steps_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_clip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_clip_id_fkey FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_editor_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_editor_revision_id_fkey FOREIGN KEY (editor_revision_id) REFERENCES public.editor_revisions(id);


--
-- Name: tasks tasks_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: upload_reservations upload_reservations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_reservations
    ADD CONSTRAINT upload_reservations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: upload_reservations upload_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_reservations
    ADD CONSTRAINT upload_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: work_order_events work_order_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_events
    ADD CONSTRAINT work_order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: work_order_events work_order_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_events
    ADD CONSTRAINT work_order_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: work_order_usage work_order_usage_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_usage
    ADD CONSTRAINT work_order_usage_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: work_order_usage work_order_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_order_usage
    ADD CONSTRAINT work_order_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: work_orders work_orders_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.content_items(id) ON DELETE SET NULL;


--
-- Name: work_orders work_orders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: work_orders work_orders_root_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_root_id_fkey FOREIGN KEY (root_id) REFERENCES public.work_orders(id) ON DELETE CASCADE;


--
-- Name: work_orders work_orders_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: work_orders work_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: worker_draft_initializations worker_draft_initializations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_draft_initializations
    ADD CONSTRAINT worker_draft_initializations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: worker_operations worker_operations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_operations
    ADD CONSTRAINT worker_operations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: write_budget_ledger write_budget_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.write_budget_ledger
    ADD CONSTRAINT write_budget_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: zernio_profiles zernio_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zernio_profiles
    ADD CONSTRAINT zernio_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: account_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_model_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_model_prices ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tool_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tool_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_turns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_turns ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: artifacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: best_slots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.best_slots ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_kits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brand_kits ENABLE ROW LEVEL SECURITY;

--
-- Name: caption_translations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.caption_translations ENABLE ROW LEVEL SECURITY;

--
-- Name: card_budget; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_budget ENABLE ROW LEVEL SECURITY;

--
-- Name: clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_draft_outcomes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_draft_outcomes ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_goals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_goals ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_inbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_inbox ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_insights ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_lessons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_lessons ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_memories ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: content_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: deliverables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deliverables ENABLE ROW LEVEL SECURITY;

--
-- Name: editor_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editor_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: editor_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editor_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: editor_revisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editor_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: editor_skills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editor_skills ENABLE ROW LEVEL SECURITY;

--
-- Name: editor_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.editor_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: generations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: look_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.look_checks ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_confirms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_confirms ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_grants mcp_grants_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mcp_grants_select_own ON public.mcp_grants FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: media_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: notify_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notify_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: operation_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.operation_log ENABLE ROW LEVEL SECURITY;

--
-- Name: opportunities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;

--
-- Name: orphan_scan_cursors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orphan_scan_cursors ENABLE ROW LEVEL SECURITY;

--
-- Name: page_captures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.page_captures ENABLE ROW LEVEL SECURITY;

--
-- Name: polar_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.polar_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: polar_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.polar_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: polar_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.polar_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: polar_webhook_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.polar_webhook_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: post_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_goals read own CMO goals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own CMO goals" ON public.cmo_goals FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: cmo_lessons read own CMO lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own CMO lessons" ON public.cmo_lessons FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: account_metrics read own account metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own account metrics" ON public.account_metrics FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: approvals read own approvals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own approvals" ON public.approvals FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: best_slots read own best slots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own best slots" ON public.best_slots FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: card_budget read own card budget; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own card budget" ON public.card_budget FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: cmo_corrections read own corrections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own corrections" ON public.cmo_corrections FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: deliverables read own deliverables; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own deliverables" ON public.deliverables FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: cmo_draft_outcomes read own draft outcomes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own draft outcomes" ON public.cmo_draft_outcomes FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: email_log read own email log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own email log" ON public.email_log FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: cmo_inbox read own inbox; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own inbox" ON public.cmo_inbox FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: look_checks read own look checks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own look checks" ON public.look_checks FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: media_transcripts read own media transcripts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own media transcripts" ON public.media_transcripts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notify_settings read own notify settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own notify settings" ON public.notify_settings FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: work_order_events read own order events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own order events" ON public.work_order_events FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: work_order_usage read own order usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own order usage" ON public.work_order_usage FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: page_captures read own page captures; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own page captures" ON public.page_captures FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: push_subscriptions read own push subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own push subscriptions" ON public.push_subscriptions FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: sales_settings read own sales settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own sales settings" ON public.sales_settings FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: schedule_slots read own schedule slots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own schedule slots" ON public.schedule_slots FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: short_batches read own short batches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own short batches" ON public.short_batches FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: shorts read own shorts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own shorts" ON public.shorts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: social_accounts read own social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own social accounts" ON public.social_accounts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: studio_steps read own studio steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own studio steps" ON public.studio_steps FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: work_orders read own work orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own work orders" ON public.work_orders FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: zernio_profiles read own zernio profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own zernio profile" ON public.zernio_profiles FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: subreddit_rules read subreddit rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read subreddit rules" ON public.subreddit_rules FOR SELECT TO authenticated USING (true);


--
-- Name: sales_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sales_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: scene_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_slots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_slots ENABLE ROW LEVEL SECURITY;

--
-- Name: short_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.short_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: shorts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shorts ENABLE ROW LEVEL SECURITY;

--
-- Name: social_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_deletions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_deletions ENABLE ROW LEVEL SECURITY;

--
-- Name: studio_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.studio_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: subreddit_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subreddit_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: upload_reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.upload_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: work_order_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_order_events ENABLE ROW LEVEL SECURITY;

--
-- Name: work_order_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_order_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: work_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_draft_initializations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_draft_initializations ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_operations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_operations ENABLE ROW LEVEL SECURITY;

--
-- Name: write_budget_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.write_budget_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: zernio_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.zernio_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: zernio_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.zernio_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets đọc B-roll của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc B-roll của chính mình" ON public.media_assets FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = media_assets.job_id) AND (j.purging_at IS NOT NULL)))))));


--
-- Name: artifacts đọc artifact thuộc job của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc artifact thuộc job của mình" ON public.artifacts FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = artifacts.job_id) AND (j.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: brand_kits đọc brand kit của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc brand kit của mình" ON public.brand_kits FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: ai_models đọc catalog; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc catalog" ON public.ai_models FOR SELECT TO authenticated USING (true);


--
-- Name: clips đọc clip thuộc job của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc clip thuộc job của mình" ON public.clips FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = clips.job_id) AND (j.user_id = auth.uid()) AND (j.purging_at IS NULL)))));


--
-- Name: scene_codes đọc code cảnh của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc code cảnh của mình" ON public.scene_codes FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: opportunities đọc cơ hội của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc cơ hội của mình" ON public.opportunities FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: marketing_documents đọc document marketing của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc document marketing của mình" ON public.marketing_documents FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: editor_projects đọc editor project thuộc clip của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc editor project thuộc clip của mình" ON public.editor_projects FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.clips c
     JOIN public.jobs j ON ((j.id = c.job_id)))
  WHERE ((c.id = editor_projects.clip_id) AND (j.user_id = ( SELECT auth.uid() AS uid)) AND (j.purging_at IS NULL)))));


--
-- Name: editor_revisions đọc editor revision thuộc clip của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc editor revision thuộc clip của mình" ON public.editor_revisions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.clips c
     JOIN public.jobs j ON ((j.id = c.job_id)))
  WHERE ((c.id = editor_revisions.clip_id) AND (j.user_id = ( SELECT auth.uid() AS uid)) AND (j.purging_at IS NULL)))));


--
-- Name: generations đọc generation của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc generation của chính mình" ON public.generations FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = generations.job_id) AND (j.purging_at IS NOT NULL)))))));


--
-- Name: profiles đọc hồ sơ của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc hồ sơ của chính mình" ON public.profiles FOR SELECT USING ((( SELECT auth.uid() AS uid) = id));


--
-- Name: cmo_insights đọc insight của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc insight của mình" ON public.cmo_insights FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: jobs đọc job của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc job của chính mình" ON public.jobs FOR SELECT USING (((auth.uid() = user_id) AND (purging_at IS NULL)));


--
-- Name: api_keys đọc khoá của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc khoá của mình" ON public.api_keys FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: cmo_runs đọc lượt CMO của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc lượt CMO của mình" ON public.cmo_runs FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: agent_turns đọc lượt assistant của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc lượt assistant của mình" ON public.agent_turns FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.agent_sessions s
  WHERE ((s.id = agent_turns.session_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: caption_translations đọc lượt dịch của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc lượt dịch của chính mình" ON public.caption_translations FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: content_items đọc lịch và bài của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc lịch và bài của mình" ON public.content_items FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: operation_log đọc nhật ký của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc nhật ký của mình" ON public.operation_log FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: agent_sessions đọc phiên assistant của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc phiên assistant của mình" ON public.agent_sessions FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: editor_feedback đọc phản hồi của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc phản hồi của mình" ON public.editor_feedback FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: projects đọc project của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc project của mình" ON public.projects FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: editor_skills đọc skill của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc skill của mình" ON public.editor_skills FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: post_metrics đọc số liệu của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc số liệu của mình" ON public.post_metrics FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: credit_ledger đọc sổ cái của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc sổ cái của chính mình" ON public.credit_ledger FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: tasks đọc task của chính mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc task của chính mình" ON public.tasks FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = tasks.job_id) AND (j.purging_at IS NOT NULL))))) AND (NOT (EXISTS ( SELECT 1
   FROM (public.clips c
     JOIN public.jobs j ON ((j.id = c.job_id)))
  WHERE ((c.id = tasks.clip_id) AND (j.purging_at IS NOT NULL)))))));


--
-- Name: agent_messages đọc tin nhắn assistant của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc tin nhắn assistant của mình" ON public.agent_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.agent_sessions s
  WHERE ((s.id = agent_messages.session_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: agent_tool_calls đọc tool call assistant của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc tool call assistant của mình" ON public.agent_tool_calls FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.agent_turns t
     JOIN public.agent_sessions s ON ((s.id = t.session_id)))
  WHERE ((t.id = agent_tool_calls.turn_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: editor_transcripts đọc transcript editor thuộc clip của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc transcript editor thuộc clip của mình" ON public.editor_transcripts FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.clips c
     JOIN public.jobs j ON ((j.id = c.job_id)))
  WHERE ((c.id = editor_transcripts.clip_id) AND (j.user_id = ( SELECT auth.uid() AS uid)) AND (j.purging_at IS NULL)))));


--
-- Name: cmo_memories đọc trí nhớ CMO của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc trí nhớ CMO của mình" ON public.cmo_memories FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: agent_usage đọc usage assistant của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc usage assistant của mình" ON public.agent_usage FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.agent_turns t
     JOIN public.agent_sessions s ON ((s.id = t.session_id)))
  WHERE ((t.id = agent_usage.turn_id) AND (s.user_id = ( SELECT auth.uid() AS uid))))));


--
-- PostgreSQL database dump complete
--


