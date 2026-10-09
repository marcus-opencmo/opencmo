-- 20261111090000: video briefs — the CMO writes them for the founder's own projects; the founder decides.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(12);

insert into auth.users (id, email) values
  ('e1410000-0000-4000-8000-00000000000a', 'vb-a@test.local'),
  ('e1410000-0000-4000-8000-00000000000b', 'vb-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1411000-0000-4000-8000-00000000000a', 'e1410000-0000-4000-8000-00000000000a', 'https://youtu.be/a', 600, 'done'),
  ('e1411000-0000-4000-8000-00000000000c', 'e1410000-0000-4000-8000-00000000000a', 'https://youtu.be/c', 600, 'done'),
  ('e1411000-0000-4000-8000-00000000000b', 'e1410000-0000-4000-8000-00000000000b', 'https://youtu.be/b', 600, 'done');
insert into public.clips (job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1411000-0000-4000-8000-00000000000a', 0, 10, 40, 10, 40),
  ('e1411000-0000-4000-8000-00000000000b', 0, 10, 40, 10, 40);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1410000-0000-4000-8000-00000000000a"}';

select is(
  (select status from public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000a', 'The 3-7-14 rule', 'Screen recording of reminders', 'Big captions', 'Cut every 2 seconds')),
  'in_review', 'a brief waits for the founder'
);
select throws_ok(
  $$ select public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000b', 'Hook', '', '', '') $$,
  'P0002', 'Project not found.', 'no briefs on someone else''s video'
);
select throws_ok(
  $$ select public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000c', 'Hook', '', '', '') $$,
  'P0001', 'This project has no clips yet. Make clips first.', 'needs clips to edit'
);
select throws_ok(
  $$ select public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000a', '', '', '', '') $$,
  '22023', 'The hook must be 1 to 200 characters.', 'needs a hook'
);
select throws_ok(
  $$ select public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000a', 'Hook', repeat('x', 601), '', '') $$,
  '22023', 'This brief is too long.', 'length limits'
);
select throws_ok(
  $$ insert into public.cmo_video_briefs (user_id, job_id, hook) values (auth.uid(), 'e1411000-0000-4000-8000-00000000000a', 'x') $$,
  '42501', null, 'no direct writes'
);

select is(
  (select job_id from public.cmo_decide_video_brief((select id from public.cmo_video_briefs limit 1), 'approve')),
  'e1411000-0000-4000-8000-00000000000a'::uuid, 'approving returns the project to open'
);
select throws_ok(
  $$ select public.cmo_decide_video_brief((select id from public.cmo_video_briefs limit 1), 'skip') $$,
  'P0001', 'This brief was already decided.', 'decided once'
);
select throws_ok($$ select public.cmo_decide_video_brief(gen_random_uuid(), 'apply') $$, '22023', 'Choose approve or skip.', 'only approve or skip');

select lives_ok(
  $$ select public.cmo_decide_video_brief((select id from public.cmo_create_video_brief('e1411000-0000-4000-8000-00000000000a', 'Second', '', '', '')), 'skip', 'Too long for TikTok') $$,
  'skip with a reason'
);
select is(
  (select topic from public.cmo_memories where body like 'Skipped a video brief%'),
  'video', 'the reason becomes a video memory'
);

set local request.jwt.claims = '{"sub":"e1410000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.cmo_video_briefs), 0, 'briefs are private');

select * from finish();
rollback;
