-- 20261110090000: weekly goals — proposed by the CMO, approved once by the founder, measured by review_week.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(17);

insert into auth.users (id, email) values
  ('e1400000-0000-4000-8000-00000000000a', 'wg-a@test.local'),
  ('e1400000-0000-4000-8000-00000000000b', 'wg-b@test.local');

create temporary table w as select date_trunc('week', current_date)::date as this_week;
grant select on w to authenticated;

-- review_week proposes next week's goal (service role).
select is(
  (select status from public.cmo_propose_goal('e1400000-0000-4000-8000-00000000000a', null, (select this_week + 7 from w), 'Publish 5 posts on X', 'posts', 5)),
  'proposed', 'a proposal waits for the founder'
);
select throws_ok(
  $$ select public.cmo_propose_goal('e1400000-0000-4000-8000-00000000000a', null, (select this_week + 1 from w), 'Publish', 'posts', 5) $$,
  '22023', 'The week must start on a Monday.', 'weeks start on Monday'
);
select throws_ok(
  $$ select public.cmo_propose_goal('e1400000-0000-4000-8000-00000000000a', null, (select this_week + 14 from w), 'Publish 5 posts', 'posts', 5) $$,
  '22023', 'Goals are for this week or next week.', 'no goals far ahead'
);
select throws_ok(
  $$ select public.cmo_propose_goal('e1400000-0000-4000-8000-00000000000a', null, (select this_week from w), 'Get followers', 'followers', 5) $$,
  '22023', 'The goal must count posts, replies, clips or views.', 'only metrics we can measure'
);
select is(
  (select count(*)::int from public.enqueue_cmo_run_for('e1400000-0000-4000-8000-00000000000a', 'review_week', '{}') where credits = 0),
  1, 'review_week is free'
);

-- As the founder.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1400000-0000-4000-8000-00000000000a"}';
select is(
  (select goal from public.cmo_set_week_goal((select this_week from w), 'Join 3 Reddit threads', 'replies', 3)),
  'Join 3 Reddit threads', 'the CMO chat proposes this week''s goal'
);
select is(
  (select target from public.cmo_decide_goal((select id from public.cmo_goals where week = (select this_week from w)), 'approve', null, 4)),
  4, 'approving can change the target'
);
select is((select status from public.cmo_goals where week = (select this_week from w)), 'approved', 'approved');
select is(
  (select goal from public.cmo_goals where week = (select this_week from w)),
  'Join 4 Reddit threads', 'a new target rewrites the number in the goal text'
);
select throws_ok(
  $$ select public.cmo_set_week_goal((select this_week from w), 'Something else', 'posts', 2) $$,
  'P0001', null, 'an approved goal is not replaced by a new proposal'
);
select throws_ok($$ select public.cmo_decide_goal(gen_random_uuid(), 'approve') $$, 'P0002', 'Goal not found.', 'unknown goal');
select throws_ok($$ select public.cmo_decide_goal((select id from public.cmo_goals limit 1), 'post') $$, '22023', 'Choose approve or reject.', 'only approve or reject');
select throws_ok(
  $$ select public.cmo_propose_goal(auth.uid(), null, (select this_week from w), 'x x x', 'posts', 1) $$,
  '42501', null, 'founders cannot call the job RPC'
);

-- Someone else sees nothing and cannot decide.
set local request.jwt.claims = '{"sub":"e1400000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.cmo_goals), 0, 'goals are private');
select throws_ok(
  $$ select public.cmo_decide_goal('00000000-0000-4000-8000-000000000000', 'approve') $$,
  'P0002', 'Goal not found.', 'cannot decide someone else''s goal'
);
reset role;

-- review_week records the result only on the approved goal.
select is(public.cmo_record_goal_result('e1400000-0000-4000-8000-00000000000a', (select this_week from w), 3), true, 'result recorded');
select is(public.cmo_record_goal_result('e1400000-0000-4000-8000-00000000000a', (select this_week + 7 from w), 3), false, 'not on a goal still proposed');

select * from finish();
rollback;
