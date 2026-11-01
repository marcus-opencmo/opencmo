-- Review R5 (#143): credits.
--
-- * cmo_enqueue: a free founder's run never goes to the Claude inbox (it could not be answered over MCP, and its price
--   was kept); a running run past its lease is still in flight, so asking again does not hold twice.
-- * enqueue_cmo_run refuses the schedule's free jobs (review_week, pull_metrics, summarize_memory) for direct calls.
-- * cancel_job's 1-credit fee: also when exactly 1 was held, and under its own ref kind 'job_fee'.
-- * credit_held: an index for the pre-R6 'job' arm, so a lookup no longer scans the whole ledger.
-- * Sweeps for the cleanup cron: runs parked by a pause over a week, and caption translations left 'charged'.

alter table public.credit_ledger drop constraint if exists credit_ledger_ref_kind_check;
alter table public.credit_ledger add constraint credit_ledger_ref_kind_check check (ref_kind = any (array[
  'job', 'job_fee', 'generation', 'captions', 'caption_translation', 'agent_turn', 'cmo_run', 'work_order']));

-- credit_held's second arm reads pre-R6 rows by job_id; without an index the OR made every call a full scan.
create index if not exists credit_ledger_legacy_job_idx on public.credit_ledger (job_id) where ref_kind is null;

create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb) RETURNS public.cmo_runs
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
  -- The founder's own Claude answers inbox items over MCP, which is for paid plans only: a free founder's inbox item
  -- could never be answered, and its price was charged for nothing (review R5). Their run thinks with OpenCMO
  -- instead, and is refused below when they cannot pay for it.
  if p_input->>'brain' = 'claude' and not public.is_paid(p_user) then
    p_input := p_input - 'brain';
    v_price := public.cmo_job_price(p_kind);
  end if;
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
    -- A running run whose lease ran out is still in flight: claim_cmo_run puts it back in the queue. Treating it as
    -- gone made a second run and a second hold, and both ran (review R5).
    -- Without an item or order, only the same request is the same run: two posts with two briefs are two runs
    -- (review R4; the second brief used to be dropped while the chat said it had started).
    and (case when v_key is null then (input - 'brain') = (p_input - 'brain')
              else coalesce(input->>'item_id', input->>'order_id') = v_key end)
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


create or replace function public.enqueue_cmo_run(p_kind text, p_input jsonb DEFAULT '{}'::jsonb) RETURNS public.cmo_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Posting is ordered only by Schedule, for a slot whose card the founder approved.
  -- The schedule's own jobs are free and spend provider money (the planner model, ScrapeCreators): only the schedule
  -- queues them (enqueue_cmo_run_for), never a direct call (review R5).
  if p_kind in ('publish_post', 'review_week', 'pull_metrics', 'summarize_memory') then
    raise exception 'Unknown task.' using errcode = '22023';
  end if;
  return public.cmo_enqueue(public.require_user(), p_kind, p_input);
end;
$$;


create or replace function public.cancel_job(p_job_id uuid) RETURNS public.jobs
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
  -- Review R5: also when exactly 1 was held (every short upload once settle_job_credits ran), and under its own ref
  -- kind, so a Retry's hold and a later settle or refund of the job never absorb or return the fee.
  if v_was_running and v_refunded >= 1 then
    perform public.credit_hold(v_user, 'job_fee', p_job_id, 1, 'Cancelled while running', p_job_id);
  end if;
  update public.tasks set status = 'cancelled', finished_at = now(), lease_until = null
  where status in ('queued', 'running') and (
    job_id = p_job_id or clip_id in (select id from public.clips where job_id = p_job_id)
    or asset_id in (select id from public.media_assets where job_id = p_job_id)
  );
  return v_job;
end;
$$;


-- Runs parked by a pause hold their credits until the founder resumes. A short pause keeps them (resuming runs them,
-- by design); after a week they are failed and refunded, so a founder who never resumes does not lose the credits.
create or replace function public.cmo_release_parked_runs(p_days integer default 7) returns integer
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_run public.cmo_runs;
  v_n integer := 0;
begin
  for v_run in
    select r.* from public.cmo_runs r join public.profiles p on p.id = r.user_id
    where r.status = 'queued' and r.not_before = 'infinity'
      and p.cmo_paused_at is not null and p.cmo_paused_at < now() - make_interval(days => greatest(1, coalesce(p_days, 7)))
    for update of r skip locked
  loop
    update public.cmo_runs set status = 'failed', error = 'Cancelled: your CMO was paused for over a week. Your credits were refunded.',
      finished_at = now()
    where id = v_run.id;
    perform public.cmo_refund_run(v_run);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- A translation charge is refunded by the request that made it; one killed at the route's time limit (120 s) never
-- ran its refund. Anything still 'charged' after 15 minutes is such a request.
create or replace function public.refund_stale_caption_translations() returns integer
  language plpgsql security definer
  set search_path to 'public'
  as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in select id from public.caption_translations where status = 'charged' and created_at < now() - interval '15 minutes' loop
    if public.refund_caption_translation(v_id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.cmo_release_parked_runs(integer) from public, anon, authenticated;
revoke all on function public.refund_stale_caption_translations() from public, anon, authenticated;
grant execute on function public.cmo_release_parked_runs(integer) to service_role;
grant execute on function public.refund_stale_caption_translations() to service_role;
