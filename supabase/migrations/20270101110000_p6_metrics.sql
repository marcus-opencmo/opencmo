-- 20270101110000: P6 A1 (P3), numbers from Zernio for posts that went out through it and for connected accounts.
--
-- `pull_metrics` reads two sources: the public reading (as before) and Zernio's analytics. A post is measured by
-- Zernio when a slot published it through a connected account; its row says `source = 'zernio'`.

begin;

-- `greatest(0, null)` is 0 in Postgres (GREATEST skips nulls), which would turn "not reported" into zero.
create or replace function public.nonneg(p bigint) returns bigint language sql immutable set search_path = public
as $$ select case when p is null then null else greatest(0, p) end $$;
revoke all on function public.nonneg(bigint) from public, anon, authenticated;
grant execute on function public.nonneg(bigint) to service_role;

-- The posts Zernio can measure: published slots of the founder with Zernio's id for the post, and the calendar item
-- the numbers belong to (the post itself, or a video's caption item for that platform). All of them, newest first;
-- `cmo_save_metrics` checks an item against every one, the job reads the newest 200 (`cmo_zernio_posts`).
create or replace function public.cmo_zernio_posts_all(p_user uuid, p_since timestamptz)
returns table (item_id uuid, external_id text, external_url text, platform text, social_account_id uuid, zernio_account_id text,
  published_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select coalesce(case when d.ref_kind = 'content_item' then d.ref_id end, cap.id) as item_id,
    s.external_id, s.external_url, s.platform, s.account_id, a.zernio_account_id, s.publish_at
  from public.schedule_slots s
  join public.deliverables d on d.id = s.deliverable_id
  left join public.social_accounts a on a.id = s.account_id
  left join lateral (
    select i.id from public.content_items i
    where d.ref_kind = 'clip' and i.user_id = p_user and i.clip_id = d.ref_id and i.department = 'video'
      and i.platform = public.platform_profile_id(s.platform)
    order by i.updated_at desc limit 1
  ) cap on true
  where s.user_id = p_user and s.status = 'published' and s.mode = 'publish' and s.external_id is not null
    and s.publish_at >= p_since
  order by s.publish_at desc;
$$;
revoke all on function public.cmo_zernio_posts_all(uuid, timestamptz) from public, anon, authenticated;

-- The job's read (service role): the newest 200.
create or replace function public.cmo_zernio_posts(p_user uuid, p_since timestamptz)
returns table (item_id uuid, external_id text, external_url text, platform text, social_account_id uuid, zernio_account_id text,
  published_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select * from public.cmo_zernio_posts_all(p_user, p_since) limit 200;
$$;
revoke all on function public.cmo_zernio_posts(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.cmo_zernio_posts(uuid, timestamptz) to service_role;

-- As in 20261029090000, plus `source`, `impressions` and `engagements`. A Zernio row needs a published slot of the
-- founder for the item; a public row a published item, as before. A row with no number at all is not stored, and a
-- number left out stays null ("not reported"), never 0.
create or replace function public.cmo_save_metrics(p_user uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_count integer := 0;
  v_source text;
  v_item uuid;
  v_zernio uuid[];
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  -- Once per save, not per row.
  if exists (select 1 from jsonb_array_elements(p_rows) r where r->>'source' = 'zernio') then
    v_zernio := array(select z.item_id from public.cmo_zernio_posts_all(p_user, '-infinity') z where z.item_id is not null);
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_source := coalesce(v_row->>'source', 'public');
    if v_source not in ('public', 'zernio') then
      raise exception 'These numbers are not valid.' using errcode = '22023';
    end if;
    v_item := (v_row->>'item_id')::uuid;
    -- Only the founder's own published posts: the job never writes numbers onto someone else's.
    if (v_source = 'public' and exists (select 1 from public.content_items i
          where i.id = v_item and i.user_id = p_user and i.status = 'published'))
       or (v_source = 'zernio' and v_item = any(v_zernio)) then
      if coalesce(v_row->>'views', v_row->>'impressions', v_row->>'likes', v_row->>'replies', v_row->>'reposts', v_row->>'engagements') is null then
        continue;
      end if;
      insert into public.post_metrics (user_id, item_id, url, views, likes, replies, reposts, source, impressions, engagements)
      values (p_user, v_item, left(coalesce(v_row->>'url', ''), 500),
        public.nonneg((v_row->>'views')::bigint), public.nonneg((v_row->>'likes')::bigint),
        public.nonneg((v_row->>'replies')::bigint), public.nonneg((v_row->>'reposts')::bigint),
        v_source, public.nonneg((v_row->>'impressions')::bigint), public.nonneg((v_row->>'engagements')::bigint));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.cmo_save_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cmo_save_metrics(uuid, jsonb) to service_role;

-- Per account per day (service role). Only the founder's own accounts; a later reading of the same day replaces it.
create or replace function public.cmo_save_account_metrics(p_user uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_account public.social_accounts;
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'These numbers are not valid.' using errcode = '22023';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    select * into v_account from public.social_accounts
    where id = (v_row->>'social_account_id')::uuid and user_id = p_user;
    if not found or coalesce(v_row->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      continue;
    end if;
    insert into public.account_metrics (user_id, social_account_id, platform, handle, day, followers, impressions,
      engagements, video_views, posts, measured_at)
    values (p_user, v_account.id, v_account.platform, v_account.handle, (v_row->>'day')::date,
      public.nonneg((v_row->>'followers')::bigint), public.nonneg((v_row->>'impressions')::bigint),
      public.nonneg((v_row->>'engagements')::bigint), public.nonneg((v_row->>'video_views')::bigint),
      public.nonneg((v_row->>'posts')::bigint)::integer, now())
    on conflict (user_id, platform, handle, day) do update
      set social_account_id = excluded.social_account_id, followers = coalesce(excluded.followers, account_metrics.followers),
          impressions = excluded.impressions, engagements = excluded.engagements, video_views = excluded.video_views,
          posts = excluded.posts, measured_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.cmo_save_account_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.cmo_save_account_metrics(uuid, jsonb) to service_role;

commit;
