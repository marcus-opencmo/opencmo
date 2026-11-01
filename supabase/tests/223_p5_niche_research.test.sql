-- P5 A2 (20261231110000): niche video research is a priced Research job; a week plan with a video item orders it once
-- and that video's brief waits on it; when research ends (done or failed) the brief starts; the brief's niche links
-- reach the video order.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(16);

select is(public.cmo_job_price('niche_video_research'), 2, 'niche research costs 2 credits, like competitor research');
select is(public.cmo_job_daily_limit('niche_video_research'), 2, 'twice a day at most');
select is(public.work_order_department('niche_video_research'), 'research', 'a Research order');

insert into auth.users (id, email) values
  ('e2230000-0000-4000-8000-00000000000a', 'niche@test.local'),
  ('e2230000-0000-4000-8000-00000000000b', 'niche-broke@test.local');
update public.profiles set credit_balance = 50 where id = 'e2230000-0000-4000-8000-00000000000a';
create temp table t (name text primary key, id uuid) on commit drop;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from t where name = p $$;

-- A plan with two video items: one research order, both briefs wait on it, no brief run yet.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2231000-0000-4000-8000-00000000000a', 'e2230000-0000-4000-8000-00000000000a', 'plan_week', 'running');
select public.cmo_plan_week('e2230000-0000-4000-8000-00000000000a', 'e2231000-0000-4000-8000-00000000000a',
  jsonb_build_array(
    jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'Cut a demo by words', 'reason', 'Launch'),
    jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'B-roll on the right word', 'reason', 'Launch')));
insert into t select 'niche', id from public.work_orders where kind = 'niche_video_research' and user_id = 'e2230000-0000-4000-8000-00000000000a';
select is((select count(*)::int from public.work_orders where kind = 'niche_video_research' and user_id = 'e2230000-0000-4000-8000-00000000000a'), 1,
  'one research order for the week');
select is((select department || ' ' || budget_credits from public.work_orders where id = pg_temp.id('niche')), 'research 2', 'budgeted at its price');
select is((select count(*)::int from public.cmo_runs where kind = 'niche_video_research' and input->>'order_id' = pg_temp.id('niche')::text), 1,
  'its run is queued');
select is((select count(*)::int from public.work_orders where kind = 'write_video_brief' and user_id = 'e2230000-0000-4000-8000-00000000000a'
  and pg_temp.id('niche') = any(depends_on)), 2, 'both briefs wait on it');
select is((select count(*)::int from public.cmo_runs where kind = 'write_video_brief' and user_id = 'e2230000-0000-4000-8000-00000000000a'), 0,
  'no brief runs before the research ends');

-- Replanning the same week orders no second research.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2231000-0000-4000-8000-00000000000b', 'e2230000-0000-4000-8000-00000000000a', 'plan_week', 'running');
select public.cmo_plan_week('e2230000-0000-4000-8000-00000000000a', 'e2231000-0000-4000-8000-00000000000b',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'A third video', 'reason', 'Launch')));
select is((select count(*)::int from public.work_orders where kind = 'niche_video_research' and user_id = 'e2230000-0000-4000-8000-00000000000a'), 1,
  'a replan orders no second research');

-- Research done (an insight with its run): the order is done and the briefs start.
update public.cmo_runs set status = 'running', started_at = now() where input->>'order_id' = pg_temp.id('niche')::text;
insert into public.cmo_insights (user_id, run_id, kind, body)
select 'e2230000-0000-4000-8000-00000000000a', id, 'niche_video', '{"videos":[{"url":"https://www.tiktok.com/@a/video/1"}]}'
from public.cmo_runs where input->>'order_id' = pg_temp.id('niche')::text;
update public.cmo_runs set status = 'done', finished_at = now(), output = '{"videos":1}' where input->>'order_id' = pg_temp.id('niche')::text;
select is((select status from public.work_orders where id = pg_temp.id('niche')), 'done', 'the research order is done');
select is((select count(*)::int from public.deliverables where order_id = pg_temp.id('niche') and kind = 'insight'), 1, 'with the insight as its deliverable');
-- The replan dropped the second video, so its brief was cancelled; every brief still open starts.
select is((select count(*)::int from public.cmo_runs where kind = 'write_video_brief' and user_id = 'e2230000-0000-4000-8000-00000000000a'),
  (select count(*)::int from public.work_orders where kind = 'write_video_brief' and user_id = 'e2230000-0000-4000-8000-00000000000a'
     and status <> 'cancelled'), 'every open brief starts once research ends');
select is((select count(*)::int from public.work_orders where kind = 'write_video_brief' and status <> 'cancelled'
  and pg_temp.id('niche') = any(depends_on)), 0, 'and no longer waits on it');
select is((select input->>'idea' from public.cmo_runs where kind = 'write_video_brief' and input->>'idea' = 'Cut a demo by words'), 'Cut a demo by words',
  'with the plan''s idea');

-- The brief's niche links reach its video order.
insert into t select 'brief', id from public.work_orders where kind = 'write_video_brief' and brief->>'objective' = 'Cut a demo by words';
insert into t select 'video', id from public.work_orders where kind = 'build_video' and pg_temp.id('brief') = any(depends_on);
update public.cmo_runs set status = 'running', started_at = now() where input->>'order_id' = pg_temp.id('brief')::text;
update public.cmo_runs set status = 'done', finished_at = now(), output = jsonb_build_object('reason', 'Brief written',
  'brief', jsonb_build_object('objective', 'Show a demo cut by words', 'angle', 'Own screen',
    'hooks', jsonb_build_array('a', 'b', 'c'), 'keyPoints', jsonb_build_array('x'), 'cta', 'Try it', 'seconds', 30, 'aspect', '9:16'),
  'sources', jsonb_build_array('https://www.tiktok.com/@a/video/1'))
where input->>'order_id' = pg_temp.id('brief')::text;
select is((select brief->'sources'->>0 from public.work_orders where id = pg_temp.id('video')), 'https://www.tiktok.com/@a/video/1',
  'the video order carries the links the brief learned from');

-- A founder without credits: research cannot start, so the briefs go on at once.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2231000-0000-4000-8000-00000000000c', 'e2230000-0000-4000-8000-00000000000b', 'plan_week', 'running');
select public.cmo_plan_week('e2230000-0000-4000-8000-00000000000b', 'e2231000-0000-4000-8000-00000000000c',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok', 'idea', 'Broke video', 'reason', 'Launch')));
select is((select status from public.work_orders where kind = 'niche_video_research' and user_id = 'e2230000-0000-4000-8000-00000000000b'), 'failed',
  'research that cannot start fails its order and the brief goes on without it');

select * from finish();
rollback;
