-- Ngân sách lượt 3D (20261011090000): lượt đã dùng preview_3d tự nâng phần giữ
-- lên 20 credit; lượt khác, số dư không đủ, hay lượt của người khác thì không đổi.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1090000-0000-4000-8000-00000000000a', 'hold3d-a@test.local'),
  ('e1090000-0000-4000-8000-00000000000b', 'hold3d-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1091000-0000-4000-8000-00000000000a', 'e1090000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1092000-0000-4000-8000-00000000000a', 'e1091000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20);
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1090000-0000-4000-8000-00000000000a', 30, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1090000-0000-4000-8000-00000000000a"}';

create temporary table s as select * from public.agent_open_session('e1092000-0000-4000-8000-00000000000a', 'fake');
grant select on s to authenticated;
create temporary table t1 as select * from public.agent_begin_turn((select id from s), 'Make it 3D', '[{"text":"x"}]');
grant select on t1 to authenticated;
select is(public.credit_balance('e1090000-0000-4000-8000-00000000000a'), 25, 'giữ 5 credit khi bắt đầu');

select is(public.agent_raise_hold_3d((select id from t1)), 5, 'chưa preview_3d: không nâng');
select is(public.credit_balance('e1090000-0000-4000-8000-00000000000a'), 25, 'không trừ thêm');

select lives_ok(
  $$ select public.agent_record_tool((select id from t1), 'p_0', 'preview_3d', '{"code":"return () => {};"}', 'done',
       '{"summary":"Previewed the 3D scene"}', null) $$,
  'ghi một lần preview_3d'
);
select is(public.agent_raise_hold_3d((select id from t1)), 20, 'đã preview_3d: nâng lên 20');
select is(public.credit_balance('e1090000-0000-4000-8000-00000000000a'), 10, 'giữ thêm 15 trong sổ credit');
select is(public.agent_raise_hold_3d((select id from t1)), 20, 'gọi lần hai không giữ thêm');
select is(public.credit_balance('e1090000-0000-4000-8000-00000000000a'), 10, 'số dư không đổi');

-- Người khác không nâng được lượt của A.
set local request.jwt.claims = '{"sub":"e1090000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.agent_raise_hold_3d((select id from t1)) $$, 'P0002', 'Turn not found.', 'B không chạm lượt của A');

select * from finish();
rollback;
