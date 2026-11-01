-- Review R6 (20270102040000): claims stop at the container cap and serve the user with the fewest running tasks first,
-- a probe that never finishes rejects its asset, the CMO dispatch count follows claim_cmo_run, the legacy claim is gone.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(11);

select ok(not has_function_privilege('authenticated', 'public.claim_next_task(text[], int, int)', 'execute'), 'users cannot claim tasks');
select ok(not has_function_privilege('authenticated', 'public.cmo_dispatch_count(int)', 'execute'), 'users cannot count the CMO queue');
select hasnt_function('public', 'claim_next_job', array[]::text[], 'the claim without a lease is gone');

insert into auth.users (id, email) values
  ('e2410000-0000-4000-8000-00000000000a', 'r6a@test.local'),
  ('e2410000-0000-4000-8000-00000000000b', 'r6b@test.local');
insert into public.jobs (id, user_id, source_url, status) values
  ('e2411000-0000-4000-8000-00000000000a', 'e2410000-0000-4000-8000-00000000000a', 'https://a', 'done'),
  ('e2411000-0000-4000-8000-00000000000b', 'e2410000-0000-4000-8000-00000000000b', 'https://b', 'done');
-- User A queued three renders first; user B one, later.
insert into public.tasks (id, user_id, kind, job_id, request_id, created_at) values
  ('e2412000-0000-4000-8000-000000000001', 'e2410000-0000-4000-8000-00000000000a', 'render_document', 'e2411000-0000-4000-8000-00000000000a', gen_random_uuid(), now() - interval '3 minutes'),
  ('e2412000-0000-4000-8000-000000000002', 'e2410000-0000-4000-8000-00000000000a', 'render_document', 'e2411000-0000-4000-8000-00000000000a', gen_random_uuid(), now() - interval '2 minutes'),
  ('e2412000-0000-4000-8000-000000000003', 'e2410000-0000-4000-8000-00000000000a', 'render_document', 'e2411000-0000-4000-8000-00000000000a', gen_random_uuid(), now() - interval '1 minute'),
  ('e2412000-0000-4000-8000-000000000004', 'e2410000-0000-4000-8000-00000000000b', 'render_document', 'e2411000-0000-4000-8000-00000000000b', gen_random_uuid(), now());

set local role service_role;
select is((select id from public.claim_next_task(array['render_document'])), 'e2412000-0000-4000-8000-000000000001'::uuid, 'the oldest task first');
select is((select id from public.claim_next_task(array['render_document'])), 'e2412000-0000-4000-8000-000000000004'::uuid,
  'then the user with nothing running, ahead of the first user''s older tasks');
-- Two running now: a cap of 2 claims nothing, by kind or by id.
select is_empty($$ select id from public.claim_next_task(array['render_document'], 120, 2) $$, 'at the cap, nothing is claimed');
select is_empty($$ select id from public.claim_task('e2412000-0000-4000-8000-000000000002', 120, 2) $$, 'nor by id');
select is((select id from public.claim_task('e2412000-0000-4000-8000-000000000002', 120, 10)), 'e2412000-0000-4000-8000-000000000002'::uuid, 'under the cap it is');
reset role;

-- A probe that loses its lease three times rejects its asset with an error.
insert into public.media_assets (id, job_id, user_id, storage_path, name, status)
values ('e2413000-0000-4000-8000-00000000000a', 'e2411000-0000-4000-8000-00000000000a', 'e2410000-0000-4000-8000-00000000000a', 'media/e2410000-0000-4000-8000-00000000000a/e2411000-0000-4000-8000-00000000000a/a.mp4', 'a.mp4', 'pending');
insert into public.tasks (id, user_id, kind, job_id, asset_id, request_id, status, attempt, attempt_id, lease_until) values
  ('e2412000-0000-4000-8000-000000000009', 'e2410000-0000-4000-8000-00000000000a', 'probe_media', 'e2411000-0000-4000-8000-00000000000a',
   'e2413000-0000-4000-8000-00000000000a', gen_random_uuid(), 'running', 3, gen_random_uuid(), now() - interval '1 minute');
select lives_ok($$ select public.reclaim_expired_tasks() $$, 'reclaim runs');
select is((select status || ': ' || coalesce(error, '') from public.media_assets where id = 'e2413000-0000-4000-8000-00000000000a'),
  'rejected: We could not check this file. Upload it again.', 'the asset is rejected, not left checking forever');

-- The dispatch count skips a paused founder's runs, as the claim does.
insert into public.cmo_runs (user_id, kind, status, input, credits) values ('e2410000-0000-4000-8000-00000000000b', 'plan_week', 'queued', '{}', 0);
update public.profiles set cmo_paused_at = now() where id = 'e2410000-0000-4000-8000-00000000000b';
select is(public.cmo_dispatch_count(10), 0, 'a paused founder''s run is not counted');

select * from finish();
rollback;
