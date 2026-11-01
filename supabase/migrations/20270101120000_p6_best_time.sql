-- 20270101120000: P6 A2 (P2), the founder's own best hours (schedule-publish.md §5, §9).
--
-- Once a platform has ~10 published posts with numbers, `best_slots` holds the local hours (profiles.timezone) whose
-- posts got the most views per hour since posting (median), and `schedule_pick_time` tries those hours instead of
-- the default slots of schedule-defaults.json (topped up with the defaults when fewer hours are trusted). Only the
-- candidate times change: the lead time, the gap, the daily cap and the short-vs-its-long-video rule are checked exactly as before, and a time the founder picked on a card is never
-- replaced (moving a slot does not call the picker).

begin;

-- Posts this recent and old enough to have their numbers count; ten of them on a platform before the defaults step
-- aside, and two at an hour before that hour is trusted.
create or replace function public.best_time_rules() returns jsonb
language sql immutable set search_path = public
as $$ select '{"minPosts": 10, "minPostsPerHour": 2, "windowDays": 90, "settleHours": 24}'::jsonb $$;
revoke all on function public.best_time_rules() from public, anon, authenticated;

-- The platform a schedule slot names for a calendar item's label: `platform_profile_id` names the caption profiles
-- (`tiktok_caption`, `instagram_caption`), slots and best hours the platform.
create or replace function public.slot_platform_of(p_label text) returns text
language sql immutable set search_path = public
as $$ select replace(public.platform_profile_id(p_label), '_caption', '') $$;
revoke all on function public.slot_platform_of(text) from public, anon, authenticated;

-- The founder's published calendar items since `p_since`: posts marked published, and video caption items whose clip
-- a slot published on that platform (a slot publishes the clip, not its caption item, so the caption keeps its
-- `approved` status). The posting time is the item's own, else the newest slot that published it.
create or replace function public.published_items(p_user uuid, p_since timestamptz)
returns table (item_id uuid, platform text, idea text, final_text text, published_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select p.id, p.platform, p.idea, p.final_text, p.at
  from (
    select i.id, i.platform, i.idea, i.final_text, i.status, coalesce(i.published_at, (
        select max(coalesce(s.published_at, s.publish_at)) from public.schedule_slots s
        join public.deliverables d on d.id = s.deliverable_id
        where s.user_id = p_user and s.status = 'published'
          and ((d.ref_kind = 'content_item' and d.ref_id = i.id)
            or (d.ref_kind = 'clip' and d.ref_id = i.clip_id and s.platform = public.slot_platform_of(i.platform)))
      )) as at
    from public.content_items i
    where i.user_id = p_user and (i.status = 'published' or (i.department = 'video' and i.clip_id is not null))
  ) p
  where p.at is not null and p.at >= p_since
$$;
revoke all on function public.published_items(uuid, timestamptz) from public, anon, authenticated;

-- The same for the signed-in founder (Analytics, the Dashboard's results), newest first.
create or replace function public.my_published_items(p_since timestamptz)
returns table (item_id uuid, platform text, idea text, final_text text, published_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.published_items(public.require_user(), p_since) order by published_at desc limit 500
$$;
revoke all on function public.my_published_items(timestamptz) from public, anon, authenticated;
grant execute on function public.my_published_items(timestamptz) to authenticated;

-- One row per published post with numbers: its platform, local posting hour and newest reading as views per hour
-- since posting (impressions when the platform reports no views), so an old post's longer life does not count as
-- a better hour.
create or replace function public.best_time_posts(p_user uuid)
returns table (item_id uuid, platform text, hour smallint, views_per_hour double precision)
language sql stable security definer set search_path = public
as $$
  with r as (select public.best_time_rules() as j),
  latest as (
    select distinct on (m.item_id) m.item_id, greatest(m.views, m.impressions) as views, m.measured_at
    from public.post_metrics m
    where m.user_id = p_user
    order by m.item_id, m.measured_at desc
  )
  select p.item_id, public.slot_platform_of(p.platform),
    extract(hour from p.published_at at time zone public.schedule_timezone(p_user))::smallint,
    l.views / greatest(1.0, extract(epoch from l.measured_at - p.published_at) / 3600.0)
  from r, public.published_items(p_user, now() - make_interval(days => (r.j->>'windowDays')::integer)) p
  join latest l on l.item_id = p.item_id
  where l.views is not null
    and public.slot_platform_of(p.platform) in ('x', 'threads', 'linkedin', 'tiktok', 'youtube', 'instagram')
    and p.published_at <= now() - make_interval(hours => (r.j->>'settleHours')::integer)
$$;
revoke all on function public.best_time_posts(uuid) from public, anon, authenticated;

-- Recomputes a founder's best hours (service role; pull_metrics calls it after saving numbers). A platform below the
-- minimum loses its rows, so the defaults apply again. Returns how many hours are stored.
create or replace function public.best_slots_refresh(p_user uuid)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_rules jsonb := public.best_time_rules();
  v_n integer;
begin
  delete from public.best_slots where user_id = p_user;
  insert into public.best_slots (user_id, platform, hour, median_views_per_hour, posts, computed_at)
  select p_user, b.platform, b.hour, percentile_cont(0.5) within group (order by b.views_per_hour), count(*), now()
  from public.best_time_posts(p_user) b
  where b.platform in (
    select platform from public.best_time_posts(p_user) group by platform having count(*) >= (v_rules->>'minPosts')::integer)
  group by b.platform, b.hour
  having count(*) >= (v_rules->>'minPostsPerHour')::integer;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.best_slots_refresh(uuid) from public, anon, authenticated;
grant execute on function public.best_slots_refresh(uuid) to service_role;

-- The candidate local times for a platform, as many as the defaults offer: the founder's best hours, best first, then
-- the default times not already in, so a founder with one trusted hour still gets as many slots a day as before.
create or replace function public.schedule_candidate_times(p_user uuid, p_platform text)
returns text[] language sql stable security definer set search_path = public
as $$
  with defaults as (
    select t, n from jsonb_array_elements_text(public.schedule_rules()->'platforms'->p_platform->'times') with ordinality d(t, n)
  ),
  best as (
    select to_char(make_time(b.hour, 0, 0), 'HH24:MI') as t, row_number() over (order by b.median_views_per_hour desc, b.hour) as n
    from public.best_slots b where b.user_id = p_user and b.platform = p_platform
  ),
  merged as (
    select t, 0 as pass, n from best
    union all
    select t, 1, n from defaults where t not in (select t from best)
  )
  select array_agg(t order by pass, n) from (
    select t, pass, n from merged order by pass, n limit greatest(1, (select count(*) from defaults))
  ) m
$$;
revoke all on function public.schedule_candidate_times(uuid, text) from public, anon, authenticated;

-- As in 20261230100000, with the candidate times above instead of the default slots.
create or replace function public.schedule_pick_time(p_user uuid, p_platform text, p_deliverable uuid)
returns timestamptz language plpgsql stable security definer set search_path = public
as $$
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
revoke all on function public.schedule_pick_time(uuid, text, uuid) from public, anon, authenticated;

commit;
