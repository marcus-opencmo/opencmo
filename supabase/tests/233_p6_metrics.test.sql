-- P6 A1 (20270101110000): Zernio numbers land only on the founder's own published slots and connected accounts; a
-- number Zernio did not report stays null, never zero; a later reading of an account's day replaces it.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(17);

select ok(not has_function_privilege('authenticated', 'public.cmo_save_account_metrics(uuid,jsonb)', 'execute'), 'only the job saves account days');
select ok(not has_function_privilege('authenticated', 'public.cmo_zernio_posts(uuid,timestamptz)', 'execute'), 'only the job lists Zernio posts');
select ok(not has_function_privilege('authenticated', 'public.nonneg(bigint)', 'execute'), 'the helper is not callable');

insert into auth.users (id, email) values
  ('e2330000-0000-4000-8000-00000000000a', 'p6met@test.local'),
  ('e2330000-0000-4000-8000-00000000000b', 'p6met-other@test.local');
update public.profiles set timezone = 'UTC' where id in ('e2330000-0000-4000-8000-00000000000a', 'e2330000-0000-4000-8000-00000000000b');
select public.zernio_profile_save('e2330000-0000-4000-8000-00000000000a', 'prof-met');
select public.social_account_save('e2330000-0000-4000-8000-00000000000a', 'x', '@founder', null, 'acc-met-x');
select public.zernio_profile_save('e2330000-0000-4000-8000-00000000000b', 'prof-met-b');
select public.social_account_save('e2330000-0000-4000-8000-00000000000b', 'x', '@other', null, 'acc-met-xb');

insert into public.work_orders (id, user_id, week, kind, title, brief, department, status) values
  ('e2331000-0000-4000-8000-00000000000a', 'e2330000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date, 'post_draft', 'Posts', '{}', 'writer', 'done');
-- a: published through Zernio; b: approved, its slot still waiting; c: published by hand (no slot).
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2332000-0000-4000-8000-00000000000a', 'e2330000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'Post a', 'published', '{"text":"Post a."}'),
  ('e2332000-0000-4000-8000-00000000000b', 'e2330000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'Post b', 'approved', '{"text":"Post b."}'),
  ('e2332000-0000-4000-8000-00000000000c', 'e2330000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'Post c', 'published', '{"text":"Post c."}');
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status) values
  ('e2333000-0000-4000-8000-00000000000a', 'e2330000-0000-4000-8000-00000000000a', 'e2331000-0000-4000-8000-00000000000a', 'post', 'content_item', 'e2332000-0000-4000-8000-00000000000a', 'decided'),
  ('e2333000-0000-4000-8000-00000000000b', 'e2330000-0000-4000-8000-00000000000a', 'e2331000-0000-4000-8000-00000000000a', 'post', 'content_item', 'e2332000-0000-4000-8000-00000000000b', 'decided');
-- Deciding a deliverable proposes its slots (P4 rules); the test sets its own.
delete from public.schedule_slots where user_id = 'e2330000-0000-4000-8000-00000000000a';
insert into public.schedule_slots (id, user_id, deliverable_id, platform, account_id, mode, publish_at, window_ends_at, status, external_id) values
  ('e2334000-0000-4000-8000-00000000000a', 'e2330000-0000-4000-8000-00000000000a', 'e2333000-0000-4000-8000-00000000000a', 'x',
    (select id from public.social_accounts where zernio_account_id = 'acc-met-x'), 'publish', now() - interval '2 days', now() - interval '2 days' + interval '15 minutes', 'published', 'zpost-a'),
  ('e2334000-0000-4000-8000-00000000000b', 'e2330000-0000-4000-8000-00000000000a', 'e2333000-0000-4000-8000-00000000000b', 'x',
    (select id from public.social_accounts where zernio_account_id = 'acc-met-x'), 'publish', now() + interval '1 day', now() + interval '1 day 15 minutes', 'waiting', null);

select is((select array_agg(item_id) from public.cmo_zernio_posts('e2330000-0000-4000-8000-00000000000a', now() - interval '14 days')),
  array['e2332000-0000-4000-8000-00000000000a']::uuid[], 'only published slots with Zernio''s id are listed');
select is((select count(*)::int from public.cmo_zernio_posts('e2330000-0000-4000-8000-00000000000b', '-infinity')), 0, 'another founder lists none');

select is(public.cmo_save_metrics('e2330000-0000-4000-8000-00000000000a', '[
  {"item_id":"e2332000-0000-4000-8000-00000000000a","source":"zernio","url":"https://x.com/f/status/1","views":120,"likes":4,"replies":1,"reposts":0,"impressions":null,"engagements":5},
  {"item_id":"e2332000-0000-4000-8000-00000000000b","source":"zernio","views":9},
  {"item_id":"e2332000-0000-4000-8000-00000000000c","source":"zernio","views":9},
  {"item_id":"e2332000-0000-4000-8000-00000000000c","source":"public","views":40,"likes":2,"replies":0,"reposts":0}
]'::jsonb), 2, 'a Zernio row needs a published slot; a public row a published post');
select is((select source || ':' || views || ':' || coalesce(impressions::text, 'null') || ':' || engagements from public.post_metrics
  where item_id = 'e2332000-0000-4000-8000-00000000000a'), 'zernio:120:null:5', 'an unreported number stays null');
select is(public.cmo_save_metrics('e2330000-0000-4000-8000-00000000000b', '[
  {"item_id":"e2332000-0000-4000-8000-00000000000a","source":"zernio","views":1}]'::jsonb), 0, 'never onto another founder''s post');
select throws_ok($$ select public.cmo_save_metrics('e2330000-0000-4000-8000-00000000000a', '[{"item_id":"e2332000-0000-4000-8000-00000000000a","source":"scraped"}]') $$,
  '22023', 'These numbers are not valid.', 'an unknown source is refused');

select is(public.cmo_save_account_metrics('e2330000-0000-4000-8000-00000000000a', jsonb_build_array(
  jsonb_build_object('social_account_id', (select id from public.social_accounts where zernio_account_id = 'acc-met-x'), 'day', '2026-10-30',
    'followers', 310, 'impressions', 900, 'engagements', null, 'video_views', null, 'posts', 1),
  jsonb_build_object('social_account_id', (select id from public.social_accounts where zernio_account_id = 'acc-met-xb'), 'day', '2026-10-30', 'followers', 5),
  jsonb_build_object('social_account_id', (select id from public.social_accounts where zernio_account_id = 'acc-met-x'), 'day', 'yesterday', 'followers', 5)
)), 1, 'only the founder''s own accounts and real days');
select is((select coalesce(engagements::text, 'null') || ':' || coalesce(video_views::text, 'null') from public.account_metrics
  where user_id = 'e2330000-0000-4000-8000-00000000000a'), 'null:null', 'unreported account numbers stay null');
select is(public.cmo_save_account_metrics('e2330000-0000-4000-8000-00000000000a', jsonb_build_array(
  jsonb_build_object('social_account_id', (select id from public.social_accounts where zernio_account_id = 'acc-met-x'), 'day', '2026-10-30',
    'followers', null, 'impressions', 950, 'posts', 1))), 1, 'a later reading of the same day');
select is((select followers || ':' || impressions from public.account_metrics where user_id = 'e2330000-0000-4000-8000-00000000000a'), '310:950',
  'replaces the day and keeps the followers it did not report');
select is((select count(*)::int from public.account_metrics where user_id = 'e2330000-0000-4000-8000-00000000000a'), 1, 'one row per account and day');

-- Review fix 12: a count Zernio leaves out stays null too.
select is(public.cmo_save_metrics('e2330000-0000-4000-8000-00000000000a', '[
  {"item_id":"e2332000-0000-4000-8000-00000000000a","source":"zernio","impressions":300}]'::jsonb), 1, 'impressions only');
select is((select coalesce(views::text, 'null') || ':' || coalesce(likes::text, 'null') || ':' || impressions from public.post_metrics
  where item_id = 'e2332000-0000-4000-8000-00000000000a' and impressions is not null), 'null:null:300', 'no views is not zero views');

-- Review fix 13: a post older than the newest 200 Zernio slots can still be saved.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body)
select ('e2332000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'e2330000-0000-4000-8000-00000000000a', 'post', 'x',
  current_date, 'Later ' || g, 'published', jsonb_build_object('text', 'Later ' || g)
from generate_series(1, 200) g;
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status)
select ('e2333000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'e2330000-0000-4000-8000-00000000000a',
  'e2331000-0000-4000-8000-00000000000a', 'post', 'content_item', ('e2332000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'decided'
from generate_series(1, 200) g;
-- Deciding them proposed slots; the test sets its own.
delete from public.schedule_slots where user_id = 'e2330000-0000-4000-8000-00000000000a'
  and id not in ('e2334000-0000-4000-8000-00000000000a', 'e2334000-0000-4000-8000-00000000000b');
insert into public.schedule_slots (user_id, deliverable_id, platform, mode, publish_at, window_ends_at, status, external_id)
select 'e2330000-0000-4000-8000-00000000000a', ('e2333000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'x', 'publish',
  now() - make_interval(mins => g), now() - make_interval(mins => g) + interval '15 minutes', 'published', 'zl-' || g
from generate_series(1, 200) g;
select is(public.cmo_save_metrics('e2330000-0000-4000-8000-00000000000a', '[
  {"item_id":"e2332000-0000-4000-8000-00000000000a","source":"zernio","views":130}]'::jsonb), 1, 'the 201st newest slot''s post is still the founder''s');

select * from finish();
rollback;
