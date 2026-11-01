-- Brain B1 (20261227110000): plan_week writes the week's tree; runs move their orders; a draft waiting on a card
-- holds its order in waiting_founder until the card is decided; transitions, dependencies and budgets hold.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(55);

-- Grants, RLS, Realtime.
select ok(has_table_privilege('authenticated', 'public.work_orders', 'select'), 'founders read orders');
select ok(not has_table_privilege('authenticated', 'public.work_orders', 'update'), 'founders cannot write orders');
select ok(not has_table_privilege('authenticated', 'public.work_order_events', 'insert'), 'founders cannot write the log');
select ok(not has_table_privilege('service_role', 'public.work_order_events', 'update'), 'the log is append-only');
select ok(not has_function_privilege('authenticated', 'public.work_order_move(uuid,text,text,jsonb,text)', 'execute'), 'only the brain moves orders');
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'
  and tablename in ('work_orders', 'deliverables', 'work_order_events')), 3, 'orders, deliverables and the log stream over Realtime');

insert into auth.users (id, email) values
  ('e2030000-0000-4000-8000-00000000000a', 'b1@test.local'),
  ('e2030000-0000-4000-8000-00000000000b', 'b1-other@test.local');

create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from t where name = p $$;
create function pg_temp.order_of(p_item text) returns public.work_orders language sql as $$
  select * from public.work_orders where item_id = pg_temp.id(p_item)
$$;

-- Same table as JOB_PRICES in apps/web/lib/cmo/jobs/progress.ts (review item 9): change both together.
select is(array[public.cmo_job_price('plan_week'), public.cmo_job_price('post_draft'), public.cmo_job_price('sales_scan'),
  public.cmo_job_price('competitor_research')], array[1, 1, 5, 2], 'order prices match the app''s JOB_PRICES');

-- plan_week: the calendar and its tree.
-- P5 A2: fresh niche research, so the week plan orders none and the briefs start at once, as this test expects.
insert into public.cmo_insights (user_id, kind, body) values
  ('e2030000-0000-4000-8000-00000000000a', 'niche_video', '{}');
with r as (insert into public.cmo_runs (user_id, kind, status) values ('e2030000-0000-4000-8000-00000000000a', 'plan_week', 'running') returning id)
insert into t select 'plan', id from r;
select is(public.cmo_plan_week('e2030000-0000-4000-8000-00000000000a', pg_temp.id('plan'), jsonb_build_array(
  jsonb_build_object('department', 'post', 'platform', 'x', 'day', current_date, 'idea', 'Cut by words'),
  jsonb_build_object('department', 'post', 'platform', 'x', 'day', current_date + 1, 'idea', 'Ask for B-roll'),
  jsonb_build_object('department', 'sales', 'platform', 'reddit', 'day', current_date, 'idea', 'People editing demos'),
  jsonb_build_object('department', 'video', 'platform', 'tiktok', 'day', current_date, 'idea', 'A short'))), 4, 'four calendar items');
insert into t select 'p1', id from public.content_items where idea = 'Cut by words';
insert into t select 'p2', id from public.content_items where idea = 'Ask for B-roll';
insert into t select 's1', id from public.content_items where idea = 'People editing demos';
insert into t select 'root', id from public.work_orders where user_id = 'e2030000-0000-4000-8000-00000000000a' and parent_id is null;

select is((select status from public.work_orders where id = pg_temp.id('root')), 'running', 'the week root runs');
select is((select budget_credits from public.work_orders where id = pg_temp.id('root')), 80, 'the root holds the weekly budget');
select is((select run_id from public.work_orders where id = pg_temp.id('root')), pg_temp.id('plan'), 'the root is the plan run''s order');
select is((select count(*)::int from public.work_orders where parent_id = pg_temp.id('root')), 6,
  'one order per post, Reddit and video item, the video''s brief (P3 A2), plus the Sunday review');
select is((pg_temp.order_of('p1')).department, 'writer', 'posts go to Writer');
select is((pg_temp.order_of('s1')).budget_credits, 5, 'a Reddit scan gets its price as budget');
select is(((pg_temp.order_of('p1')).due_at at time zone 'UTC')::date, current_date, 'an order is due on its calendar day');
select is((select department from public.work_orders where kind = 'build_video'), 'studio', 'a video item is a Studio order (P2 A2)');
select ok(exists (select 1 from public.work_order_events where order_id = pg_temp.id('root') and text = 'Planned the week'), 'the log says so');

-- A post draft run: queued → running → done with a draft waiting on its card.
with r as (insert into public.cmo_runs (user_id, kind, status, credits, input)
  values ('e2030000-0000-4000-8000-00000000000a', 'post_draft', 'queued', 1, '{"source":"schedule"}') returning id)
insert into t select 'r1', id from r;
select is((pg_temp.order_of('p1')).run_id, pg_temp.id('r1'), 'a queued run attaches to the earliest open order of its kind');
update public.cmo_runs set status = 'running' where id = pg_temp.id('r1');
select is((pg_temp.order_of('p1')).status, 'running', 'the run starting starts the order');
select public.cmo_save_draft('e2030000-0000-4000-8000-00000000000a', pg_temp.id('r1'), pg_temp.id('p1'), 'Cut by words',
  '{"text":"Cut a video by deleting words.","alternates":[]}'::jsonb);
update public.cmo_runs set status = 'done', output = '{}' where id = pg_temp.id('r1');
select is((pg_temp.order_of('p1')).status, 'waiting_founder', 'a draft in review holds its order on the founder');
select is((select status from public.deliverables where ref_id = pg_temp.id('p1')), 'waiting_founder', 'the draft is the order''s deliverable');
select is((pg_temp.order_of('p1')).spent_credits, 1, 'the run''s credits count against the order');
select is((select spent_credits from public.work_orders where id = pg_temp.id('root')), 1, 'and against the week');
update public.cmo_runs set credits = 1, status = 'done', output = '{}' where id = pg_temp.id('plan');
select is((select spent_credits from public.work_orders where id = pg_temp.id('root')), 2, 'the plan run''s credit counts against the week too');

-- A redraft while the card waits supersedes the card; the order keeps waiting on the new one (review item 3).
update public.content_items set body = jsonb_set(body, '{text}', '"Cut a video by deleting the words you said."') where id = pg_temp.id('p1');
select is((select count(*)::int from public.approvals where ref_id = pg_temp.id('p1') and status = 'cancelled'), 1, 'the old card is superseded');
select is((pg_temp.order_of('p1')).status, 'waiting_founder', 'the order still waits on the founder');
select is((select status from public.deliverables where ref_id = pg_temp.id('p1')), 'waiting_founder', 'and so does its deliverable');

-- The founder approves the card: the order is done.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2030000-0000-4000-8000-00000000000a"}';
select is((select count(*)::int from public.work_orders), 7, 'the founder reads their tree (with the video order, P2 A2, and its brief, P3 A2)');
select public.approval_decide(a.id, 'approve', jsonb_build_object('content_hash', a.content_hash))
from public.approvals a where a.ref_id = pg_temp.id('p1') and a.status = 'waiting';
select is((pg_temp.order_of('p1')).status, 'done', 'approving the card finishes the order');
select ok(exists (select 1 from public.work_order_events where order_id = (pg_temp.order_of('p1')).id and text = 'You approved “Cut by words”'),
  'the log says who did it');
set local request.jwt.claims = '{"sub":"e2030000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.work_orders), 0, 'another founder reads no orders');
reset role;

-- A guessed order is not blamed for a failed run; a run the schedule linked fails its own order (review item 8).
with r as (insert into public.cmo_runs (user_id, kind, status, credits) values ('e2030000-0000-4000-8000-00000000000a', 'post_draft', 'running', 1) returning id)
insert into t select 'guess', id from r;
select is((pg_temp.order_of('p2')).run_id, pg_temp.id('guess'), 'an unlinked run takes the next post order as a guess');
update public.cmo_runs set status = 'failed', error = 'The model did not answer.' where id = pg_temp.id('guess');
select is((pg_temp.order_of('p2')).status, 'queued', 'a guessed order goes back to the queue');
select is((pg_temp.order_of('p2')).run_id, null, 'free for the next run');
with r as (insert into public.cmo_runs (user_id, kind, status, credits, input) values ('e2030000-0000-4000-8000-00000000000a', 'post_draft', 'running', 1,
  jsonb_build_object('source', 'schedule', 'order_id', (pg_temp.order_of('p2')).id)) returning id)
insert into t select 'r2', id from r;
select is((pg_temp.order_of('p2')).run_id, pg_temp.id('r2'), 'a run the schedule linked takes its order');

-- Deferral, failure, and a run nobody planned.
update public.cmo_runs set status = 'queued', not_before = now() + interval '1 minute' where id = pg_temp.id('r2');
select is((pg_temp.order_of('p2')).status, 'deferred', 'a deferred run defers its order');
update public.cmo_runs set status = 'running' where id = pg_temp.id('r2');
update public.cmo_runs set status = 'failed', error = 'The model did not answer.' where id = pg_temp.id('r2');
select is((pg_temp.order_of('p2')).status, 'failed', 'a failed linked run fails its order');
select is((pg_temp.order_of('p2')).error->>'code', 'run_failed', 'with an error the replan can read');
with r as (insert into public.cmo_runs (user_id, kind, status, input) values ('e2030000-0000-4000-8000-00000000000a', 'competitor_research', 'queued', '{"source":"chat"}') returning id)
insert into t select 'r3', id from r;
select is((select created_by from public.work_orders where run_id = pg_temp.id('r3')), 'chat', 'a run from chat lands under the week as a chat order');
update public.cmo_runs set status = 'running' where id = pg_temp.id('r3');
update public.cmo_runs set status = 'done', output = '{"reason":"No competitor posted this week."}' where id = pg_temp.id('r3');
select is((select done_reason from public.work_orders where run_id = pg_temp.id('r3')), 'No competitor posted this week.', 'done with nothing to approve states why');

-- A draft that leaves review without the founder sends its order back: deleted → cancelled (review item 3).
with r as (insert into public.cmo_runs (user_id, kind, status, input) values ('e2030000-0000-4000-8000-00000000000a', 'sales_scan', 'running',
  jsonb_build_object('order_id', (pg_temp.order_of('s1')).id)) returning id)
insert into t select 'r5', id from r;
with o as (insert into public.opportunities (user_id, run_id, url, title, score, reply)
  values ('e2030000-0000-4000-8000-00000000000a', pg_temp.id('r5'), 'https://www.reddit.com/r/SaaS/comments/b1/', 'Editing demos?', 70, 'Same here.') returning id)
insert into t select 'o1', id from o;
update public.cmo_runs set status = 'done', output = '{}' where id = pg_temp.id('r5');
select is((pg_temp.order_of('s1')).status, 'waiting_founder', 'the scan''s order waits on its reply card');
delete from public.opportunities where id = pg_temp.id('o1');
select is((pg_temp.order_of('s1')).status, 'cancelled', 'a deleted draft cancels its order instead of finishing it');

-- The state machine.
insert into t select 'a', (public.work_order_create('e2030000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date,
  pg_temp.id('root'), 'write_script', 'Video brief', '{}', 2)).id;
insert into t select 'b', (public.work_order_create('e2030000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date,
  pg_temp.id('root'), 'build_video', 'Long video', '{}', 0, null, array[pg_temp.id('a')], 'loop', null, 'studio')).id;
select throws_ok($$ select public.work_order_move(pg_temp.id('b'), 'running') $$, 'P0001', 'This order waits on another order.', 'depends_on blocks the start');
select throws_ok($$ select public.work_order_move(pg_temp.id('a'), 'done') $$, 'P0001', 'An order cannot go from queued to done.', 'queued cannot jump to done');
select public.work_order_move(pg_temp.id('a'), 'running');
select throws_ok($$ select public.work_order_move(pg_temp.id('a'), 'done') $$, 'P0001', 'An order is done only with a deliverable or a reason.', 'done needs a deliverable or a reason');
select throws_ok($$ select public.work_order_move(pg_temp.id('a'), 'failed') $$, '22023', 'A failed order needs an error code and message.', 'failed needs an error');
select is(public.work_order_spend(pg_temp.id('a'), 1), true, 'spending within the budget');
create temp table t_root (spent int) on commit drop;
insert into t_root select spent_credits from public.work_orders where id = pg_temp.id('root');
select is(public.work_order_spend(pg_temp.id('a'), 2), false, 'an overrun is reported (review item 5)');
select is((select spent_credits from public.work_orders where id = pg_temp.id('a')), 3, 'and recorded, not refused');
select is((select spent_credits from public.work_orders where id = pg_temp.id('root')), (select spent + 2 from t_root), 'the week''s total stays true');
select ok(exists (select 1 from public.work_order_events where order_id = pg_temp.id('a') and text = 'Over budget: “Video brief” used 3 of 2 credits'),
  'the overrun is a note in the log');
select is((public.work_order_move(pg_temp.id('a'), 'done', null, null, 'Brief written')).status, 'done', 'done with a reason');
select lives_ok($$ select public.work_order_move(pg_temp.id('b'), 'running') $$, 'the dependent order starts once its dependency is done');
select throws_ok($$ select public.work_order_move(pg_temp.id('a'), 'running') $$, 'P0001', 'An order cannot go from done to running.', 'done is final');
select throws_ok(format($$ select public.work_order_create(%L, date_trunc('week', current_date)::date, %L, 'x', 'Too big', '{}', 500) $$,
  'e2030000-0000-4000-8000-00000000000a', pg_temp.id('root')), 'P0001', null, 'a child cannot take more than the parent has left');

select * from finish();
rollback;
