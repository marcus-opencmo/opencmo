-- Review extract (credit): the current definition of each function, from supabase/schema/current.sql.
-- Read-only copy for review; the source of truth is supabase/migrations/. 30 functions.

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

CREATE FUNCTION public.cmo_job_price(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 when 'review_week' then 0
    when 'write_caption' then 1 when 'write_video_brief' then 1 when 'write_slides' then 1 when 'publish_post' then 0 when 'niche_video_research' then 2
    else 0 end
$$;

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

CREATE FUNCTION public.credit_held(p_ref_kind text, p_ref_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(-sum(delta), 0)::int from public.credit_ledger
  where (ref_kind = p_ref_kind and ref_id = p_ref_id)
     -- Dòng trước R6 chỉ có `job_id`: thời đó mọi dòng có job_id được tính là của job.
     or (p_ref_kind = 'job' and ref_kind is null and job_id = p_ref_id);
$$;

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

CREATE FUNCTION public.job_credits_spent(p_job_id uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.credit_held('job', p_job_id);
$$;

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

