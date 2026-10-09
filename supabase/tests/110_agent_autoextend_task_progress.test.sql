-- 20261012090000: lượt Assistant tự giữ thêm credit tới trần thay vì dừng hỏi;
-- tiến độ task do đúng attempt đang giữ ghi.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1100000-0000-4000-8000-00000000000a', 'autoext-a@test.local'),
  ('e1100000-0000-4000-8000-00000000000b', 'autoext-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1101000-0000-4000-8000-00000000000a', 'e1100000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1102000-0000-4000-8000-00000000000a', 'e1101000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20);
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1100000-0000-4000-8000-00000000000a', 70, 'test grant');

-- ------------------------------------------------------------ tiến độ task
insert into public.tasks (id, user_id, kind, clip_id, settings_hash, request_id, status, attempt_id) values
  ('e1103000-0000-4000-8000-00000000000a', 'e1100000-0000-4000-8000-00000000000a', 'render_document',
   'e1102000-0000-4000-8000-00000000000a', repeat('7', 64), gen_random_uuid(), 'running',
   'e1104000-0000-4000-8000-00000000000a');

set local role service_role;
select is(public.task_progress('e1103000-0000-4000-8000-00000000000a', 'e1104000-0000-4000-8000-00000000000a', 0.42), true, 'attempt đang giữ ghi được');
select is((select progress from public.tasks where id = 'e1103000-0000-4000-8000-00000000000a'), 0.42::real, 'lưu tiến độ');
select is(public.task_progress('e1103000-0000-4000-8000-00000000000a', 'e1104000-0000-4000-8000-00000000000b', 0.9), false, 'attempt cũ không ghi được');
select is(public.task_progress('e1103000-0000-4000-8000-00000000000a', 'e1104000-0000-4000-8000-00000000000a', 7), true, 'giá trị ngoài dải được kẹp');
select is((select progress from public.tasks where id = 'e1103000-0000-4000-8000-00000000000a'), 1::real, 'kẹp về 1');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1100000-0000-4000-8000-00000000000a"}';
select throws_ok(
  $$ select public.task_progress('e1103000-0000-4000-8000-00000000000a', 'e1104000-0000-4000-8000-00000000000a', 0.1) $$,
  '42501', null, 'người dùng không tự ghi tiến độ'
);

-- ------------------------------------------------------------ tự gia hạn lượt
create temporary table s as select * from public.agent_open_session('e1102000-0000-4000-8000-00000000000a', 'fake');
grant select on s to authenticated;
create temporary table t1 as select * from public.agent_begin_turn((select id from s), 'Do a lot', '[{"text":"x"}]');
grant select on t1 to authenticated;
select is(public.credit_balance('e1100000-0000-4000-8000-00000000000a'), 65, 'giữ 5 khi bắt đầu');

select is(public.agent_auto_extend((select id from t1)), 15, 'tự giữ thêm 10');
select is(public.credit_balance('e1100000-0000-4000-8000-00000000000a'), 55, 'trừ 10 vào sổ giữ');
select is(public.agent_auto_extend((select id from t1)), 25, 'lần nữa');
select is(public.agent_auto_extend((select id from t1)), 35, 'lần nữa');
select is(public.agent_auto_extend((select id from t1)), 45, 'lần nữa');
select is(public.agent_auto_extend((select id from t1)), 55, 'lần nữa');
select is(public.agent_auto_extend((select id from t1)), 60, 'chỉ tới trần 60');
select is(public.agent_auto_extend((select id from t1)), 60, 'chạm trần: không giữ thêm');
select is(public.credit_balance('e1100000-0000-4000-8000-00000000000a'), 10, 'tổng giữ đúng 60');

-- Người khác không gia hạn được lượt của A.
set local request.jwt.claims = '{"sub":"e1100000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.agent_auto_extend((select id from t1)) $$, 'P0002', 'Turn not found.', 'B không chạm lượt của A');

select * from finish();
rollback;
