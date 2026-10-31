-- P6 S4 (20270101100000): a finished slideshow render starts a look check instead of its card; a round-0 failure
-- raises no card and becomes one send-back the squad claims; the redo's check is round 1 and its card carries the
-- note; a pass raises the card without one; a check that cannot run raises the card anyway.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(40);

select ok(exists (select 1 from pg_constraint where conname = 'tasks_kind_check' and pg_get_constraintdef(oid) like '%look_check%'),
  'tasks take look_check');
select ok(not has_table_privilege('authenticated', 'public.look_checks', 'insert'), 'a founder writes no look check');
select ok(not has_function_privilege('authenticated', 'public.studio_look_sendbacks_claim(integer)', 'execute'),
  'only the squads claim send-backs');
select ok(not has_function_privilege('authenticated', 'public.look_check_begin(uuid,text,uuid,uuid,text,jsonb)', 'execute'),
  'only the render rules start a check');

insert into auth.users (id, email) values ('e2310000-0000-4000-8000-00000000000a', 'p6look@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2310000-0000-4000-8000-00000000000a","role":"authenticated"}';
create temp table s (n int, id uuid) on commit drop;
grant all on s to authenticated;
insert into s select 1, public.create_slideshow('One', '9:16');
insert into s select 2, public.create_slideshow('Two', '9:16');
insert into s select 3, public.create_slideshow('Three', '9:16');
reset role;
insert into public.editor_projects (clip_id, document) select id, jsonb_build_object('version', 1, 'n', n) from s;

-- A running slideshow step with its two renders; `r` makes the pair for a step.
create temp table r (step uuid, mp4 uuid, stills uuid) on commit drop;
create function pg_temp.renders(p_step uuid, p_n int) returns void language plpgsql as $f$
declare
  v_clip uuid := (select id from s where n = p_n);
  v_hash text := (select public.editor_document_hash(document) from public.editor_projects where clip_id = v_clip);
  v_mp4 uuid := gen_random_uuid();
  v_stills uuid := gen_random_uuid();
begin
  insert into public.tasks (id, user_id, kind, clip_id, settings_hash, status, request_id, output_path) values
    (v_mp4, 'e2310000-0000-4000-8000-00000000000a', 'render_document', v_clip, v_hash, 'running', gen_random_uuid(),
     'e2310000-0000-4000-8000-00000000000a/' || v_clip || '/' || v_mp4 || '.mp4'),
    (v_stills, 'e2310000-0000-4000-8000-00000000000a', 'render_stills', v_clip, v_hash, 'running', gen_random_uuid(), null);
  update public.studio_steps set input = jsonb_build_object('mp4_task', v_mp4, 'stills_task', v_stills) where id = p_step;
  insert into r values (p_step, v_mp4, v_stills);
  update public.tasks set status = 'done' where id in (v_mp4, v_stills);
end;
$f$;
insert into public.studio_steps (id, user_id, clip_id, tool, kind, input, card, price_credits, status)
select ('e2313000-0000-4000-8000-00000000000' || n)::uuid, 'e2310000-0000-4000-8000-00000000000a', id, 'build_slideshow',
  'slideshow', '{}', '{"title":"Launch","aspect":"9:16","slides":[{"text":"Cut by words","still_path":null,"seconds":3}],"mp4_path":null,"png_set_path":null}',
  0, 'running'
from s;

-- Step 1: round 0 fails, a send-back, then round 1 fails and the card shows the note.
select pg_temp.renders('e2313000-0000-4000-8000-000000000001', 1);
select is((select status from public.studio_steps where id = 'e2313000-0000-4000-8000-000000000001'), 'running',
  'a finished render does not raise the card yet');
select is((select count(*)::int from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000001'), 0, 'no card while it is checked');
select is((select t.payload->'files'->0->>'path' from public.look_checks c join public.tasks t on t.id = c.task_id
  where c.ref_id = 'e2313000-0000-4000-8000-000000000001'),
  (select output_path from public.tasks where id = (select mp4 from r where step = 'e2313000-0000-4000-8000-000000000001')),
  'the check reads the full-size MP4');
select is((select t.payload->>'round' from public.look_checks c join public.tasks t on t.id = c.task_id
  where c.ref_id = 'e2313000-0000-4000-8000-000000000001'), '0', 'first round');
update public.tasks set status = 'done', output = '{"pass":false,"round":0,"note":"Look check: captions run off.","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000001');
select is((select status from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000001'), 'sent_back', 'round 0 failed: sent back');
select is((select count(*)::int from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000001'), 0, 'and still no card');
set local role service_role;
select is((select look->>'note' from public.studio_look_sendbacks_claim(10)), 'Look check: captions run off.', 'the squad claims it once');
select is((select count(*)::int from public.studio_look_sendbacks_claim(10)), 0, 'and only once');
reset role;
select pg_temp.renders('e2313000-0000-4000-8000-000000000001', 1);
select is((select max(round)::int from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000001'), 1, 'the redo is round 1');
update public.tasks set status = 'done', output = '{"pass":false,"round":1,"note":"Look check: text too small (at 0:04).","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000001' and round = 1);
select is((select status from public.studio_steps where id = 'e2313000-0000-4000-8000-000000000001'), 'waiting', 'round 1 reaches the founder');
select is((select snapshot->'look'->>'note' from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000001' and status = 'waiting'),
  'Look check: text too small (at 0:04).', 'the card carries the note');
select pg_temp.renders('e2313000-0000-4000-8000-000000000001', 1);
select is((select count(*)::int from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000001'), 2, 'never a third check');

-- Step 2: a pass raises the card without a note.
select pg_temp.renders('e2313000-0000-4000-8000-000000000002', 2);
update public.tasks set status = 'done', output = '{"pass":true,"round":0,"note":"","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000002' and status = 'waiting'), 1,
  'a pass raises the card');
select ok((select not (snapshot ? 'look') from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000002'), 'with no note');

-- Step 3: the check itself fails; the card is raised anyway.
select pg_temp.renders('e2313000-0000-4000-8000-000000000003', 3);
update public.tasks set status = 'failed', error = 'The look check could not run.'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000003');
select is((select status from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000003'), 'error', 'a check that cannot run');
select is((select count(*)::int from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000003' and status = 'waiting'), 1,
  'never blocks the card');

-- A send-back whose redo never came back is given up on after an hour.
update public.look_checks set status = 'claimed', claimed_at = now() - interval '2 hours', round = 0
where ref_id = 'e2313000-0000-4000-8000-000000000003';
update public.studio_steps set status = 'running' where id = 'e2313000-0000-4000-8000-000000000003';
set local role service_role;
select is((select count(*)::int from public.studio_look_sendbacks_claim(10)), 0, 'a stale send-back is not handed out again');
reset role;
select is((select status from public.studio_steps where id = 'e2313000-0000-4000-8000-000000000003'), 'waiting',
  'its card is raised instead');

-- 1b (20270101140000): a send-back the squad cannot redo raises its card now, with the round-0 note.
select ok(not has_function_privilege('authenticated', 'public.studio_look_sendback_unchanged(uuid)', 'execute'), 'only the squads say unchanged');
delete from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000002';
update public.approvals set status = 'cancelled' where ref_id = 'e2313000-0000-4000-8000-000000000002' and status = 'waiting';
update public.studio_steps set status = 'running' where id = 'e2313000-0000-4000-8000-000000000002';
select pg_temp.renders('e2313000-0000-4000-8000-000000000002', 2);
update public.tasks set status = 'done', output = '{"pass":false,"round":0,"note":"Look check: a frozen shot at 0:02.","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000002');
set local role service_role;
create temp table c (check_id uuid) on commit drop;
insert into c select check_id from public.studio_look_sendbacks_claim(10);
select ok(public.studio_look_sendback_unchanged((select check_id from c)), 'nothing to redo: raised now');
select ok(not public.studio_look_sendback_unchanged((select check_id from c)), 'and only once');
reset role;
select is((select snapshot->'look'->>'note' from public.approvals where ref_id = 'e2313000-0000-4000-8000-000000000002' and status = 'waiting'),
  'Look check: a frozen shot at 0:02.', 'the card carries the round-0 note');

-- Review fix 1: a newer render of the same ref while its check runs takes the check's place; the same render again
-- changes nothing.
insert into public.studio_steps (id, user_id, clip_id, tool, kind, input, card, price_credits, status)
select ('e2313000-0000-4000-8000-00000000000' || k)::uuid, 'e2310000-0000-4000-8000-00000000000a', (select id from s where n = 3),
  'build_slideshow', 'slideshow', '{}', '{"title":"Launch","aspect":"9:16","slides":[{"text":"Cut by words","still_path":null,"seconds":3}],"mp4_path":null,"png_set_path":null}',
  0, 'running'
from generate_series(4, 6) k;
create function pg_temp.begin_check(p_step uuid, p_key text) returns boolean language sql as $f$
  select public.look_check_begin('e2310000-0000-4000-8000-00000000000a', 'studio_step', p_step, null, p_key,
    jsonb_build_array(jsonb_build_object('path', 'e2310000-0000-4000-8000-00000000000a/x/' || p_key || '.mp4', 'clip_id', (select id from s where n = 3))))
$f$;
select ok(pg_temp.begin_check('e2313000-0000-4000-8000-000000000004', 'h1'), 'a check starts for H1');
select ok(pg_temp.begin_check('e2313000-0000-4000-8000-000000000004', 'h1'), 'the same render again: still checked');
select is((select count(*)::int from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000004'), 1, 'by the one check');
create temp table old_check as select id, task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000004';
select ok(pg_temp.begin_check('e2313000-0000-4000-8000-000000000004', 'h2'), 'a render of a newer edit is checked');
select is((select status from public.look_checks where id = (select id from old_check)), 'superseded', 'the H1 check steps aside');
select is((select status from public.tasks where id = (select task_id from old_check)), 'cancelled', 'and its queued task is cancelled');
select is((select doc_key || '/' || round from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000004' and status = 'checking'),
  'h2/0', 'the new check is for H2, at the same round');
update public.tasks set status = 'done', output = '{"pass":true,"round":0,"note":"","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000004' and status = 'checking');
select is((select status from public.studio_steps where id = 'e2313000-0000-4000-8000-000000000004'), 'waiting', 'and its pass reaches the founder');

-- Review fix 6: an error while raising the card keeps the settled status; the sweep raises the card later.
create function public.test_fail_step() returns trigger language plpgsql as $f$
begin
  if current_setting('test.fail_step', true) = 'on' then raise exception 'boom'; end if;
  return new;
end;
$f$;
create trigger test_fail_step before update on public.studio_steps for each row execute function public.test_fail_step();
select ok(pg_temp.begin_check('e2313000-0000-4000-8000-000000000005', 'h5'), 'a check for step 5');
set local test.fail_step = 'on';
update public.tasks set status = 'done', output = '{"pass":true,"round":0,"note":"","files":[]}'
where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000005');
set local test.fail_step = 'off';
select is((select status || '/' || (raised_at is null) from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000005'),
  'passed/true', 'the raise failed, the check still settled');
update public.look_checks set settled_at = now() - interval '10 minutes' where ref_id = 'e2313000-0000-4000-8000-000000000005';

-- A check left `checking` after its task went away is settled as an error by the sweep, and its card raised.
select ok(pg_temp.begin_check('e2313000-0000-4000-8000-000000000006', 'h6'), 'a check for step 6');
delete from public.tasks where id = (select task_id from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000006');
update public.look_checks set created_at = now() - interval '10 minutes' where ref_id = 'e2313000-0000-4000-8000-000000000006';
set local role service_role;
select is((select count(*)::int from public.studio_look_sendbacks_claim(10)), 0, 'the sweep hands out nothing');
reset role;
select is((select status from public.studio_steps where id = 'e2313000-0000-4000-8000-000000000005'), 'waiting', 'the failed raise is retried');
select is((select status || '/' || (raised_at is not null) from public.look_checks where ref_id = 'e2313000-0000-4000-8000-000000000006'),
  'error/true', 'the stuck check settles as an error and raises its card');

select * from finish();
rollback;
