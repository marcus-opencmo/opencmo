-- Review extract (load): the current definition of each function, from supabase/schema/current.sql.
-- Read-only copy for review; the source of truth is supabase/migrations/. 8 functions.

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

