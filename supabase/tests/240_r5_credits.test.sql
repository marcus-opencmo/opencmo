-- Review R5 (20270102030000): a free founder's run never waits in the Claude inbox, a run past its lease is still the
-- same run, direct calls cannot queue the schedule's free jobs, parked runs are released after a week, and stale
-- caption-translation charges are refunded.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(12);

select ok(not has_function_privilege('authenticated', 'public.cmo_release_parked_runs(integer)', 'execute'), 'only the cron releases parked runs');
select ok(not has_function_privilege('authenticated', 'public.refund_stale_caption_translations()', 'execute'), 'only the cron refunds stale translations');

insert into auth.users (id, email) values ('e2400000-0000-4000-8000-00000000000a', 'r5credits@test.local');
insert into public.credit_ledger(user_id, delta, reason) values ('e2400000-0000-4000-8000-00000000000a', 50, 'test grant');

-- A free founder asked to think with Claude: the run is OpenCMO's own and priced as such.
create temp table f1 as select * from public.cmo_enqueue('e2400000-0000-4000-8000-00000000000a', 'post_draft', '{"brain":"claude","idea":"A"}');
select is((select input->>'brain' from f1), null, 'no inbox for a free founder');
select is((select credits from f1), public.cmo_job_price('post_draft'), 'priced like any OpenCMO run');

-- A running run past its lease is still in flight: asking again returns it.
update public.cmo_runs set status = 'running', lease_until = now() - interval '1 minute' where id = (select id from f1);
select is((public.cmo_enqueue('e2400000-0000-4000-8000-00000000000a', 'post_draft', '{"idea":"A"}')).id, (select id from f1),
  'no second run and no second hold');

-- The schedule's free jobs: not from a direct call.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2400000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select public.enqueue_cmo_run('review_week', '{}') $$, '22023', 'Unknown task.', 'review_week is the schedule''s');
select throws_ok($$ select public.enqueue_cmo_run('pull_metrics', '{}') $$, '22023', 'Unknown task.', 'pull_metrics too');
reset role;

-- A run parked by a pause over a week is failed and refunded; a recent pause keeps it.
update public.cmo_runs set status = 'done' where id = (select id from f1);
create temp table p1 as select * from public.cmo_enqueue('e2400000-0000-4000-8000-00000000000a', 'sales_scan', '{}');
update public.cmo_runs set not_before = 'infinity' where id = (select id from p1);
update public.profiles set cmo_paused_at = now() - interval '2 days' where id = 'e2400000-0000-4000-8000-00000000000a';
select is(public.cmo_release_parked_runs(7), 0, 'a two-day pause keeps its runs');
update public.profiles set cmo_paused_at = now() - interval '8 days' where id = 'e2400000-0000-4000-8000-00000000000a';
select is(public.cmo_release_parked_runs(7), 1, 'an eight-day pause releases them');
select is(public.credit_held('cmo_run', (select id from p1)), 0, 'and its credits come back');

-- A translation still charged after 15 minutes was killed before its refund.
insert into public.jobs (id, user_id, kind, source_url, title, status, duration_seconds)
values ('e2401000-0000-4000-8000-00000000000a', 'e2400000-0000-4000-8000-00000000000a', 'clip', 'storage://sources/x.mp4', 'Demo', 'done', 60);
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind)
values ('e2402000-0000-4000-8000-00000000000a', 'e2401000-0000-4000-8000-00000000000a', 0, 'Full', 0, 60, 'full');
insert into public.caption_translations (id, user_id, clip_id, credits, created_at) values
  ('e2403000-0000-4000-8000-00000000000a', 'e2400000-0000-4000-8000-00000000000a', 'e2402000-0000-4000-8000-00000000000a', 3, now() - interval '20 minutes'),
  ('e2403000-0000-4000-8000-00000000000b', 'e2400000-0000-4000-8000-00000000000a', 'e2402000-0000-4000-8000-00000000000a', 3, now());
insert into public.credit_ledger (user_id, delta, reason, ref_kind, ref_id) values
  ('e2400000-0000-4000-8000-00000000000a', -3, 'Caption translation', 'caption_translation', 'e2403000-0000-4000-8000-00000000000a'),
  ('e2400000-0000-4000-8000-00000000000a', -3, 'Caption translation', 'caption_translation', 'e2403000-0000-4000-8000-00000000000b');
select is(public.refund_stale_caption_translations(), 1, 'only the stale charge is refunded');
select is((select status from public.caption_translations where id = 'e2403000-0000-4000-8000-00000000000b'), 'charged', 'a request still running keeps its charge');

select * from finish();
rollback;
