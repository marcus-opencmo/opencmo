-- P6 A2 (20270101120000): best hours only after ten published posts with numbers on a platform, in the founder's
-- local time; the picker tries them instead of the defaults, and still keeps the gap and the daily cap.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(18);

select ok(not has_function_privilege('authenticated', 'public.best_slots_refresh(uuid)', 'execute'), 'only the job refreshes best hours');
select ok(not has_function_privilege('authenticated', 'public.schedule_candidate_times(uuid,text)', 'execute'), 'the candidates are internal');

insert into auth.users (id, email) values ('e2340000-0000-4000-8000-00000000000a', 'p6best@test.local');
-- UTC+7: a post at 07:00 UTC is a 14:00 post for this founder.
update public.profiles set timezone = 'Asia/Ho_Chi_Minh' where id = 'e2340000-0000-4000-8000-00000000000a';

-- Nine X posts: six at 14:00 local (many views), three at 09:00 local (few). Threads: three posts.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body, published_at)
select ('e2342000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'e2340000-0000-4000-8000-00000000000a', 'post',
  case when g <= 9 then 'X' else 'Threads' end, current_date - g, 'Post ' || g, 'published', '{"text":"x"}',
  date_trunc('day', now() - make_interval(days => g)) + case when g <= 6 then interval '7 hours' else interval '2 hours' end
from generate_series(1, 12) g;
insert into public.post_metrics (user_id, item_id, url, views, source)
select 'e2340000-0000-4000-8000-00000000000a', id, '', case when published_at::time = '07:00' then 1000 + extract(day from published_at)::int else 50 end, 'public'
from public.content_items where user_id = 'e2340000-0000-4000-8000-00000000000a';

select is(public.best_slots_refresh('e2340000-0000-4000-8000-00000000000a'), 0, 'nine posts are not enough');
select is(public.schedule_candidate_times('e2340000-0000-4000-8000-00000000000a', 'x'), array['09:00'], 'the defaults until then');

-- The tenth X post, at 09:00 local; an older reading of a post does not count, its newest does.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body, published_at) values
  ('e2342000-0000-4000-8000-000000000099', 'e2340000-0000-4000-8000-00000000000a', 'post', 'X', current_date - 20, 'Post 99', 'published',
   '{"text":"x"}', date_trunc('day', now() - interval '20 days') + interval '2 hours');
insert into public.post_metrics (user_id, item_id, url, views, source, measured_at) values
  ('e2340000-0000-4000-8000-00000000000a', 'e2342000-0000-4000-8000-000000000099', '', 90000, 'public', now() - interval '10 days'),
  ('e2340000-0000-4000-8000-00000000000a', 'e2342000-0000-4000-8000-000000000099', '', 60, 'public', now());

select is(public.best_slots_refresh('e2340000-0000-4000-8000-00000000000a'), 2, 'ten posts: two hours with two or more posts');
select is((select array_agg(hour order by median_views_per_hour desc) from public.best_slots
  where user_id = 'e2340000-0000-4000-8000-00000000000a' and platform = 'x'), array[14, 9]::smallint[], 'local hours, best first');
select is((select count(*)::int from public.best_slots where user_id = 'e2340000-0000-4000-8000-00000000000a' and platform = 'threads'), 0,
  'Threads keeps the defaults');
select is(public.schedule_candidate_times('e2340000-0000-4000-8000-00000000000a', 'x'), array['14:00'],
  'X tries its best hour, as many as the defaults offer');
select is(public.schedule_candidate_times('e2340000-0000-4000-8000-00000000000a', 'threads'), array['09:00', '12:00'], 'Threads its defaults');

-- The picker lands on 14:00 local, and moves a day on when a post already sits within the gap.
create temp table picked (at timestamptz) on commit drop;
insert into picked select public.schedule_pick_time('e2340000-0000-4000-8000-00000000000a', 'x', null);
select is((select to_char(at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') from picked), '14:00', 'the best hour is picked');
insert into public.work_orders (id, user_id, week, kind, title, brief, department, status) values
  ('e2341000-0000-4000-8000-00000000000a', 'e2340000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date, 'post_draft', 'Posts', '{}', 'writer', 'done');
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2342000-0000-4000-8000-0000000000aa', 'e2340000-0000-4000-8000-00000000000a', 'post', 'X', current_date, 'Next', 'in_review', '{"text":"x"}');
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status) values
  ('e2343000-0000-4000-8000-00000000000a', 'e2340000-0000-4000-8000-00000000000a', 'e2341000-0000-4000-8000-00000000000a', 'post', 'content_item', 'e2342000-0000-4000-8000-0000000000aa', 'ready');
insert into public.schedule_slots (user_id, deliverable_id, platform, mode, publish_at, window_ends_at, status)
select 'e2340000-0000-4000-8000-00000000000a', 'e2343000-0000-4000-8000-00000000000a', 'x', 'intent', at + interval '1 hour', at + interval '75 minutes', 'waiting' from picked;
select is(public.schedule_pick_time('e2340000-0000-4000-8000-00000000000a', 'x', null), (select at + interval '1 day' from picked),
  'the gap still holds: the next day at the best hour');

-- Review fix 8: views per hour since posting, not lifetime views. TikTok (its items say "TikTok", a caption profile in
-- `platform_profile_id`) counts too. Two old posts at 08:00 local with more views in all, two recent ones at 20:00 with
-- far more per hour, and six single posts at other hours.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body, published_at)
select ('e2342000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'e2340000-0000-4000-8000-00000000000a', 'post', 'TikTok',
  current_date, 'TikTok ' || g, 'published', '{"text":"x"}',
  case when g <= 2 then date_trunc('day', now() - make_interval(days => 59 + g)) + interval '1 hour'
       when g <= 4 then date_trunc('day', now() - make_interval(days => g)) + interval '13 hours'
       else date_trunc('day', now() - interval '30 days') + make_interval(hours => g - 3) end
from generate_series(1, 10) g;
insert into public.post_metrics (user_id, item_id, url, views, source)
select 'e2340000-0000-4000-8000-00000000000a', id, '', case when idea in ('TikTok 1', 'TikTok 2') then 5000 when idea in ('TikTok 3', 'TikTok 4') then 3000 else 10 end, 'public'
from public.content_items where user_id = 'e2340000-0000-4000-8000-00000000000a' and platform = 'TikTok';

-- Review fix 9: one trusted YouTube hour (21:00 local) still leaves the defaults' second slot.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body, published_at)
select ('e2342000-0000-4000-8000-0000000002' || lpad(g::text, 2, '0'))::uuid, 'e2340000-0000-4000-8000-00000000000a', 'post', 'YouTube',
  current_date, 'YouTube ' || g, 'published', '{"text":"x"}',
  case when g <= 2 then date_trunc('day', now() - make_interval(days => 4 + g)) + interval '14 hours'
       else date_trunc('day', now() - interval '10 days') + make_interval(hours => g - 3) end
from generate_series(1, 10) g;
insert into public.post_metrics (user_id, item_id, url, views, source)
select 'e2340000-0000-4000-8000-00000000000a', id, '', case when idea in ('YouTube 1', 'YouTube 2') then 100 else 10 end, 'public'
from public.content_items where user_id = 'e2340000-0000-4000-8000-00000000000a' and platform = 'YouTube';

select is(public.best_slots_refresh('e2340000-0000-4000-8000-00000000000a'), 5, 'X two hours, TikTok two, YouTube one');
select is((select array_agg(hour order by median_views_per_hour desc) from public.best_slots
  where user_id = 'e2340000-0000-4000-8000-00000000000a' and platform = 'tiktok'), array[20, 8]::smallint[],
  'the recent hour with more views per hour wins over the old one with more views');
select is(public.schedule_candidate_times('e2340000-0000-4000-8000-00000000000a', 'youtube'), array['21:00', '16:00'],
  'one trusted hour, then the defaults up to their count');

-- Review fix 4: a video's caption item counts as published when a slot published its clip on that platform.
insert into auth.users (id, email) values ('e2340000-0000-4000-8000-00000000000b', 'p6best-other@test.local');
insert into public.jobs (id, user_id, kind, source_url, title, status, duration_seconds)
values ('e2345000-0000-4000-8000-00000000000a', 'e2340000-0000-4000-8000-00000000000a', 'clip', 'https://example.com/v', 'Demo', 'done', 60);
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2345000-0000-4000-8000-00000000000b', 'e2345000-0000-4000-8000-00000000000a', 0, 'Full', 0, 60, 'full');
insert into public.content_items (id, user_id, department, platform, day, idea, status, body, clip_id) values
  ('e2342000-0000-4000-8000-000000000301', 'e2340000-0000-4000-8000-00000000000a', 'video', 'tiktok_caption', current_date, 'Caption',
   'approved', '{"text":"Cut by words."}', 'e2345000-0000-4000-8000-00000000000b');
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status) values
  ('e2343000-0000-4000-8000-00000000000c', 'e2340000-0000-4000-8000-00000000000a', 'e2341000-0000-4000-8000-00000000000a', 'video', 'clip',
   'e2345000-0000-4000-8000-00000000000b', 'decided')
on conflict (ref_kind, ref_id) do nothing;
delete from public.schedule_slots where deliverable_id = (select id from public.deliverables where ref_kind = 'clip' and ref_id = 'e2345000-0000-4000-8000-00000000000b');
insert into public.schedule_slots (user_id, deliverable_id, platform, mode, publish_at, window_ends_at, status, external_id)
select 'e2340000-0000-4000-8000-00000000000a', id, 'tiktok', 'publish', now() - interval '2 days', now() - interval '2 days' + interval '15 minutes', 'published', 'z-tt'
from public.deliverables where ref_kind = 'clip' and ref_id = 'e2345000-0000-4000-8000-00000000000b';
select is((select published_at from public.published_items('e2340000-0000-4000-8000-00000000000a', now() - interval '7 days')
  where item_id = 'e2342000-0000-4000-8000-000000000301'), now() - interval '2 days', 'the caption is published at its slot''s time');
select ok(not has_function_privilege('authenticated', 'public.published_items(uuid,timestamptz)', 'execute'), 'any founder''s list is internal');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2340000-0000-4000-8000-00000000000a","role":"authenticated"}';
select ok(exists (select 1 from public.my_published_items(now() - interval '7 days') where item_id = 'e2342000-0000-4000-8000-000000000301'),
  'the founder''s Analytics reads it');
set local request.jwt.claims = '{"sub":"e2340000-0000-4000-8000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.my_published_items('-infinity')), 0, 'nobody else does');
reset role;

select * from finish();
rollback;
