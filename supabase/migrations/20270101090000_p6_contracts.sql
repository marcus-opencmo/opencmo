-- 20270101090000: P6 A0, the contracts of reach, metrics, best time, the card budget and reply outcomes
-- (docs/plans/cmo/2026-10-28-p6-quality-reach-plan.md, sessions/A.md).
--
-- Skeleton only: the tables and RPCs the three sessions build on. Nothing sends email or push, reads Zernio, picks a
-- best time, holds a card or re-reads a thread yet (A1-A4, C0, C1).

begin;

-- Web push (C1). One row per browser; the endpoint is the push service's URL for it, unique across founders because a
-- browser belongs to one signed-in founder at a time (subscribing again moves it).
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{20,200}={0,2}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{8,100}={0,2}$'),
  user_agent text check (char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  -- The last send the push service refused with 404/410 removes the row; other failures only stamp it.
  failed_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Email and push preferences, and the token an unsubscribe link carries. The link works without signing in, so the
-- token is the only thing it can name; a fresh random value per founder, never derived from the user id.
create table public.notify_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_digest boolean not null default true,
  push boolean not null default true,
  unsubscribe_token uuid not null unique default gen_random_uuid(),
  unsubscribed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Every email sent (C0): at most one digest a founder's day, and one expiring-card email per card
-- (email_log_claim). `provider_id` is Resend's id once it accepted the email.
create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('digest', 'expiring')),
  -- The founder's local day the email belongs to (profiles.timezone).
  day date not null,
  approval_ids uuid[] not null check (cardinality(approval_ids) between 1 and 50),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  provider_id text check (char_length(provider_id) <= 100),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index email_log_one_digest on public.email_log (user_id, day) where kind = 'digest';
create index email_log_user_idx on public.email_log (user_id, created_at desc);

-- The daily card budget (A4): cards raised and held per founder's local day. Only new cards count; a card replaced by
-- an edit of the same thing does not.
create table public.card_budget (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  raised integer not null default 0 check (raised >= 0),
  held integer not null default 0 check (held >= 0),
  primary key (user_id, day)
);

-- A held card waits for a later day's budget (A4) and is not in the queue; time-bound cards are never held.
alter table public.approvals drop constraint approvals_status_check;
alter table public.approvals add constraint approvals_status_check
  check (status in ('waiting', 'held', 'approved', 'edited', 'skipped', 'expired', 'cancelled'));
alter table public.approvals add column held_until timestamptz;
alter table public.approvals add constraint approvals_held_until check (status <> 'held' or held_until is not null);

-- Per account per day, from Zernio for connected accounts (A1). Kept after a disconnect (`social_account_id` goes
-- null) so Analytics can say "no data since". A null number is "not reported", never zero.
create table public.account_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null check (platform in ('x', 'threads', 'linkedin', 'tiktok', 'youtube', 'instagram')),
  handle text not null check (char_length(handle) between 1 and 100),
  day date not null,
  followers bigint check (followers >= 0),
  impressions bigint check (impressions >= 0),
  engagements bigint check (engagements >= 0),
  video_views bigint check (video_views >= 0),
  posts integer check (posts >= 0),
  measured_at timestamptz not null default now(),
  unique (user_id, platform, handle, day)
);
create index account_metrics_user_idx on public.account_metrics (user_id, day desc);

-- Where a post's numbers came from: today's public reading, or Zernio for a post that went out through it.
alter table public.post_metrics
  add column source text not null default 'public' check (source in ('public', 'zernio')),
  add column impressions bigint check (impressions >= 0),
  add column engagements bigint check (engagements >= 0),
  -- Null is "not reported", never zero: Zernio leaves out what a platform does not give (views on LinkedIn, say), and
  -- a stored 0 would show as 0 impressions and pull the medians down.
  alter column views drop not null, alter column views drop default,
  alter column likes drop not null, alter column likes drop default,
  alter column replies drop not null, alter column replies drop default,
  alter column reposts drop not null, alter column reposts drop default;

-- The founder's own best hours per platform (A2), in their local time: median views per hour since posting, over
-- published posts with metrics. Only written once a platform has enough posts; until then the defaults apply.
create table public.best_slots (
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('x', 'threads', 'linkedin', 'tiktok', 'youtube', 'instagram')),
  hour smallint not null check (hour between 0 and 23),
  median_views_per_hour double precision not null check (median_views_per_hour >= 0),
  posts integer not null check (posts >= 1),
  computed_at timestamptz not null default now(),
  primary key (user_id, platform, hour)
);

-- Reply outcomes (A3): what the founder's reply got a few days after "replied". `outcome_url` is the reply's own link
-- when the founder pasted one; otherwise the check finds it by its text in the thread.
alter table public.cmo_draft_outcomes
  add column outcome_url text check (outcome_url ~ '^https://' and char_length(outcome_url) <= 500),
  add column outcome_votes integer check (outcome_votes >= -100000 and outcome_votes <= 10000000),
  add column outcome_replies integer check (outcome_replies >= 0 and outcome_replies <= 1000000),
  add column outcome_checked_at timestamptz,
  -- `found`: the reply was read; `not_found`: the thread was read but the reply was not in it; `gone`: no thread.
  add column outcome_status text check (outcome_status in ('found', 'not_found', 'gone'));

alter table public.push_subscriptions enable row level security;
alter table public.notify_settings enable row level security;
alter table public.email_log enable row level security;
alter table public.card_budget enable row level security;
alter table public.account_metrics enable row level security;
alter table public.best_slots enable row level security;
create policy "read own push subscriptions" on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "read own notify settings" on public.notify_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "read own email log" on public.email_log for select to authenticated using (user_id = (select auth.uid()));
create policy "read own card budget" on public.card_budget for select to authenticated using (user_id = (select auth.uid()));
create policy "read own account metrics" on public.account_metrics for select to authenticated using (user_id = (select auth.uid()));
create policy "read own best slots" on public.best_slots for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subscriptions, public.notify_settings, public.email_log, public.card_budget,
  public.account_metrics, public.best_slots from anon, authenticated;
grant select on public.push_subscriptions, public.notify_settings, public.email_log, public.card_budget,
  public.account_metrics, public.best_slots to authenticated;
grant select, insert, update, delete on public.push_subscriptions, public.notify_settings, public.email_log,
  public.card_budget, public.account_metrics, public.best_slots to service_role;

-- The founder's browser subscribes (C1). Subscribing again with the same endpoint updates the keys and moves it to
-- the signed-in founder.
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_id uuid;
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 then
    raise exception 'The push endpoint must be an https URL of at most 1000 characters.' using errcode = '22023';
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
$$;
revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

-- Turning push off in a browser. Only the founder's own row; another founder's endpoint is left alone.
create or replace function public.push_unsubscribe(p_endpoint text)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_user;
  return found;
end;
$$;
revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;

-- The founder's own email and push switches (Settings).
create or replace function public.notify_settings_save(p_email_digest boolean, p_push boolean)
returns public.notify_settings language plpgsql volatile security definer set search_path = public
as $$
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
revoke all on function public.notify_settings_save(boolean, boolean) from public, anon;
grant execute on function public.notify_settings_save(boolean, boolean) to authenticated;

-- The unsubscribe link (C0) works signed out, so anon may call it; the random token is the only key. It always answers
-- the same way, so the link cannot be used to probe which tokens exist.
create or replace function public.email_unsubscribe(p_token uuid)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
begin
  update public.notify_settings
  set email_digest = false, unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
  where unsubscribe_token = p_token;
  return true;
end;
$$;
revoke all on function public.email_unsubscribe(uuid) from public;
grant execute on function public.email_unsubscribe(uuid) to anon, authenticated;

-- The sender's settings row for a founder (service role): created on first use so every founder has a token.
create or replace function public.notify_settings_for(p_user uuid)
returns public.notify_settings language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.notify_settings;
begin
  insert into public.notify_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into v_row from public.notify_settings where user_id = p_user;
  return v_row;
end;
$$;
revoke all on function public.notify_settings_for(uuid) from public, anon, authenticated;
grant execute on function public.notify_settings_for(uuid) to service_role;

-- Before sending (service role, C0): claims the email so two cron runs never send it twice. A digest is claimed once
-- per founder's local day; an expiring email keeps only the cards no earlier expiring email named. Returns the log id
-- and the cards to put in it, or no row when there is nothing left to send (or the founder unsubscribed).
create or replace function public.email_log_claim(p_user uuid, p_kind text, p_approval_ids uuid[])
returns table (log_id uuid, approval_ids uuid[]) language plpgsql volatile security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone public.schedule_timezone(p_user))::date;
  v_ids uuid[];
  v_id uuid;
begin
  if p_kind not in ('digest', 'expiring') then
    raise exception 'Unknown email kind.' using errcode = '22023';
  end if;
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
revoke all on function public.email_log_claim(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.email_log_claim(uuid, text, uuid[]) to service_role;

-- After sending (service role): Resend's id, or the error. A failed digest frees the day, so the next hourly run
-- sends it (the cron sends a digest up to two hours after the digest hour while today's has not gone out).
create or replace function public.email_log_done(p_log uuid, p_provider_id text, p_error text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  if p_error is null then
    update public.email_log set status = 'sent', provider_id = left(p_provider_id, 100), sent_at = now() where id = p_log;
  else
    update public.email_log set status = 'failed', error = left(p_error, 500) where id = p_log;
    delete from public.email_log where id = p_log and kind = 'digest';
  end if;
end;
$$;
revoke all on function public.email_log_done(uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_log_done(uuid, text, text) to service_role;

commit;
