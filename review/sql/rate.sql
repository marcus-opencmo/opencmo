-- Review extract (rate): the current definition of each function, from supabase/schema/current.sql.
-- Read-only copy for review; the source of truth is supabase/migrations/. 18 functions.

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

CREATE FUNCTION public.cmo_job_daily_limit(p_kind text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 when 'review_week' then 1
    when 'write_caption' then 20 when 'write_video_brief' then 5 when 'write_slides' then 10 when 'publish_post' then 100 when 'niche_video_research' then 2
    else 0 end
$$;

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

CREATE FUNCTION public.cmo_read_limit(p_bucket text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_bucket when 'mcp_social' then 60 when 'mcp_site' then 20 else 0 end
$$;

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

