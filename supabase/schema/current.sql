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
    CONSTRAINT agent_turns_pause_reason_check CHECK (((pause_reason IS NULL) OR (pause_reason = ANY (ARRAY['browser'::text, 'approval'::text, 'input'::text, 'time'::text, 'budget'::text])))),
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
  insert into public.agent_sessions(user_id, scope, model)
  values (v_user, 'cmo', p_model) returning * into v_session;
  return v_session;
end;
$$;


--
-- Name: agent_open_project_session(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_open_project_session(p_job_id uuid, p_model text) RETURNS public.agent_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  if v_turn.status <> 'running' or v_more <= 0
     or not exists (select 1 from public.agent_tool_calls c where c.turn_id = v_turn.id and c.name = 'preview_3d')
     or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  perform public.credit_hold(v_user, 'agent_turn', v_turn.id, v_more, 'Assistant hold (3D)');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
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
-- Name: agent_resume_turn(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_resume_turn(p_session_id uuid) RETURNS public.agent_turns
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    AS $$
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
begin
  if v_scene then
    v_allowed := v_allowed || array['scene'];
  end if;
  if p_model.kind in ('image', 'video') then
    if p_model.limits ? 'resolutions' then v_allowed := v_allowed || array['resolution']; end if;
    if v_max_refs > 0 then v_allowed := v_allowed || array['references']; end if;
  end if;
  if p_model.kind = 'video' then
    if coalesce((p_model.limits->>'firstFrame')::boolean, false) then v_allowed := v_allowed || array['startImage']; end if;
    if coalesce((p_model.limits->>'lastFrame')::boolean, false) then v_allowed := v_allowed || array['endImage']; end if;
    if coalesce((p_model.limits->>'audio')::boolean, false) then v_allowed := v_allowed || array['audio']; end if;
    if v_source then v_allowed := v_allowed || array['sourceVideo', 'sourceStart']; end if;
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
  if (p_spec ? 'startImage' and not public.ai_media_ref_ok(p_spec->'startImage'))
      or (p_spec ? 'endImage' and not public.ai_media_ref_ok(p_spec->'endImage')) then
    raise exception 'That image was not found in your library.' using errcode = '22023';
  end if;
  -- Model sửa video (G2): video nguồn bắt buộc, của chính người gọi, cùng luật với ảnh.
  if v_source then
    if not (p_spec ? 'sourceVideo') or not public.ai_media_ref_ok(p_spec->'sourceVideo') then
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
  if v_scene and octet_length((p_spec->'scene')::text) > 4000 then
    raise exception 'This 3D scene has too much data.' using errcode = '22023';
  end if;
  if v_scene and p_spec->'scene'->>'template' = 'code' and (
      jsonb_typeof(p_spec->'scene'->'code_ref') is distinct from 'string'
      or not exists (select 1 from public.scene_codes c
                     where c.user_id = auth.uid() and c.hash = p_spec->'scene'->>'code_ref')) then
    raise exception 'This 3D scene code was not found. Preview it again.' using errcode = '22023';
  end if;
  if p_model.kind = 'voice' and (jsonb_typeof(p_spec->'voice') is distinct from 'string'
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
  update public.api_keys set last_used_at = now()
  where key_hash = p_hash and revoked_at is null
  returning user_id into v_user;
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
    CONSTRAINT tasks_kind_check CHECK ((kind = ANY (ARRAY['probe_media'::text, 'zip'::text, 'generate'::text, 'render_document'::text, 'prepare_full'::text, 'transcribe_media'::text]))),
    CONSTRAINT tasks_progress_check CHECK (((progress IS NULL) OR ((progress >= (0)::double precision) AND (progress <= (1)::double precision)))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['awaiting_upload'::text, 'queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text])))
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
    where id = v_generation.task_id and status in ('queued', 'running');
  end if;
  select * into v_generation from public.generations where id = p_id;
  return to_jsonb(v_generation);
end;
$$;


--
-- Name: valid_job_segments(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_job_segments(p_segments jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  select p_segments is null
     or (
       jsonb_typeof(p_segments) = 'array'
       and jsonb_array_length(p_segments) between 1 and 10
       and not exists (
         select 1
         from jsonb_array_elements(p_segments) as s
         -- `is distinct from` chứ không phải `<>`: khoá thiếu cho
         -- `jsonb_typeof` ra NULL, và `NULL <> 'number'` là NULL, tức lọt.
         where jsonb_typeof(s) is distinct from 'object'
            or jsonb_typeof(s -> 'start') is distinct from 'number'
            or jsonb_typeof(s -> 'end') is distinct from 'number'
            or (s ->> 'start')::numeric < 0
            or (s ->> 'end')::numeric - (s ->> 'start')::numeric < 1
            or (s ->> 'end')::numeric - (s ->> 'start')::numeric > 180
       )
     );
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
    clip_length text DEFAULT 'auto'::text NOT NULL,
    segments jsonb,
    mode text DEFAULT 'clip'::text NOT NULL,
    aspect text DEFAULT '9:16'::text NOT NULL,
    layout text DEFAULT 'auto'::text NOT NULL,
    captions boolean DEFAULT true NOT NULL,
    caption_preset text DEFAULT 'bold'::text NOT NULL,
    purging_at timestamp with time zone,
    kind text DEFAULT 'clip'::text NOT NULL,
    CONSTRAINT jobs_aspect_check CHECK ((aspect = ANY (ARRAY['9:16'::text, '1:1'::text, '16:9'::text]))),
    CONSTRAINT jobs_caption_preset_check CHECK ((caption_preset = ANY (ARRAY['bold'::text, 'clean'::text, 'minimal'::text]))),
    CONSTRAINT jobs_clip_length_check CHECK ((clip_length = ANY (ARRAY['auto'::text, 'short'::text, 'medium'::text, 'long'::text]))),
    CONSTRAINT jobs_kind_check CHECK ((kind = ANY (ARRAY['clip'::text, 'edit'::text]))),
    CONSTRAINT jobs_layout_check CHECK ((layout = ANY (ARRAY['auto'::text, 'fill'::text, 'fit'::text]))),
    CONSTRAINT jobs_media_manifest_size_check CHECK (((media_manifest IS NULL) OR (pg_column_size(media_manifest) < 1000000))),
    CONSTRAINT jobs_mode_check CHECK ((mode = ANY (ARRAY['clip'::text, 'full'::text]))),
    CONSTRAINT jobs_name_length_check CHECK ((char_length(name) <= 120)),
    CONSTRAINT jobs_segments_check CHECK (public.valid_job_segments(segments)),
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
-- Name: checkpoint_editor_project(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.checkpoint_editor_project(p_clip_id uuid, p_kind text, p_label text) RETURNS public.editor_revisions
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
    CONSTRAINT cmo_runs_kind_check CHECK ((kind = ANY (ARRAY['onboard'::text, 'plan_week'::text, 'post_draft'::text, 'sales_scan'::text, 'video_pack'::text, 'competitor_research'::text, 'pull_metrics'::text, 'summarize_memory'::text, 'review_week'::text]))),
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
    returning *
  loop
    perform public.cmo_refund_run(v_dead);
  end loop;
  update public.cmo_runs set status = 'queued', lease_until = null
  where status = 'running' and kind <> 'onboard' and lease_until < now() and attempt < 3;

  select * into v_row from public.cmo_runs
  where status = 'queued' and (p_run_id is null or id = p_run_id)
    and (not_before is null or not_before <= now())
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
    CONSTRAINT content_items_body_check CHECK (((jsonb_typeof(body) = 'object'::text) AND (octet_length((body)::text) <= 16384))),
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
-- Name: cmo_video_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cmo_video_briefs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    hook text NOT NULL,
    broll text DEFAULT ''::text NOT NULL,
    visuals text DEFAULT ''::text NOT NULL,
    pacing text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'in_review'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT cmo_video_briefs_broll_check CHECK ((char_length(broll) <= 600)),
    CONSTRAINT cmo_video_briefs_hook_check CHECK (((char_length(hook) >= 1) AND (char_length(hook) <= 200))),
    CONSTRAINT cmo_video_briefs_pacing_check CHECK ((char_length(pacing) <= 300)),
    CONSTRAINT cmo_video_briefs_status_check CHECK ((status = ANY (ARRAY['in_review'::text, 'approved'::text, 'skipped'::text]))),
    CONSTRAINT cmo_video_briefs_visuals_check CHECK ((char_length(visuals) <= 600))
);


--
-- Name: cmo_create_video_brief(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_create_video_brief(p_job uuid, p_hook text, p_broll text, p_visuals text, p_pacing text) RETURNS public.cmo_video_briefs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_video_briefs;
begin
  if not exists (select 1 from public.jobs where id = p_job and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.clips where job_id = p_job and kind = 'moment') then
    raise exception 'This project has no clips yet. Make clips first.' using errcode = 'P0001';
  end if;
  if p_hook is null or char_length(trim(p_hook)) = 0 or char_length(p_hook) > 200 then
    raise exception 'The hook must be 1 to 200 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_broll, '')) > 600 or char_length(coalesce(p_visuals, '')) > 600 or char_length(coalesce(p_pacing, '')) > 300 then
    raise exception 'This brief is too long.' using errcode = '22023';
  end if;
  if (select count(*) from public.cmo_video_briefs where user_id = v_user and status = 'in_review') >= 10 then
    raise exception 'You have 10 video briefs waiting. Approve or skip some first.' using errcode = 'P0001';
  end if;
  insert into public.cmo_video_briefs (user_id, job_id, hook, broll, visuals, pacing)
  values (v_user, p_job, trim(p_hook), trim(coalesce(p_broll, '')), trim(coalesce(p_visuals, '')), trim(coalesce(p_pacing, '')))
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
    CONSTRAINT cmo_goals_metric_check CHECK ((metric = ANY (ARRAY['posts'::text, 'replies'::text, 'clips'::text, 'views'::text]))),
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
    reply text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'in_review'::text NOT NULL,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT opportunities_author_check CHECK ((char_length(author) <= 100)),
    CONSTRAINT opportunities_comments_check CHECK ((comments >= 0)),
    CONSTRAINT opportunities_community_check CHECK ((char_length(community) <= 100)),
    CONSTRAINT opportunities_platform_check CHECK ((platform = 'reddit'::text)),
    CONSTRAINT opportunities_priority_check CHECK ((priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT opportunities_reply_check CHECK (((char_length(reply) >= 1) AND (char_length(reply) <= 3000))),
    CONSTRAINT opportunities_score_check CHECK (((score >= 0) AND (score <= 100))),
    CONSTRAINT opportunities_score_parts_check CHECK (((jsonb_typeof(score_parts) = 'array'::text) AND (octet_length((score_parts)::text) <= 8192))),
    CONSTRAINT opportunities_snippet_check CHECK ((char_length(snippet) <= 1200)),
    CONSTRAINT opportunities_status_check CHECK ((status = ANY (ARRAY['in_review'::text, 'replied'::text, 'dismissed'::text]))),
    CONSTRAINT opportunities_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 400))),
    CONSTRAINT opportunities_url_check CHECK (((url ~ '^https://(www\.|old\.)?reddit\.com/'::text) AND (char_length(url) <= 500)))
);


--
-- Name: cmo_decide_opportunity(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_opportunity(p_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS public.opportunities
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.opportunities;
begin
  if p_action is null or p_action not in ('replied', 'dismissed') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  update public.opportunities set status = p_action, decided_at = now()
  where id = p_id and user_id = v_user and status = 'in_review'
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

  if p_action = 'skip' then
    update public.content_items set status = 'skipped', decided_at = now(), updated_at = now()
    where id = p_id returning * into v_row;
    if p_reason is not null and char_length(trim(p_reason)) > 0 then
      insert into public.cmo_memories (user_id, type, body)
      values (v_user, 'feedback', left('Skipped the X post "' || left(v_row.idea, 120) || '": ' || trim(p_reason), 600));
    end if;
    return v_row;
  end if;

  v_text := coalesce(nullif(trim(p_text), ''), v_row.body->>'text');
  if v_text is null or char_length(v_text) = 0 then
    raise exception 'This post is empty.' using errcode = '22023';
  end if;
  if char_length(v_text) > 280 then
    raise exception 'Posts on X can be at most 280 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.operation_log
      where user_id = v_user and platform = 'x' and action = 'approve' and at > now() - interval '1 day') >= 5 then
    raise exception 'You can approve 5 posts for X a day. Try again tomorrow.' using errcode = 'P0001';
  end if;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, 'x', 'approve', p_id::text);
  update public.content_items set status = 'approved', final_text = v_text, decided_at = now(), updated_at = now()
  where id = p_id returning * into v_row;
  return v_row;
end;
$$;


--
-- Name: cmo_decide_video_brief(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_video_brief(p_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS public.cmo_video_briefs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.cmo_video_briefs;
begin
  if p_action is null or p_action not in ('approve', 'skip') then
    raise exception 'Choose approve or skip.' using errcode = '22023';
  end if;
  update public.cmo_video_briefs
  set status = case p_action when 'approve' then 'approved' else 'skipped' end, decided_at = now()
  where id = p_id and user_id = v_user and status = 'in_review'
  returning * into v_row;
  if not found then
    if exists (select 1 from public.cmo_video_briefs where id = p_id and user_id = v_user) then
      raise exception 'This brief was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Brief not found.' using errcode = 'P0002';
  end if;
  if p_action = 'skip' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, kind, topic, body)
    values (v_user, 'feedback', 'feedback', 'video', left('Skipped a video brief "' || left(v_row.hook, 120) || '": ' || trim(p_reason), 600));
  end if;
  return v_row;
end;
$$;


--
-- Name: video_packs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_packs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid,
    job_id uuid NOT NULL,
    clips jsonb NOT NULL,
    captions jsonb NOT NULL,
    status text DEFAULT 'in_review'::text NOT NULL,
    exports jsonb DEFAULT '[]'::jsonb NOT NULL,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT video_packs_captions_check CHECK (((jsonb_typeof(captions) = 'object'::text) AND (octet_length((captions)::text) <= 65536))),
    CONSTRAINT video_packs_clips_check CHECK (((jsonb_typeof(clips) = 'array'::text) AND ((jsonb_array_length(clips) >= 1) AND (jsonb_array_length(clips) <= 10)) AND (octet_length((clips)::text) <= 16384))),
    CONSTRAINT video_packs_exports_check CHECK (((jsonb_typeof(exports) = 'array'::text) AND (octet_length((exports)::text) <= 8192))),
    CONSTRAINT video_packs_status_check CHECK ((status = ANY (ARRAY['in_review'::text, 'approved'::text, 'dismissed'::text])))
);


--
-- Name: cmo_decide_video_pack(uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_decide_video_pack(p_id uuid, p_action text, p_exports jsonb DEFAULT '[]'::jsonb, p_reason text DEFAULT NULL::text) RETURNS public.video_packs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.video_packs;
begin
  if p_action is null or p_action not in ('approved', 'dismissed') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if p_exports is null or jsonb_typeof(p_exports) <> 'array' then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;
  update public.video_packs
  set status = p_action, decided_at = now(), exports = case when p_action = 'approved' then p_exports else exports end
  where id = p_id and user_id = v_user and status = 'in_review'
  returning * into v_row;
  if not found then
    if exists (select 1 from public.video_packs where id = p_id and user_id = v_user) then
      raise exception 'This video pack was already decided.' using errcode = 'P0001';
    end if;
    raise exception 'Video pack not found.' using errcode = 'P0002';
  end if;
  if p_action = 'dismissed' and p_reason is not null and char_length(trim(p_reason)) > 0 then
    insert into public.cmo_memories (user_id, type, body)
    values (v_user, 'feedback', left('Skipped a video pack: ' || trim(p_reason), 600));
  end if;
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
-- Name: cmo_enqueue(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.cmo_runs;
  v_price integer := public.cmo_job_price(p_kind);
begin
  if p_kind is null or p_kind = 'onboard' or public.cmo_job_daily_limit(p_kind) <= 0 then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 4096 then
    raise exception 'This request is not valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':cmo_run', 1713));

  select * into v_row from public.cmo_runs
  where user_id = p_user and kind = p_kind and status in ('queued', 'running')
    and (status = 'queued' or lease_until is null or lease_until > now())
  order by created_at desc limit 1;
  if found then
    return v_row;
  end if;

  if (select count(*) from public.cmo_runs
      where user_id = p_user and kind = p_kind and created_at > now() - interval '1 day') >= public.cmo_job_daily_limit(p_kind) then
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
-- Name: cmo_job_daily_limit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_job_daily_limit(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 when 'video_pack' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 when 'review_week' then 1
    else 0 end
$$;


--
-- Name: cmo_job_price(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_job_price(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 when 'video_pack' then 1
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 when 'review_week' then 0
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
begin
  if v_url is not null and v_url !~ '^https://(www\.)?(x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}' then
    raise exception 'Paste the link to your post on X, like https://x.com/you/status/123.' using errcode = '22023';
  end if;
  update public.content_items set status = 'published', external_url = v_url, published_at = now(), updated_at = now()
  where id = p_id and user_id = v_user and status = 'approved'
  returning * into v_row;
  if not found then
    raise exception 'Approve the post before marking it as posted.' using errcode = 'P0001';
  end if;
  insert into public.operation_log (user_id, platform, action, target) values (v_user, 'x', 'publish', p_id::text)
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
        when new.body like 'Skipped a video pack%' then 'video'
        else 'general' end;
    end if;
    new.expires_at := coalesce(new.expires_at, now() + interval '90 days');
  end if;
  return new;
end;
$$;


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
  return v_count;
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
  if p_metric is null or p_metric not in ('posts', 'replies', 'clips', 'views') then
    raise exception 'The goal must count posts, replies, clips or views.' using errcode = '22023';
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
    CONSTRAINT cmo_memories_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 600))),
    CONSTRAINT cmo_memories_importance_check CHECK (((importance >= 1) AND (importance <= 3))),
    CONSTRAINT cmo_memories_kind_check CHECK ((kind = ANY (ARRAY['preference'::text, 'fact'::text, 'feedback'::text, 'result'::text]))),
    CONSTRAINT cmo_memories_topic_check CHECK ((topic = ANY (ARRAY['general'::text, 'post'::text, 'sales'::text, 'video'::text, 'research'::text]))),
    CONSTRAINT cmo_memories_type_check CHECK ((type = ANY (ARRAY['feedback'::text, 'user'::text])))
);


--
-- Name: cmo_remember(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_remember(p_body text, p_topic text DEFAULT 'general'::text) RETURNS public.cmo_memories
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
  -- At the cap, drop the least important, oldest note rather than simply the oldest one.
  if (select count(*) from public.cmo_memories where user_id = v_user) >= 200 then
    delete from public.cmo_memories where id in (
      select id from public.cmo_memories where user_id = v_user order by importance, created_at limit 1
    );
  end if;
  insert into public.cmo_memories (user_id, type, kind, topic, importance, body)
  values (v_user, 'user', 'preference', p_topic, 3, trim(p_body))
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
-- Name: cmo_run_step(uuid, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_run_step(p_run uuid, p_attempt integer, p_steps jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.cmo_runs set steps = p_steps, lease_until = now() + interval '300 seconds'
  where id = p_run and attempt = p_attempt and status = 'running';
  return found;
end;
$$;


--
-- Name: cmo_save_draft(uuid, uuid, uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_draft(p_user uuid, p_run uuid, p_item uuid, p_idea text, p_body jsonb, p_priority text DEFAULT 'medium'::text) RETURNS public.content_items
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.content_items;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body->>'text', '') = '' then
    raise exception 'This draft is not valid.' using errcode = '22023';
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
    values (p_user, p_run, 'post', 'x', current_date, left(coalesce(nullif(p_idea, ''), 'Post for X'), 300),
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
    CONSTRAINT cmo_insights_kind_check CHECK ((kind = 'competitors'::text))
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
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    -- Chỉ bài ĐÃ ĐĂNG của chính người dùng: worker không ghi nhầm sang tài khoản khác.
    if exists (select 1 from public.content_items i where i.id = (v_row->>'item_id')::uuid and i.user_id = p_user and i.status = 'published') then
      insert into public.post_metrics (user_id, item_id, url, views, likes, replies, reposts)
      values (p_user, (v_row->>'item_id')::uuid, left(v_row->>'url', 500),
        greatest(0, coalesce((v_row->>'views')::bigint, 0)), greatest(0, coalesce((v_row->>'likes')::bigint, 0)),
        greatest(0, coalesce((v_row->>'replies')::bigint, 0)), greatest(0, coalesce((v_row->>'reposts')::bigint, 0)));
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
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10 then
    raise exception 'These conversations are not valid.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_score := least(100, greatest(0, coalesce((v_item->>'score')::integer, 0)));
    insert into public.opportunities (
      user_id, run_id, url, community, title, author, snippet, posted_at, comments, score, score_parts, reply, priority
    ) values (
      p_user, p_run, v_item->>'url', left(coalesce(v_item->>'community', ''), 100), left(v_item->>'title', 400),
      left(coalesce(v_item->>'author', ''), 100), left(coalesce(v_item->>'snippet', ''), 1200),
      nullif(v_item->>'posted_at', '')::timestamptz, greatest(0, coalesce((v_item->>'comments')::integer, 0)),
      v_score, coalesce(v_item->'score_parts', '[]'::jsonb), left(v_item->>'reply', 3000),
      case when v_score >= 85 then 'high' when v_score >= 70 then 'medium' else 'low' end
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
-- Name: cmo_save_video_pack(uuid, uuid, uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cmo_save_video_pack(p_user uuid, p_run uuid, p_job uuid, p_clips jsonb, p_captions jsonb) RETURNS public.video_packs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_row public.video_packs;
begin
  if not exists (select 1 from public.jobs where id = p_job and user_id = p_user) then
    raise exception 'That video is not in this account.' using errcode = 'P0002';
  end if;
  insert into public.video_packs (user_id, run_id, job_id, clips, captions)
  values (p_user, p_run, p_job, p_clips, p_captions)
  on conflict (run_id) do update set clips = excluded.clips, captions = excluded.captions
  returning * into v_row;
  return v_row;
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
-- Name: complete_full_edit(uuid, uuid, jsonb, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_full_edit(p_task_id uuid, p_attempt_id uuid, p_settings jsonb, p_settings_hash text, p_master jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and kind = 'prepare_full' and status = 'running'
    and attempt_id is not distinct from p_attempt_id
  for update;
  if not found then
    return exists (select 1 from public.tasks where id = p_task_id and status = 'done' and attempt_id is not distinct from p_attempt_id);
  end if;
  if not exists (select 1 from public.clips where id = v_task.clip_id and job_id = v_task.job_id and kind = 'full') then
    raise exception 'Full-video clip mismatch.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_settings) is distinct from 'object' or coalesce(p_settings_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Clip settings are invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_master) is distinct from 'object' or coalesce(p_master ->> 'object', '') = '' then
    raise exception 'Master is invalid.' using errcode = '22023';
  end if;

  update public.clips
  set settings = p_settings, settings_hash = p_settings_hash
  where id = v_task.clip_id and settings is null;

  update public.jobs
  set media_manifest = jsonb_set(
    coalesce(media_manifest, '{}'::jsonb) || jsonb_build_object('masters', coalesce(media_manifest -> 'masters', '{}'::jsonb)),
    array['masters', v_task.clip_id::text],
    p_master
  )
  where id = v_task.job_id;

  update public.tasks
  set status = 'done', error = null, finished_at = now(), lease_until = null
  where id = p_task_id;
  return true;
end;
$_$;


--
-- Name: complete_generation(uuid, uuid, text, text, numeric, integer, integer, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_generation(p_task_id uuid, p_attempt_id uuid, p_object_name text, p_name text, p_duration numeric, p_width integer, p_height integer, p_credits integer, p_words jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_task public.tasks;
  v_generation public.generations;
  v_asset public.media_assets;
  v_final int;
  v_words jsonb;
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
  -- Đường dẫn do worker tự đặt; kiểm lại để một lỗi ở worker không gắn file của
  -- project khác vào generation này.
  if p_object_name is null
     or p_object_name !~ ('^' || v_task.user_id || '/' || v_task.job_id || '/gen-[0-9a-f-]{36}\.[a-z0-9]{2,5}$') then
    raise exception 'invalid generated object name';
  end if;

  -- Mốc chữ chỉ có nghĩa với giọng đọc. Sai hình dạng thì BỎ, không làm hỏng
  -- lượt sinh đã trả tiền: voiceover vẫn dùng được, chỉ không có phụ đề.
  if v_generation.kind = 'voice' and p_words is not null
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

  insert into public.media_assets (user_id, job_id, storage_path, name, duration, width, height, status, words)
  values (v_task.user_id, v_task.job_id, 'media/' || p_object_name, left(coalesce(nullif(btrim(p_name), ''), 'Generated'), 200),
          p_duration, p_width, p_height, 'ready', v_words)
  returning * into v_asset;

  v_final := least(v_generation.credits_reserved, greatest(coalesce(p_credits, v_generation.credits_reserved), 0));
  update public.generations
  set status = 'done', credits_final = v_final, media_asset_id = v_asset.id, error = null, finished_at = now()
  where id = v_generation.id;
  if v_generation.credits_reserved - v_final > 0 then
    perform public.credit_settle(v_task.user_id, 'generation', v_generation.id, v_final, 'Generate refund', v_task.job_id);
  end if;
  update public.tasks
  set status = 'done', output = jsonb_build_object('media_asset_id', v_asset.id), error = null,
      finished_at = now(), lease_until = null
  where id = p_task_id;
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
-- Name: complete_media_probe(uuid, uuid, numeric, integer, integer, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_media_probe(p_asset_id uuid, p_attempt_id uuid, p_duration numeric, p_width integer, p_height integer, p_ok boolean, p_error text DEFAULT NULL::text) RETURNS boolean
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
    duration = p_duration, width = p_width, height = p_height, error = left(v_error, 500)
  where id = p_asset_id;
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
-- Name: create_clip_job(text, integer, text, jsonb, text, text, text, boolean, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_clip_job(p_source_url text, p_clips integer DEFAULT 5, p_length text DEFAULT 'auto'::text, p_segments jsonb DEFAULT NULL::jsonb, p_mode text DEFAULT 'clip'::text, p_aspect text DEFAULT '9:16'::text, p_layout text DEFAULT 'auto'::text, p_captions boolean DEFAULT true, p_caption_preset text DEFAULT 'bold'::text, p_ownership_confirmed boolean DEFAULT false) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_source text := btrim(coalesce(p_source_url, ''));
  v_upload boolean := v_source like 'storage://%';
  v_job public.jobs;
begin
  if not v_upload and not coalesce(p_ownership_confirmed, false) then
    raise exception 'Confirm this is your own video to continue.' using errcode = '22023';
  end if;
  v_job := public.create_job(v_source, p_clips, p_length, p_segments, p_mode, p_aspect, p_layout, p_captions, p_caption_preset);
  insert into public.video_ownership (job_id, user_id, source, url)
  values (v_job.id, v_user, case when v_upload then 'upload' else 'link' end, case when v_upload then null else v_source end);
  return v_job;
end;
$$;


--
-- Name: create_full_edit(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_full_edit(p_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
  v_clip public.clips;
  v_task public.tasks;
  v_ready boolean;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = v_user;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if coalesce(v_job.source_url, '') not like 'storage://%' then
    raise exception 'Full-video editing works on videos you uploaded. For a link, edit the clips.' using errcode = '22023';
  end if;
  if v_job.status <> 'done' or v_job.duration_seconds is null or v_job.duration_seconds <= 0 then
    raise exception 'Wait for the video to finish processing.' using errcode = 'P0001';
  end if;
  if v_job.duration_seconds > public.full_edit_max_seconds() then
    raise exception 'Full-video editing supports videos up to % minutes.', public.full_edit_max_seconds() / 60
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text, 2201));
  select * into v_clip from public.clips where job_id = p_job_id and kind = 'full';
  if not found then
    insert into public.clips (job_id, idx, hook, start_seconds, end_seconds, source_start, source_end, kind)
    values (p_job_id, -1, 'Full video', 0, v_job.duration_seconds, 0, v_job.duration_seconds, 'full')
    returning * into v_clip;
  end if;

  v_ready := (v_job.media_manifest -> 'masters' -> (v_clip.id::text)) is not null
    and v_clip.settings is not null;
  if v_ready then
    return jsonb_build_object('clip_id', v_clip.id, 'ready', true, 'task_id', null);
  end if;

  select * into v_task from public.tasks
  where clip_id = v_clip.id and kind = 'prepare_full' and status in ('queued', 'running')
  order by created_at desc limit 1;
  if not found then
    insert into public.tasks (user_id, kind, clip_id, job_id, payload, status, request_id)
    values (v_user, 'prepare_full', v_clip.id, p_job_id, '{}'::jsonb, 'queued', gen_random_uuid())
    returning * into v_task;
  end if;
  return jsonb_build_object('clip_id', v_clip.id, 'ready', false, 'task_id', v_task.id);
end;
$$;


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

  select * into v_generation from public.generations
  where job_id = p_job_id and spec_hash = p_spec_hash and status in ('queued', 'running', 'done');
  if found then
    return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', true);
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

  insert into public.generations (user_id, job_id, clip_id, kind, model, spec, spec_hash, credits_reserved)
  values (v_user, p_job_id, p_clip_id, v_model.kind, v_model.id, p_spec, p_spec_hash, v_price)
  returning * into v_generation;
  insert into public.tasks (user_id, kind, job_id, clip_id, payload, request_id)
  values (v_user, 'generate', p_job_id, p_clip_id, jsonb_build_object('generation_id', v_generation.id), p_request_id)
  returning * into v_task;
  update public.generations set task_id = v_task.id where id = v_generation.id returning * into v_generation;
  if v_price > 0 then
    perform public.credit_hold(v_user, 'generation', v_generation.id, v_price, 'Generate hold', p_job_id);
  end if;

  return jsonb_build_object('generation', to_jsonb(v_generation), 'reused', false);
end;
$_$;


--
-- Name: create_job(text, integer, text, jsonb, text, text, text, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_job(p_source_url text, p_clips integer DEFAULT 5, p_length text DEFAULT 'auto'::text, p_segments jsonb DEFAULT NULL::jsonb, p_mode text DEFAULT 'clip'::text, p_aspect text DEFAULT '9:16'::text, p_layout text DEFAULT 'auto'::text, p_captions boolean DEFAULT true, p_caption_preset text DEFAULT 'bold'::text) RETURNS public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_length text := coalesce(p_length, 'auto');
  v_job public.jobs;
  v_source text := trim(coalesce(p_source_url, ''));
  v_segments jsonb := p_segments;
  v_clips int := p_clips;
  v_mode text := coalesce(p_mode, 'clip');
  v_aspect text := coalesce(p_aspect, '9:16');
  v_layout text := coalesce(p_layout, 'auto');
  v_captions boolean := coalesce(p_captions, true);
  v_preset text := coalesce(p_caption_preset, 'bold');
  v_prev numeric;
  v_item jsonb;
begin
  if v_source = '' then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;
  if v_source not like 'storage://%'
     and (
       v_source !~* '^https?://[^/@[:space:]]+([/:?#]|$)'
       or v_source ~* '^https?://[^/]*@'
       or v_source ~* '^https?://(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)([/:?#]|[0-9])'
       or v_source ~* '^https?://\[::1\]([/:?#]|$)'
     )
  then
    raise exception 'Paste a public HTTP or HTTPS video link.' using errcode = '22023';
  end if;

  if v_mode not in ('clip', 'full') then
    raise exception 'Choose whether to clip the video or download it whole.' using errcode = '22023';
  end if;

  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
  end if;
  if v_mode = 'full' then
    if v_segments is not null then
      raise exception 'Picked moments only apply when we clip your video.' using errcode = '22023';
    end if;
    v_clips := 1;
  end if;

  if v_segments is not null then
    if jsonb_typeof(v_segments) <> 'array' then
      raise exception 'Pick the moments you want on the timeline.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_segments) > 10 then
      raise exception 'Pick at most 10 moments.' using errcode = '22023';
    end if;

    v_prev := null;
    for v_item in
      select value from jsonb_array_elements(v_segments)
      order by (value ->> 'start')::numeric
    loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or jsonb_typeof(v_item -> 'start') is distinct from 'number'
         or jsonb_typeof(v_item -> 'end') is distinct from 'number' then
        raise exception 'Each moment needs a start and end time.' using errcode = '22023';
      end if;
      if (v_item ->> 'start')::numeric < 0 then
        raise exception 'A moment cannot start before the video does.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric < 1 then
        raise exception 'Each moment must be at least 1 second long.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric > 180 then
        raise exception 'Each moment must be 3 minutes or shorter.' using errcode = '22023';
      end if;
      if v_prev is not null and (v_item ->> 'start')::numeric < v_prev then
        raise exception 'Your moments overlap. Move them apart and try again.' using errcode = '22023';
      end if;
      v_prev := (v_item ->> 'end')::numeric;
    end loop;

    select jsonb_agg(value order by (value ->> 'start')::numeric)
    into v_segments from jsonb_array_elements(v_segments);
    v_clips := jsonb_array_length(v_segments);
  end if;

  if v_clips < 1 or v_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;
  if v_length not in ('auto', 'short', 'medium', 'long') then
    raise exception 'Choose a clip length.' using errcode = '22023';
  end if;
  if v_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Unsupported aspect ratio.' using errcode = '22023';
  end if;
  if v_layout not in ('auto', 'fill', 'fit') then
    raise exception 'Unsupported frame layout.' using errcode = '22023';
  end if;
  if v_preset not in ('bold', 'clean', 'minimal') then
    raise exception 'Unsupported caption style.' using errcode = '22023';
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

  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources', substring(v_source from 11), null);
  end if;

  perform 1 from public.profiles where id = v_user for update;
  v_balance := public.credit_balance(v_user);
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs(
    user_id, source_url, clips_requested, clip_length, watermark, segments,
    mode, aspect, layout, captions, caption_preset
  ) values(
    v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments,
    v_mode, v_aspect, v_layout, v_captions, v_preset
  ) returning * into v_job;

  perform public.credit_hold(v_user, 'job', v_job.id, v_hold, 'Hold for new job', v_job.id);
  return v_job;
end;
$_$;


--
-- Name: create_video_pack(text, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_video_pack(p_source text, p_confirmed boolean DEFAULT false, p_clips integer DEFAULT 5) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_source text := trim(coalesce(p_source, ''));
  v_upload boolean := v_source like 'storage://%';
  v_job public.jobs;
  v_run public.cmo_runs;
begin
  if not v_upload and not coalesce(p_confirmed, false) then
    raise exception 'Confirm that this is your own video.' using errcode = '22023';
  end if;
  if exists (select 1 from public.cmo_runs where user_id = v_user and kind = 'video_pack' and status in ('queued', 'running')) then
    raise exception 'Your last video pack is still being made.' using errcode = 'P0001';
  end if;
  v_job := public.create_job(v_source, coalesce(p_clips, 5), 'auto', null, 'clip', '9:16', 'auto', true, 'bold');
  update public.projects set kind = 'video_pack' where job_id = v_job.id;
  insert into public.video_ownership (job_id, user_id, source, url)
  values (v_job.id, v_user, case when v_upload then 'upload' else 'link' end, case when v_upload then null else v_source end);
  v_run := public.cmo_enqueue(v_user, 'video_pack', jsonb_build_object('job_id', v_job.id));
  return jsonb_build_object('job', to_jsonb(v_job), 'run', to_jsonb(v_run));
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
-- Name: editor_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editor_projects (
    clip_id uuid NOT NULL,
    manifest jsonb DEFAULT '{"assets": [], "folders": [], "version": 1}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    document jsonb NOT NULL,
    generated_document jsonb,
    CONSTRAINT editor_projects_document_check CHECK (((document IS NULL) OR (octet_length((document)::text) < 262144))),
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
-- Name: enqueue_cmo_run(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_cmo_run(p_kind text, p_input jsonb DEFAULT '{}'::jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
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
    -- Browser upload tồn tại trước khi worker có output manifest; payload là
    -- tham chiếu bền vững duy nhất trong khe đó.
    select coalesce(t.payload->>'bucket', 'exports'), t.payload->>'object'
      from public.tasks t
      left join public.clips c on c.id = t.clip_id
     where (t.job_id = p_job_id or c.job_id = p_job_id)
       and t.kind in ('client_export', 'finalize', 'render_document')
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
-- Name: full_edit_max_seconds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.full_edit_max_seconds() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 900 $$;


--
-- Name: generation_active_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generation_active_limit() RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$ select 6 $$;


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
    -- `%` và `_` người dùng gõ là chữ, không phải ký tự đại diện. Escape `\`
    -- trước, nếu không thì hai lần thay sau lại escape chính dấu vừa thêm.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select j.*
  from public.projects p
  join public.jobs j on j.id = p.job_id
  where p.user_id = v_user
    and p.kind in ('clip', 'video_pack')
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
    kind text DEFAULT 'moment'::text NOT NULL,
    settings jsonb,
    settings_hash text,
    CONSTRAINT clips_kind_check CHECK ((kind = ANY (ARRAY['moment'::text, 'full'::text, 'blank'::text]))),
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

  if v_link is not null and v_link<>v_customer then return jsonb_build_object('ok',true,'skipped','account already linked'); end if;
  update public.profiles set polar_customer_id=v_customer where id=v_user;
  insert into public.polar_customers(customer_id,user_id) values(v_customer,v_user);
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
-- Name: publish_job_clip(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_job_clip(p_job_id uuid, p_attempt_id uuid, p_clip jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_job public.jobs;
  v_clip public.clips;
  v_old public.clips;
  v_path text;
begin
  select * into v_job from public.jobs where id=p_job_id for update;
  if not found or p_attempt_id is null or v_job.status <> 'running'
     or v_job.attempt_id is distinct from p_attempt_id then return false; end if;
  if p_clip is null or jsonb_typeof(p_clip) <> 'object'
     or coalesce(p_clip->>'id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(p_clip->'idx') is distinct from 'number'
     or (p_clip->>'idx') !~ '^[0-9]{1,6}$'
     or jsonb_typeof(p_clip->'start_seconds') is distinct from 'number'
     or jsonb_typeof(p_clip->'end_seconds') is distinct from 'number'
     or (p_clip ? 'score' and p_clip->'score' <> 'null'::jsonb and jsonb_typeof(p_clip->'score') <> 'number') then
    raise exception 'A clip is missing required fields.' using errcode='22023';
  end if;
  if (p_clip->>'start_seconds')::numeric < 0 or (p_clip->>'end_seconds')::numeric <= (p_clip->>'start_seconds')::numeric then
    raise exception 'A clip must end after it starts.' using errcode='22023';
  end if;
  -- Bucket clips: chỉ nhận key tương đối thuộc đúng chủ sở hữu và project.
  if p_clip->>'storage_path' is null then
    raise exception 'Invalid clip storage path.' using errcode='22023';
  end if;
  foreach v_path in array array[p_clip->>'storage_path',p_clip->>'preview_path'] loop
    if v_path is not null and v_path !~ ('^'||v_job.user_id::text||'/'||p_job_id::text||'/[A-Za-z0-9_-]+/[A-Za-z0-9][A-Za-z0-9._-]*$') then
      raise exception 'Invalid clip storage path.' using errcode='22023';
    end if;
  end loop;
  v_clip.id := (p_clip->>'id')::uuid; v_clip.job_id := p_job_id;
  v_clip.idx := (p_clip->>'idx')::int; v_clip.hook := p_clip->>'hook';
  v_clip.start_seconds := (p_clip->>'start_seconds')::numeric;
  v_clip.end_seconds := (p_clip->>'end_seconds')::numeric;
  v_clip.source_start := v_clip.start_seconds; v_clip.source_end := v_clip.end_seconds;
  v_clip.score := (p_clip->>'score')::numeric; v_clip.reason := p_clip->>'reason';
  v_clip.storage_path := p_clip->>'storage_path'; v_clip.preview_path := p_clip->>'preview_path';
  select * into v_old from public.clips where id=v_clip.id;
  if found then
    if row(v_old.job_id,v_old.idx,v_old.hook,v_old.start_seconds,v_old.end_seconds,v_old.score,v_old.reason,v_old.storage_path,v_old.preview_path,v_old.source_start,v_old.source_end)
      is distinct from row(v_clip.job_id,v_clip.idx,v_clip.hook,v_clip.start_seconds,v_clip.end_seconds,v_clip.score,v_clip.reason,v_clip.storage_path,v_clip.preview_path,v_clip.source_start,v_clip.source_end) then
      raise exception 'This clip was already published with different content.' using errcode='22023';
    end if;
    return true;
  end if;
  if exists(select 1 from public.clips where job_id=p_job_id and idx=v_clip.idx) then
    raise exception 'A different clip already exists at this position.' using errcode='22023';
  end if;
  insert into public.clips(id,job_id,idx,hook,start_seconds,end_seconds,score,reason,storage_path,preview_path,source_start,source_end)
    values(v_clip.id,v_clip.job_id,v_clip.idx,v_clip.hook,v_clip.start_seconds,v_clip.end_seconds,v_clip.score,v_clip.reason,v_clip.storage_path,v_clip.preview_path,v_clip.source_start,v_clip.source_end);
  return true;
end; $_$;


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
      -- Đang có việc chạy dở (worker giữ lease): để lượt cron sau.
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
    where o.bucket_id in ('clips', 'sources', 'renders', 'media', 'exports', 'brand')
      and o.name like v_user::text || '/%'
      and not exists (
        select 1 from public.storage_deletions d where d.bucket = o.bucket_id and d.path = o.name
      );
    return next v_user;
  end loop;
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
      or (p_bucket = 'editor-write' and p_limit = 240 and p_window_seconds = 60)
      or (p_bucket = 'zip' and p_limit = 20 and p_window_seconds = 3600)
      or (p_bucket = 'media' and p_limit = 60 and p_window_seconds = 3600)
      or (p_bucket = 'scene_codes' and p_limit = 300 and p_window_seconds = 3600)
      or (p_bucket = 'feedback' and p_limit = 20 and p_window_seconds = 3600);
  end if;

  if not v_allowed then
    raise exception 'Invalid rate limit.' using errcode = '22023';
  end if;

  -- Cửa sổ ngắn của preview/export đếm ở hàng riêng: phút đầu sau nửa đêm UTC,
  -- cửa sổ 60 giây và cửa sổ ngày có cùng `window_start` nên từng cộng dồn vào
  -- hạn mức ngày (CI đỏ lúc 00:00:24 UTC 04/10).
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
      where old.kind in ('client_export', 'finalize', 'render_document')
  ) as source
  where source.path is not null and source.path <> '' and source.path not like '%..%'
    and source.bucket in ('clips', 'sources', 'renders', 'media', 'exports')
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;


--
-- Name: refund_caption_translation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_caption_translation(p_charge_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_row public.caption_translations;
begin
  select * into v_row from public.caption_translations
  where id = p_charge_id and user_id = v_user for update;
  if not found or v_row.status <> 'charged' then
    return false;
  end if;
  update public.caption_translations set status = 'refunded' where id = v_row.id;
  perform public.credit_refund(v_user, 'caption_translation', v_row.id, 'Caption translation refund',
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
    CONSTRAINT media_assets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'rejected'::text]))),
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
  if v_clip.kind <> 'blank' then
    raise exception 'Only edits started from a blank canvas can be renamed here.' using errcode = '22023';
  end if;
  update public.clips set hook = v_name where id = v_clip.id;
  update public.jobs set title = v_name where id = v_clip.job_id;
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
        and kind in ('preview', 'export', 'client_export', 'finalize', 'render_document')
        and status in ('awaiting_upload', 'queued', 'running')) >= 20 then
    raise exception 'You already have 20 previews or exports in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  select coalesce(plan, 'free') into v_plan
  from public.profiles where id = v_user;
  select * into v_quota from public.plan_quota(v_plan);
  if not public.rate_limit_hit('export', v_quota.exports_per_day, 86400) then
    raise exception 'You have reached today''s limit for this plan.' using errcode = 'P0001';
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
    perform public.release_rate_limit_for(v_user, 'export', now());
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
begin
  v_clip := public.owned_clip(p_clip_id, v_user);
  select * into v_asset from public.media_assets
  where id = p_media_id and user_id = v_user and job_id = v_clip.job_id
    and status <> 'rejected' and storage_path like 'media/%';
  if not found then
    raise exception 'This file is not stored with this project. Wait for it to finish uploading.' using errcode = 'P0002';
  end if;
  -- Thư viện báo "synced" ngay khi upload xong, trước khi worker đo xong độ dài: client
  -- thấy câu "still being processed" (409) thì chờ rồi gọi lại, không bắt người dùng bấm lần hai.
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
  if v_out - v_in > public.captions_max_seconds() then
    raise exception 'Captions work on up to % minutes at a time. Trim the clip first.', public.captions_max_seconds() / 60
      using errcode = '22023';
  end if;
  v_credits := public.captions_credits(v_out - v_in);

  perform public.lock_credit_owner(v_user);
  if p_request_id is not null then
    select * into v_task from public.tasks where request_id = p_request_id and user_id = v_user;
    if found then
      return jsonb_build_object('task_id', v_task.id, 'credits', (v_task.payload ->> 'credits')::int);
    end if;
  end if;
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
-- Name: request_original_zip(uuid, uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_original_zip(p_job_id uuid, p_clip_ids uuid[], p_request_id uuid) RETURNS public.tasks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_items jsonb;
  v_task public.tasks;
  v_count int;
begin
  if p_request_id is null then raise exception 'Missing request id.' using errcode='22023'; end if;
  if p_clip_ids is null or cardinality(p_clip_ids)=0 then raise exception 'Choose at least one clip.' using errcode='22023'; end if;
  if cardinality(p_clip_ids)>10 then raise exception 'Choose at most 10 clips.' using errcode='22023'; end if;
  if (select count(distinct id) from unnest(p_clip_ids) id) <> cardinality(p_clip_ids) then
    raise exception 'Choose each clip only once.' using errcode='22023';
  end if;
  if not exists(select 1 from public.jobs where id=p_job_id and user_id=v_user) then
    raise exception 'Project not found.' using errcode='P0002';
  end if;
  select count(*),jsonb_agg(c.id::text order by c.id) into v_count,v_items
    from public.clips c join public.jobs j on j.id=c.job_id
    where c.id=any(p_clip_ids) and c.job_id=p_job_id and j.user_id=v_user and c.storage_path is not null;
  if v_count <> cardinality(p_clip_ids) then
    raise exception 'One or more clips are not ready to download.' using errcode='P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,1701));
  select * into v_task from public.tasks where request_id=p_request_id;
  if found then
    if v_task.user_id is distinct from v_user or v_task.kind <> 'zip' or v_task.job_id is distinct from p_job_id
       or v_task.payload is distinct from jsonb_build_object('clip_ids',v_items) then
      raise exception 'This request id was already used for something else.' using errcode='22023';
    end if;
    return v_task;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,1702));
  if (select count(*) from public.tasks where user_id=v_user and kind in ('preview','export','zip') and status in ('queued','running')) >= 20 then
    raise exception 'You already have 20 downloads or renders in progress. Please wait for one to finish.' using errcode='P0001';
  end if;
  perform public.consume_daily_task_quota('export');
  insert into public.tasks(user_id,kind,job_id,payload,request_id)
    values(v_user,'zip',p_job_id,jsonb_build_object('clip_ids',v_items),p_request_id) returning * into v_task;
  return v_task;
end; $$;


--
-- Name: request_zip(uuid, uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_zip(p_job_id uuid, p_clip_ids uuid[], p_request_id uuid) RETURNS public.tasks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_user uuid := public.require_user();
  v_count int;
  v_items jsonb;
  v_task public.tasks;
begin
  if p_request_id is null then
    raise exception 'Missing request id.' using errcode = '22023';
  end if;
  if p_clip_ids is null or array_length(p_clip_ids, 1) is null then
    raise exception 'Choose at least one clip.' using errcode = '22023';
  end if;
  -- Trần 10: `zip_task.py` từ chối payload dài hơn thế.
  if array_length(p_clip_ids, 1) > 10 then
    raise exception 'Choose at most 10 clips.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.jobs where id = p_job_id and user_id = v_user) then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  -- Gọi lại cùng request_id (mạng gửi lại, bấm hai lần) trả đúng task cũ.
  select * into v_task from public.tasks where request_id = p_request_id;
  if found then
    if v_task.kind <> 'zip' or v_task.job_id is distinct from p_job_id then
      raise exception 'This request id was already used for something else.'
        using errcode = '22023';
    end if;
    return v_task;
  end if;

  -- Ảnh chụp lúc bấm: bản mới nhất là revision editor LỚN NHẤT, không phải task
  -- xong sau cùng — cùng luật với `latestExportByRevision` của trang project, để
  -- ZIP chứa đúng file mà trang đang cho tải. Chỉ clip thuộc đúng project + đúng
  -- người dùng: worker chạy bằng service role sẽ gói bất cứ id nào ở đây.
  select count(*), jsonb_agg(to_jsonb(t.id::text) order by t.idx)
    into v_count, v_items
  from (
    select distinct on (c.id)
      c.id as clip_id, c.idx, k.id
    from public.clips c
    join public.jobs j on j.id = c.job_id
    join public.tasks k on k.clip_id = c.id
    join public.editor_revisions r on r.id = k.editor_revision_id
    where c.id = any(p_clip_ids)
      and c.job_id = p_job_id
      and j.user_id = v_user
      and k.kind = 'render_document'
      and k.status = 'done'
    order by c.id, r.number desc, k.finished_at desc nulls last
  ) t;

  if v_count = 0 then
    raise exception 'Export these clips before downloading them together.'
      using errcode = 'P0002';
  end if;

  insert into public.tasks (user_id, kind, job_id, payload, request_id)
  values (v_user, 'zip', p_job_id, jsonb_build_object('export_task_ids', v_items), p_request_id)
  on conflict do nothing
  returning * into v_task;

  if not found then
    select * into v_task from public.tasks where request_id = p_request_id;
    if not found then
      raise exception 'Could not start the download. Please try again.' using errcode = 'P0001';
    end if;
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

  select status into v_status
  from public.jobs
  where id = p_job_id and user_id = v_user
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
declare
  v_window interval := case when new.mode = 'full'
                            then interval '24 hours'
                            else interval '7 days' end;
begin
  if new.status::text in ('done', 'failed', 'cancelled')
     and new.status is distinct from old.status then
    new.expires_at := coalesce(new.finished_at, now()) + v_window;
  elsif new.status::text in ('queued', 'running')
        and old.status::text in ('done', 'failed', 'cancelled') then
    -- Retry phải có một cửa sổ mới; cron không được dọn source giữa lần chạy.
    new.expires_at := now() + v_window;
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
-- Name: signup_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.signup_credits() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ select 0 $$;


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
  end if;
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
    CONSTRAINT credit_ledger_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['job'::text, 'generation'::text, 'captions'::text, 'caption_translation'::text, 'agent_turn'::text, 'cmo_run'::text]))),
    CONSTRAINT credit_ledger_ref_pair CHECK (((ref_kind IS NULL) = (ref_id IS NULL)))
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
    CONSTRAINT generations_credits_final_check CHECK ((credits_final >= 0)),
    CONSTRAINT generations_credits_reserved_check CHECK ((credits_reserved >= 0)),
    CONSTRAINT generations_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'voice'::text, 'audio'::text]))),
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
    CONSTRAINT post_metrics_likes_check CHECK ((likes >= 0)),
    CONSTRAINT post_metrics_replies_check CHECK ((replies >= 0)),
    CONSTRAINT post_metrics_reposts_check CHECK ((reposts >= 0)),
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
    retention_exempt boolean DEFAULT false NOT NULL
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
    CONSTRAINT projects_kind_check CHECK ((kind = ANY (ARRAY['clip'::text, 'video_pack'::text, 'edit'::text])))
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
    CONSTRAINT storage_deletions_bucket_check CHECK ((bucket = ANY (ARRAY['clips'::text, 'sources'::text, 'renders'::text, 'media'::text, 'exports'::text, 'brand'::text]))),
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
-- Name: video_ownership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_ownership (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    source text NOT NULL,
    url text,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT video_ownership_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'link'::text]))),
    CONSTRAINT video_ownership_url_check CHECK (((url IS NULL) OR (char_length(url) <= 2000)))
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
-- Name: storage_deletions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_deletions ALTER COLUMN id SET DEFAULT nextval('public.storage_deletions_id_seq'::regclass);


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
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (job_id, kind, version);


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
-- Name: cmo_video_briefs cmo_video_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_video_briefs
    ADD CONSTRAINT cmo_video_briefs_pkey PRIMARY KEY (id);


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
-- Name: polar_customers polar_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_customers
    ADD CONSTRAINT polar_customers_pkey PRIMARY KEY (customer_id);


--
-- Name: polar_customers polar_customers_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polar_customers
    ADD CONSTRAINT polar_customers_user_id_key UNIQUE (user_id);


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
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (user_id, bucket, window_start);


--
-- Name: scene_codes scene_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_codes
    ADD CONSTRAINT scene_codes_pkey PRIMARY KEY (user_id, hash);


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
-- Name: video_ownership video_ownership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_ownership
    ADD CONSTRAINT video_ownership_pkey PRIMARY KEY (job_id);


--
-- Name: video_packs video_packs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_packs
    ADD CONSTRAINT video_packs_pkey PRIMARY KEY (id);


--
-- Name: video_packs video_packs_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_packs
    ADD CONSTRAINT video_packs_run_id_key UNIQUE (run_id);


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
-- Name: clips_one_full_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX clips_one_full_idx ON public.clips USING btree (job_id) WHERE (kind = 'full'::text);


--
-- Name: cmo_goals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_goals_user_idx ON public.cmo_goals USING btree (user_id, week DESC);


--
-- Name: cmo_insights_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_insights_user_idx ON public.cmo_insights USING btree (user_id, kind, created_at DESC);


--
-- Name: cmo_lessons_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_lessons_user_idx ON public.cmo_lessons USING btree (user_id, week DESC);


--
-- Name: cmo_memories_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_memories_topic_idx ON public.cmo_memories USING btree (user_id, topic, importance DESC, created_at DESC);


--
-- Name: cmo_memories_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_memories_user_idx ON public.cmo_memories USING btree (user_id, created_at DESC);


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
-- Name: cmo_video_briefs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cmo_video_briefs_user_idx ON public.cmo_video_briefs USING btree (user_id, status, created_at DESC);


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
-- Name: editor_feedback_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_feedback_created_idx ON public.editor_feedback USING btree (created_at DESC);


--
-- Name: editor_revisions_clip_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX editor_revisions_clip_number_idx ON public.editor_revisions USING btree (clip_id, number DESC);


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
-- Name: storage_deletions_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletions_job_idx ON public.storage_deletions USING btree (job_id);


--
-- Name: storage_deletions_work_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_deletions_work_idx ON public.storage_deletions USING btree (attempts, id);


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
-- Name: video_packs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX video_packs_user_idx ON public.video_packs USING btree (user_id, status, created_at DESC);


--
-- Name: agent_messages agent_messages_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_messages_immutable BEFORE UPDATE ON public.agent_messages FOR EACH ROW EXECUTE FUNCTION public.agent_messages_immutable();


--
-- Name: credit_ledger apply_credit_ledger_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER apply_credit_ledger_insert AFTER INSERT ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.apply_credit_ledger_insert();


--
-- Name: clips clips_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clips_record_storage_deletions BEFORE DELETE ON public.clips FOR EACH ROW EXECUTE FUNCTION public.record_clip_storage_deletions();


--
-- Name: cmo_memories cmo_memories_classify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cmo_memories_classify BEFORE INSERT ON public.cmo_memories FOR EACH ROW EXECUTE FUNCTION public.cmo_memories_classify();


--
-- Name: editor_revisions editor_revisions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER editor_revisions_immutable BEFORE UPDATE ON public.editor_revisions FOR EACH ROW EXECUTE FUNCTION public.freeze_clip_revision();


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
-- Name: media_assets media_assets_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_assets_record_storage_deletions BEFORE DELETE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.record_media_storage_deletions();


--
-- Name: credit_ledger reject_credit_ledger_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_credit_ledger_change BEFORE DELETE OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.reject_credit_ledger_change();


--
-- Name: tasks tasks_record_storage_deletions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_record_storage_deletions BEFORE DELETE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.record_task_storage_deletions();


--
-- Name: tasks tasks_refund_media_captions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_refund_media_captions AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.refund_media_captions_from_task();


--
-- Name: tasks tasks_sync_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_sync_generation AFTER UPDATE OF status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.sync_generation_from_task();


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
-- Name: artifacts artifacts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


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
-- Name: clips clips_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips
    ADD CONSTRAINT clips_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


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
-- Name: cmo_video_briefs cmo_video_briefs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_video_briefs
    ADD CONSTRAINT cmo_video_briefs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: cmo_video_briefs cmo_video_briefs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cmo_video_briefs
    ADD CONSTRAINT cmo_video_briefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


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
-- Name: marketing_documents marketing_documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_documents
    ADD CONSTRAINT marketing_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


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
-- Name: scene_codes scene_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scene_codes
    ADD CONSTRAINT scene_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


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
-- Name: video_ownership video_ownership_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_ownership
    ADD CONSTRAINT video_ownership_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: video_ownership video_ownership_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_ownership
    ADD CONSTRAINT video_ownership_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: video_packs video_packs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_packs
    ADD CONSTRAINT video_packs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: video_packs video_packs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_packs
    ADD CONSTRAINT video_packs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cmo_runs(id) ON DELETE SET NULL;


--
-- Name: video_packs video_packs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_packs
    ADD CONSTRAINT video_packs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


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
-- Name: artifacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_kits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brand_kits ENABLE ROW LEVEL SECURITY;

--
-- Name: caption_translations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.caption_translations ENABLE ROW LEVEL SECURITY;

--
-- Name: clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

--
-- Name: cmo_goals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_goals ENABLE ROW LEVEL SECURITY;

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
-- Name: cmo_video_briefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cmo_video_briefs ENABLE ROW LEVEL SECURITY;

--
-- Name: content_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

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
-- Name: generations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

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
-- Name: cmo_video_briefs read own video briefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own video briefs" ON public.cmo_video_briefs FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: scene_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scene_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_deletions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_deletions ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: upload_reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.upload_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: video_ownership; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.video_ownership ENABLE ROW LEVEL SECURITY;

--
-- Name: video_packs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.video_packs ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_draft_initializations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_draft_initializations ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_operations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_operations ENABLE ROW LEVEL SECURITY;

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
-- Name: video_packs đọc gói video của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc gói video của mình" ON public.video_packs FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


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
-- Name: video_ownership đọc xác nhận của mình; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "đọc xác nhận của mình" ON public.video_ownership FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- PostgreSQL database dump complete
--


