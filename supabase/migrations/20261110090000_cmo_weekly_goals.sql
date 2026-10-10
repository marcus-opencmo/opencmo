-- 20261110090000: the AI CMO's weekly goal loop (architecture P2).
--
-- Each week has at most one goal ("Publish 5 posts on X"). The CMO proposes it (chat tool
-- `set_week_goal`, or the Sunday `review_week` job for next week); the founder approves or edits
-- it once on a card. `review_week` then measures the week against the approved goal, writes the
-- lesson, and proposes the next goal. The planner (W1) reads the approved goal.
--
-- A goal is a target for drafts the founder still approves one by one: nothing here posts.

begin;

create table public.cmo_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  -- Monday of the week the goal is for.
  week date not null check (extract(isodow from week) = 1),
  goal text not null check (char_length(goal) between 3 and 300),
  metric text not null check (metric in ('posts', 'replies', 'clips', 'views')),
  target integer not null check (target between 1 and 1000000),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  -- What review_week measured at the end of the week.
  result integer check (result >= 0),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (user_id, week)
);
create index cmo_goals_user_idx on public.cmo_goals (user_id, week desc);
alter table public.cmo_goals enable row level security;
create policy "read own CMO goals" on public.cmo_goals
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_goals from anon, authenticated;

-- Shared by both proposers: an approved goal is never overwritten by a proposal.
create or replace function public.cmo_put_goal(p_user uuid, p_run uuid, p_week date, p_goal text, p_metric text, p_target integer)
returns public.cmo_goals language plpgsql volatile security definer set search_path = public
as $$
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
revoke all on function public.cmo_put_goal(uuid, uuid, date, text, text, integer) from public, anon, authenticated;

-- CMO chat (runs as the founder): proposes a goal; it still needs the founder's approval.
create or replace function public.cmo_set_week_goal(p_week date, p_goal text, p_metric text, p_target integer)
returns public.cmo_goals language plpgsql volatile security definer set search_path = public
as $$
begin
  return public.cmo_put_goal(public.require_user(), null, p_week, p_goal, p_metric, p_target);
end;
$$;
revoke all on function public.cmo_set_week_goal(date, text, text, integer) from public, anon;
grant execute on function public.cmo_set_week_goal(date, text, text, integer) to authenticated;

-- review_week (service role, explicit user id like every job RPC): next week's proposal.
create or replace function public.cmo_propose_goal(p_user uuid, p_run uuid, p_week date, p_goal text, p_metric text, p_target integer)
returns public.cmo_goals language plpgsql volatile security definer set search_path = public
as $$
begin
  return public.cmo_put_goal(p_user, p_run, p_week, p_goal, p_metric, p_target);
end;
$$;
revoke all on function public.cmo_propose_goal(uuid, uuid, date, text, text, integer) from public, anon, authenticated;
grant execute on function public.cmo_propose_goal(uuid, uuid, date, text, text, integer) to service_role;

-- The founder's decision on the goal card; approving may edit the wording and the target.
create or replace function public.cmo_decide_goal(p_id uuid, p_action text, p_goal text default null, p_target integer default null)
returns public.cmo_goals language plpgsql volatile security definer set search_path = public
as $$
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
revoke all on function public.cmo_decide_goal(uuid, text, text, integer) from public, anon;
grant execute on function public.cmo_decide_goal(uuid, text, text, integer) to authenticated;

-- review_week records what the week reached against the approved goal.
create or replace function public.cmo_record_goal_result(p_user uuid, p_week date, p_result integer)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.cmo_goals set result = greatest(0, p_result)
  where user_id = p_user and week = p_week and status = 'approved';
  return found;
end;
$$;
revoke all on function public.cmo_record_goal_result(uuid, date, integer) from public, anon, authenticated;
grant execute on function public.cmo_record_goal_result(uuid, date, integer) to service_role;

-- The weekly review job --------------------------------------------------------------------------

alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan', 'video_pack', 'competitor_research', 'pull_metrics',
    'summarize_memory', 'review_week'));

create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 when 'video_pack' then 1
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 when 'review_week' then 0
    else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 when 'video_pack' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 when 'review_week' then 1
    else 0 end
$$;

commit;
