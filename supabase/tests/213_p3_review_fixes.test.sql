-- P3 review fixes (20261229100000, 20261229110000): a post's runs match by item whether or not they carry the order;
-- a replan keeps a video waiting on its brief and refunds a dropped brief's run; Writer never delivers or rewrites a
-- caption the founder has not seen; a Threads or LinkedIn post is marked posted with its own link and platform; a
-- new cut of a finished video gets new captions; a skip reason is remembered once.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(31);

insert into auth.users (id, email) values ('e2130000-0000-4000-8000-00000000000a', 'fixes@test.local');
update public.profiles set credit_balance = 50 where id = 'e2130000-0000-4000-8000-00000000000a';
-- P5 A2: fresh niche research, so the week plan orders none and the briefs start at once, as this test expects.
insert into public.cmo_insights (user_id, kind, body) values
  ('e2130000-0000-4000-8000-00000000000a', 'niche_video', '{}');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from t where name = p $$;
create function pg_temp.balance() returns integer language sql as $$
  select credit_balance from public.profiles where id = 'e2130000-0000-4000-8000-00000000000a' $$;

-- F1: the schedule names a post's order only while it is queued; the item is the key either way.
create temp table r (name text primary key, id uuid) on commit drop;
insert into r select 'first', (public.enqueue_cmo_run_for('e2130000-0000-4000-8000-00000000000a', 'post_draft',
  '{"item_id":"e2139999-0000-4000-8000-000000000001","order_id":"e2139999-0000-4000-8000-0000000000aa"}')).id;
select is((public.enqueue_cmo_run_for('e2130000-0000-4000-8000-00000000000a', 'post_draft', '{"item_id":"e2139999-0000-4000-8000-000000000001"}')).id,
  (select id from r where name = 'first'), 'the same item without its order waits behind its run');
update public.cmo_runs set status = 'running', lease_until = now() + interval '5 minutes' where id = (select id from r where name = 'first');
select is((public.enqueue_cmo_run_for('e2130000-0000-4000-8000-00000000000a', 'post_draft', '{"item_id":"e2139999-0000-4000-8000-000000000001"}')).id,
  (select id from r where name = 'first'), 'also once it runs');
select is((select count(*)::int from public.cmo_runs where input->>'item_id' = 'e2139999-0000-4000-8000-000000000001'), 1, 'one run for the item');
select isnt((public.enqueue_cmo_run_for('e2130000-0000-4000-8000-00000000000a', 'write_caption', '{"order_id":"e2139999-0000-4000-8000-0000000000bb"}')).id,
  (public.enqueue_cmo_run_for('e2130000-0000-4000-8000-00000000000a', 'write_caption', '{"order_id":"e2139999-0000-4000-8000-0000000000cc"}')).id,
  'Writer''s orders still key by order');
update public.cmo_runs set status = 'done', finished_at = now() where user_id = 'e2130000-0000-4000-8000-00000000000a' and kind in ('post_draft', 'write_caption');

-- F2: a replan that keeps the video keeps its order and its brief; nothing is paid twice.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2131000-0000-4000-8000-000000000001', 'e2130000-0000-4000-8000-00000000000a', 'plan_week', 'running'),
  ('e2131000-0000-4000-8000-000000000002', 'e2130000-0000-4000-8000-00000000000a', 'plan_week', 'running'),
  ('e2131000-0000-4000-8000-000000000003', 'e2130000-0000-4000-8000-00000000000a', 'plan_week', 'running');
select public.cmo_plan_week('e2130000-0000-4000-8000-00000000000a', 'e2131000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'Cut a demo', 'reason', 'r')));
insert into t select 'video', id from public.work_orders where kind = 'build_video' and user_id = 'e2130000-0000-4000-8000-00000000000a';
insert into t select 'brief', id from public.work_orders where kind = 'write_video_brief' and user_id = 'e2130000-0000-4000-8000-00000000000a';
insert into t select 'brief_run', id from public.cmo_runs where kind = 'write_video_brief' and input->>'order_id' = pg_temp.id('brief')::text;
create temp table b (credits integer) on commit drop;
insert into b select pg_temp.balance();
select is((select status from public.work_orders where id = pg_temp.id('video')), 'queued', 'the video waits on its brief');

select public.cmo_plan_week('e2130000-0000-4000-8000-00000000000a', 'e2131000-0000-4000-8000-000000000002',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'Cut a demo, by words', 'reason', 'r')));
select is((select status from public.work_orders where id = pg_temp.id('video')), 'queued', 'a replan that keeps the video does not cancel it');
select is((select item_id from public.work_orders where id = pg_temp.id('video')),
  (select id from public.content_items where run_id = 'e2131000-0000-4000-8000-000000000002' and department = 'video'),
  'it takes over the new item');
select is((select count(*)::int from public.work_orders where kind in ('build_video', 'write_video_brief') and user_id = 'e2130000-0000-4000-8000-00000000000a'),
  2, 'no second brief or video');
select is((select status from public.work_orders where id = pg_temp.id('brief')), 'queued', 'its brief still waits to run');
select is(pg_temp.balance(), (select credits from b), 'and nothing more was held');

-- A replan that drops the video cancels it, its brief and the brief's run, and gives the credit back.
select public.cmo_plan_week('e2130000-0000-4000-8000-00000000000a', 'e2131000-0000-4000-8000-000000000003',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'post', 'platform', 'X', 'idea', 'A post', 'reason', 'r')));
select is((select status from public.work_orders where id = pg_temp.id('video')), 'cancelled', 'a dropped video is cancelled');
select is((select status from public.work_orders where id = pg_temp.id('brief')), 'cancelled', 'so is the brief only it waited on');
select is((select status from public.cmo_runs where id = pg_temp.id('brief_run')), 'failed', 'its queued run never runs');
select is(pg_temp.balance(), (select credits from b) + 1, 'and its credit comes back');
select is((select count(*)::int from public.work_orders where kind = 'post_draft' and status = 'queued' and user_id = 'e2130000-0000-4000-8000-00000000000a'),
  1, 'the new plan''s post is ordered');

-- F3, F4: captions are delivered only by approving the card; Writer never rewrites one the founder approved.
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e2132000-0000-4000-8000-00000000000a', 'e2130000-0000-4000-8000-00000000000a', 'https://a', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2133000-0000-4000-8000-00000000000a', 'e2132000-0000-4000-8000-00000000000a', -1, 'Cut by words', 0, 0, 'blank');
insert into public.editor_projects (clip_id, document, manifest) values
  ('e2133000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"demo"}}', '{"version":1,"folders":[],"assets":[]}');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.cmo_save_caption('e2130000-0000-4000-8000-00000000000a', null, 'e2133000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Cut your demo by deleting words.');
reset role;
insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id)
values ('e2130000-0000-4000-8000-00000000000a', pg_temp.id('video'), 'video', 'clip', 'e2133000-0000-4000-8000-00000000000a');
select is((select status from public.content_items where clip_id = 'e2133000-0000-4000-8000-00000000000a' and platform = 'tiktok_caption'),
  'approved', 'approving the video approves the caption the card showed');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.cmo_save_caption('e2130000-0000-4000-8000-00000000000a', null, 'e2133000-0000-4000-8000-00000000000a',
  'instagram_caption', 'Written after the card was decided.');
select public.cmo_save_caption('e2130000-0000-4000-8000-00000000000a', null, 'e2133000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Writer again, later.');
reset role;
select is((select status from public.content_items where clip_id = 'e2133000-0000-4000-8000-00000000000a' and platform = 'instagram_caption'),
  'in_review', 'a caption written after the decision is not approved by itself');
select is((select count(*)::int from public.deliverables where kind = 'caption' and ref_id in
  (select id from public.content_items where clip_id = 'e2133000-0000-4000-8000-00000000000a')), 1, 'nor delivered: only the one the founder saw');
select is((select body->>'text' from public.content_items where clip_id = 'e2133000-0000-4000-8000-00000000000a' and platform = 'tiktok_caption'),
  'Cut your demo by deleting words.', 'an approved caption keeps its words');

-- F6: a new cut of the finished video orders new captions; the same cut raised again does not.
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e2132000-0000-4000-8000-00000000000b', 'e2130000-0000-4000-8000-00000000000a', 'https://b', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2133000-0000-4000-8000-00000000000b', 'e2132000-0000-4000-8000-00000000000b', -1, 'Second video', 0, 0, 'blank');
insert into public.editor_projects (clip_id, document, manifest) values
  ('e2133000-0000-4000-8000-00000000000b', '{"version":1,"stage":{"name":"first cut"}}', '{"version":1,"folders":[],"assets":[]}');
select public.approval_raise('e2130000-0000-4000-8000-00000000000a', 'editor_project', 'e2133000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.work_orders where kind = 'write_caption' and brief->>'ref_id' = 'e2133000-0000-4000-8000-00000000000b'),
  1, 'the finished video orders its captions');
update public.approvals set status = 'cancelled' where ref_id = 'e2133000-0000-4000-8000-00000000000b' and status = 'waiting';
select public.approval_raise('e2130000-0000-4000-8000-00000000000a', 'editor_project', 'e2133000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.work_orders where kind = 'write_caption' and brief->>'ref_id' = 'e2133000-0000-4000-8000-00000000000b'),
  1, 'raised again with the same cut, it does not pay for captions twice');
update public.editor_projects set document = '{"version":1,"stage":{"name":"second cut"}}' where clip_id = 'e2133000-0000-4000-8000-00000000000b';
select public.approval_raise('e2130000-0000-4000-8000-00000000000a', 'editor_project', 'e2133000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.work_orders where kind = 'write_caption' and brief->>'ref_id' = 'e2133000-0000-4000-8000-00000000000b'),
  2, 'a new cut gets captions for what it now says');

-- F5: a Threads or LinkedIn post is marked posted with its own platform's link and logged under its profile.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2134000-0000-4000-8000-000000000001', 'e2130000-0000-4000-8000-00000000000a', 'post', 'Threads', current_date, 'On Threads', 'approved', '{"text":"Hi."}'),
  ('e2134000-0000-4000-8000-000000000002', 'e2130000-0000-4000-8000-00000000000a', 'post', 'LinkedIn', current_date, 'On LinkedIn', 'approved', '{"text":"Hi."}'),
  ('e2134000-0000-4000-8000-000000000003', 'e2130000-0000-4000-8000-00000000000a', 'post', 'X', current_date, 'On X', 'approved', '{"text":"Hi."}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2130000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.cmo_mark_posted('e2134000-0000-4000-8000-000000000001', 'https://x.com/me/status/1') $$,
  '22023', 'Paste the link to your post on Threads, like https://www.threads.com/@you/post/abc.', 'a Threads post takes a Threads link');
select is((public.cmo_mark_posted('e2134000-0000-4000-8000-000000000001', 'https://www.threads.com/@me/post/DAbc_12-x')).status,
  'published', 'and is marked posted with it');
select throws_ok($$ select public.cmo_mark_posted('e2134000-0000-4000-8000-000000000002', 'https://www.threads.com/@me/post/abc') $$,
  '22023', 'Paste the link to your post on LinkedIn, like https://www.linkedin.com/feed/update/urn:li:activity:123.',
  'a LinkedIn post takes a LinkedIn link');
select is((public.cmo_mark_posted('e2134000-0000-4000-8000-000000000002', 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789')).status,
  'published', 'and is marked posted with it');
select throws_ok($$ select public.cmo_mark_posted('e2134000-0000-4000-8000-000000000003', 'https://www.threads.com/@me/post/abc') $$,
  '22023', 'Paste the link to your post on X, like https://x.com/you/status/123.', 'an X post still takes an X link');
select is((public.cmo_mark_posted('e2134000-0000-4000-8000-000000000003')).status, 'published', 'a link stays optional');
reset role;
select is((select array_agg(platform order by platform) from public.operation_log
  where user_id = 'e2130000-0000-4000-8000-00000000000a' and action = 'publish'), array['linkedin', 'threads', 'x'],
  'each publish is logged under its own platform');

-- F9: with no decision to learn from, the skip reason is still remembered once, as feedback.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2134000-0000-4000-8000-000000000004', 'e2130000-0000-4000-8000-00000000000a', 'post', 'X', current_date, 'Pricing', 'in_review', '{"text":"Hi."}');
insert into public.cmo_draft_outcomes (user_id, item_id, department, action)
values ('e2130000-0000-4000-8000-00000000000a', 'e2134000-0000-4000-8000-000000000004', 'post', 'approve');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2130000-0000-4000-8000-00000000000a","role":"authenticated"}';
select is((public.cmo_decide_post('e2134000-0000-4000-8000-000000000004', 'skip', null, 'Too pushy')).status, 'skipped', 'skipped');
reset role;
select is((select array_agg(type) from public.cmo_memories where body like '%Too pushy%'), array['feedback'],
  'its reason is one feedback memory when no voice note could be written');

select * from finish();
rollback;
