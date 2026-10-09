-- 20261109090000: memory in three tiers — typed events, weekly lessons, the summarize_memory kind.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(17);

insert into auth.users (id, email) values
  ('e1390000-0000-4000-8000-00000000000a', 'mt-a@test.local'),
  ('e1390000-0000-4000-8000-00000000000b', 'mt-b@test.local');

-- The skip RPCs insert only (user_id, type, body); the trigger files them by topic with an expiry.
insert into public.cmo_memories (user_id, type, body) values
  ('e1390000-0000-4000-8000-00000000000a', 'feedback', 'Skipped the X post "Pricing": too salesy'),
  ('e1390000-0000-4000-8000-00000000000a', 'feedback', 'Dismissed the Reddit thread "Help": not our buyer'),
  ('e1390000-0000-4000-8000-00000000000a', 'feedback', 'Skipped a video pack: wrong angle');
select is(
  (select array_agg(topic order by topic) from public.cmo_memories where user_id = 'e1390000-0000-4000-8000-00000000000a'),
  array['post', 'sales', 'video'],
  'skip reasons are filed under their topic'
);
select is(
  (select count(*)::int from public.cmo_memories where user_id = 'e1390000-0000-4000-8000-00000000000a' and kind = 'feedback' and expires_at > now() + interval '89 days'),
  3,
  'skip reasons are feedback that expires after 90 days'
);
select throws_ok(
  $$ insert into public.cmo_memories (user_id, type, body, importance) values ('e1390000-0000-4000-8000-00000000000a', 'user', 'x', 5) $$,
  '23514', null, 'importance is 1 to 3'
);

-- Lessons: service role only, Monday weeks, one per topic per week (upsert).
select is(
  public.cmo_save_lessons('e1390000-0000-4000-8000-00000000000a', null, date '2026-11-09',
    '[{"topic":"post","body":"Short how-to posts got approved; launch hype got skipped."},
      {"topic":"nope","body":"ignored"},
      {"topic":"sales","body":"  "}]'::jsonb),
  1,
  'only valid lessons are saved'
);
select is(
  public.cmo_save_lessons('e1390000-0000-4000-8000-00000000000a', null, date '2026-11-09', '[{"topic":"post","body":"Updated lesson."}]'::jsonb),
  1,
  'saving the same week and topic again'
);
select is(
  (select body from public.cmo_lessons where user_id = 'e1390000-0000-4000-8000-00000000000a' and topic = 'post'),
  'Updated lesson.',
  'replaces the lesson instead of adding a second one'
);
select throws_ok(
  $$ select public.cmo_save_lessons('e1390000-0000-4000-8000-00000000000a', null, date '2026-11-10', '[]'::jsonb) $$,
  '22023', 'The week must start on a Monday.', 'week starts on Monday'
);
select throws_ok(
  $$ select public.cmo_save_lessons('e1390000-0000-4000-8000-00000000000a', null, date '2026-11-09',
       '[{"topic":"post","body":"a"},{"topic":"post","body":"b"},{"topic":"post","body":"c"},{"topic":"post","body":"d"},{"topic":"post","body":"e"},{"topic":"post","body":"f"}]'::jsonb) $$,
  '22023', 'These lessons are not valid.', 'at most five lessons per call'
);

-- The weekly job is free and limited to once a day.
select is((select credits from public.enqueue_cmo_run_for('e1390000-0000-4000-8000-00000000000a', 'summarize_memory', '{}')), 0, 'summarize_memory is free');
update public.cmo_runs set status = 'done' where user_id = 'e1390000-0000-4000-8000-00000000000a' and kind = 'summarize_memory';
select throws_ok(
  $$ select public.enqueue_cmo_run_for('e1390000-0000-4000-8000-00000000000a', 'summarize_memory', '{}') $$,
  'P0001', null, 'once a day'
);
select throws_ok($$ select public.enqueue_cmo_run_for('e1390000-0000-4000-8000-00000000000a', 'onboard', '{}') $$, '22023', 'Unknown task.', 'onboard is not enqueued here');

-- As the founder.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1390000-0000-4000-8000-00000000000a"}';
select is((select topic from public.cmo_remember('Never mention competitors by name.', 'post')), 'post', 'remember with a topic');
select is((select importance from public.cmo_memories where body = 'Never mention competitors by name.'), 3::smallint, 'notes the founder typed rank highest');
select is((select topic from public.cmo_remember('We are bootstrapped.')), 'general', 'remember without a topic still works');
select throws_ok($$ select public.cmo_remember('x', 'tiktok') $$, '22023', 'Unknown topic.', 'unknown topic');
select throws_ok($$ select public.cmo_save_lessons(auth.uid(), null, date '2026-11-09', '[]'::jsonb) $$, '42501', null, 'founders cannot write lessons directly');

set local request.jwt.claims = '{"sub":"e1390000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.cmo_lessons), 0, 'nobody reads another founder''s lessons');

select * from finish();
rollback;
