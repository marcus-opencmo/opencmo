-- Review R6 (#144): load balance.
--
-- * claim_next_task / claim_task take p_max_running: with that many tasks already running (the worker's container cap)
--   they claim nothing, so a task waits in the database queue instead of in Modal's, where its 120 s lease ran out
--   and it failed after three tries without ever running. claim_next_task also takes the user with the fewest running
--   tasks first: one user's 20 exports no longer fill every container.
-- * reclaim_expired_tasks: a task that loses its lease three times gets a message for its kind, and a probe_media task
--   rejects its media asset (it stayed 'pending', "Checking video…", forever).
-- * agent_reap_turns checks the turn again once it holds the locks; a partial index serves its scan.
-- * cmo_dispatch_count: the sweep's count of CMO runs, by claim_cmo_run's own rule (it missed the pause filter).
-- * The legacy claim_next_job() (no attempt, no lease) is dropped: nothing calls it, and a call stranded a job.

drop function if exists public.claim_next_task(text[], integer);
create function public.claim_next_task(p_kinds text[], p_lease_seconds integer default 120, p_max_running integer default null)
  returns setof public.tasks
  language sql security definer
  set search_path to 'public'
  as $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = (
    select t.id from public.tasks t
    where t.status = 'queued' and t.kind = any(p_kinds)
      and (p_max_running is null
           or (select count(*) from public.tasks r where r.status = 'running' and r.kind = any(p_kinds)) < p_max_running)
    -- The user with the fewest running tasks first, then kind order and age: fair across users, priority within one.
    order by (select count(*) from public.tasks r where r.status = 'running' and r.user_id = t.user_id),
      array_position(p_kinds, t.kind), t.created_at
    -- `skip locked`: parallel claims never take the same task.
    for update skip locked
    limit 1
  )
  returning *;
$$;

drop function if exists public.claim_task(uuid, integer);
create function public.claim_task(p_task_id uuid, p_lease_seconds integer default 120, p_max_running integer default null)
  returns setof public.tasks
  language sql security definer
  set search_path to 'public'
  as $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = p_task_id and status = 'queued'
    -- Every container busy: the task stays queued and the sweep takes it when one frees up.
    and (p_max_running is null or (select count(*) from public.tasks r where r.status = 'running') < p_max_running)
  returning *;
$$;

create or replace function public.reclaim_expired_tasks(p_max_attempts integer default 3) returns jsonb
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  r record;
  v_requeued int := 0;
  v_failed int := 0;
begin
  for r in
    select id, attempt, attempt_id, kind, asset_id
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
          -- The users of each kind see this sentence: "Rendering" only where something was rendered.
          error = case r.kind
            when 'render_document' then 'Rendering stopped unexpectedly. Please try again.'
            when 'render_stills' then 'Rendering stopped unexpectedly. Please try again.'
            when 'probe_media' then 'We could not check this file. Upload it again.'
            when 'generate' then 'Generation failed. Your credits were refunded.'
            when 'publish_media' then 'Preparing the post stopped unexpectedly. Please try again.'
            when 'capture_page' then 'Capturing the page stopped unexpectedly. Please try again.'
            when 'transcribe_media' then 'Making the captions stopped unexpectedly. Please try again.'
            when 'transcribe_asset' then 'Transcribing stopped unexpectedly. Please try again.'
            else 'This stopped unexpectedly. Please try again.'
          end,
          finished_at = now(),
          lease_until = null
      where id = r.id and status = 'running'
        and attempt_id = r.attempt_id and lease_until < now();
      if found then
        v_failed := v_failed + 1;
        -- probe_media has no status trigger: without this its asset stayed 'pending' with no error, forever.
        if r.kind = 'probe_media' and r.asset_id is not null then
          update public.media_assets set status = 'rejected', error = 'We could not check this file. Upload it again.'
          where id = r.asset_id and status = 'pending';
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object('requeued', v_requeued, 'failed', v_failed);
end;
$$;

create or replace function public.agent_reap_turns() returns integer
  language plpgsql security definer
  set search_path to 'public'
  as $$
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
    -- Under the locks, check again (review R6): a turn the founder resumed between the scan and the locks (new hold,
    -- fresh session lock) must not be closed while it streams.
    if not exists (
      select 1 from public.agent_turns t join public.agent_sessions s on s.id = t.session_id
      where t.id = v_turn.id and t.status = v_turn.status
        and ((t.status in ('running', 'awaiting_browser') and (s.lock_until is null or s.lock_until < now()))
          or (t.status in ('awaiting_approval', 'awaiting_input', 'awaiting_continue') and s.updated_at < now() - interval '24 hours'))
    ) then
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

-- The reaper's scan every minute: only open turns, in age order, instead of every turn ever recorded.
create index if not exists agent_turns_open_idx on public.agent_turns (created_at)
  where status in ('running', 'awaiting_browser', 'awaiting_approval', 'awaiting_input', 'awaiting_continue');

-- What a call to /api/internal/cmo/run would claim now, by claim_cmo_run's rule (pause filter included).
create or replace function public.cmo_dispatch_count(p_limit integer default 10) returns integer
  language sql stable security definer
  set search_path to 'public'
  as $$
  select count(*)::integer from (
    select 1 from public.cmo_runs r
    where not public.cmo_paused(r.user_id)
      and ((r.status = 'queued' and (r.not_before is null or r.not_before <= now()))
        or (r.status = 'running' and r.kind <> 'onboard' and r.lease_until < now() and r.attempt < 3))
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  ) x;
$$;

drop function if exists public.claim_next_job();

revoke all on function public.claim_next_task(text[], integer, integer) from public, anon, authenticated;
revoke all on function public.claim_task(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.reclaim_expired_tasks(integer) from public, anon, authenticated;
revoke all on function public.agent_reap_turns() from public, anon, authenticated;
revoke all on function public.cmo_dispatch_count(integer) from public, anon, authenticated;
grant execute on function public.claim_next_task(text[], integer, integer) to service_role;
grant execute on function public.claim_task(uuid, integer, integer) to service_role;
grant execute on function public.reclaim_expired_tasks(integer) to service_role;
grant execute on function public.agent_reap_turns() to service_role;
grant execute on function public.cmo_dispatch_count(integer) to service_role;
