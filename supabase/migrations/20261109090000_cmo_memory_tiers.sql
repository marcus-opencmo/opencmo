-- 20261109090000: AI CMO memory in three tiers (architecture P1).
--
-- Tier 1, profile: the four marketing documents (unchanged).
-- Tier 2, events: `cmo_memories` rows gain a kind, a topic, an importance and an expiry, so a job
--   reads the notes for its own topic instead of the latest N rows of everything.
-- Tier 3, lessons: `cmo_lessons`, one short paragraph per topic per week, written by the weekly
--   `summarize_memory` job from that week's events. Chat and jobs read lessons every time and pull
--   raw events only when they match the topic.

begin;

-- Tier 2: typed events ---------------------------------------------------------------------------

alter table public.cmo_memories
  add column kind text not null default 'fact'
    check (kind in ('preference', 'fact', 'feedback', 'result')),
  add column topic text not null default 'general'
    check (topic in ('general', 'post', 'sales', 'video', 'research')),
  add column importance smallint not null default 2 check (importance between 1 and 3),
  add column expires_at timestamptz,
  add column source_run uuid references public.cmo_runs(id) on delete set null;

update public.cmo_memories set kind = case type when 'feedback' then 'feedback' else 'preference' end;
update public.cmo_memories set topic = 'post' where type = 'feedback' and body like 'Skipped the X post%';
update public.cmo_memories set topic = 'sales' where type = 'feedback' and body like 'Dismissed the Reddit thread%';
update public.cmo_memories set topic = 'video' where type = 'feedback' and body like 'Skipped a video pack%';
-- A preference the founder typed stays until they change it; a skip reason is about one draft and
-- fades after 90 days (the weekly lesson keeps what mattered).
update public.cmo_memories set expires_at = created_at + interval '90 days' where kind = 'feedback';

create index cmo_memories_topic_idx on public.cmo_memories (user_id, topic, importance desc, created_at desc);

-- The three "skipped with a reason" RPCs insert with only (user_id, type, body). Rather than copy
-- each of them again, this trigger files their rows under the right topic and expiry.
create or replace function public.cmo_memories_classify()
returns trigger language plpgsql set search_path = public
as $$
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
create trigger cmo_memories_classify before insert on public.cmo_memories
  for each row execute function public.cmo_memories_classify();

-- `remember` now takes a topic. Dropped and recreated: a second overload would make PostgREST
-- calls with only `p_body` ambiguous.
drop function public.cmo_remember(text);
create function public.cmo_remember(p_body text, p_topic text default 'general')
returns public.cmo_memories language plpgsql volatile security definer set search_path = public
as $$
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
revoke all on function public.cmo_remember(text, text) from public, anon;
grant execute on function public.cmo_remember(text, text) to authenticated;

-- Tier 3: weekly lessons -------------------------------------------------------------------------

create table public.cmo_lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.cmo_runs(id) on delete set null,
  -- Monday of the week the lesson covers.
  week date not null check (extract(isodow from week) = 1),
  topic text not null check (topic in ('general', 'post', 'sales', 'video', 'research')),
  body text not null check (char_length(body) between 1 and 600),
  created_at timestamptz not null default now(),
  unique (user_id, week, topic)
);
create index cmo_lessons_user_idx on public.cmo_lessons (user_id, week desc);
alter table public.cmo_lessons enable row level security;
create policy "read own CMO lessons" on public.cmo_lessons
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.cmo_lessons from anon, authenticated;

-- Written by the `summarize_memory` job (service role, explicit user id like every job RPC).
create or replace function public.cmo_save_lessons(p_user uuid, p_run uuid, p_week date, p_lessons jsonb)
returns integer language plpgsql volatile security definer set search_path = public
as $$
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
revoke all on function public.cmo_save_lessons(uuid, uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.cmo_save_lessons(uuid, uuid, date, jsonb) to service_role;

-- The weekly job ---------------------------------------------------------------------------------

alter table public.cmo_runs drop constraint if exists cmo_runs_kind_check;
alter table public.cmo_runs add constraint cmo_runs_kind_check
  check (kind in ('onboard', 'plan_week', 'post_draft', 'sales_scan', 'video_pack', 'competitor_research', 'pull_metrics',
    'summarize_memory'));

-- One cheap model call a week, run by the schedule: free, at most once a day.
create or replace function public.cmo_job_price(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 1 when 'post_draft' then 1 when 'sales_scan' then 5 when 'video_pack' then 1
    when 'competitor_research' then 2 when 'pull_metrics' then 0 when 'summarize_memory' then 0 else 0 end
$$;
create or replace function public.cmo_job_daily_limit(p_kind text)
returns integer language sql immutable as $$
  select case p_kind when 'plan_week' then 5 when 'post_draft' then 10 when 'sales_scan' then 3 when 'video_pack' then 3
    when 'competitor_research' then 2 when 'pull_metrics' then 2 when 'summarize_memory' then 1 else 0 end
$$;

-- Same as before, except the list of kinds is the daily-limit table: a new job kind is added in
-- one place (`cmo_job_daily_limit`) instead of two.
create or replace function public.cmo_enqueue(p_user uuid, p_kind text, p_input jsonb)
returns public.cmo_runs language plpgsql volatile security definer set search_path = public
as $$
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

commit;
