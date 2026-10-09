-- Agent editor AE3 (20261004090000).
--
--   input     — pause 'input' → awaiting_input; giữ khoá; resume được; Stop hoàn khoản giữ
--   time      — pause 'time' → awaiting_continue; resume không cần duyệt
--   budget    — pause 'budget' → resume bị chặn; agent_extend_hold giữ thêm 10 và chạy tiếp;
--               thiếu credit thì chặn; chỉ gia hạn được lượt đang chờ gia hạn
--   close     — agent_close_turn / agent_mark_undone / agent_begin_turn biết hai trạng thái mới
--   New chat  — agent_new_session luôn tạo phiên mới; chặn khi một lượt đang sửa clip
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1030000-0000-4000-8000-00000000000a', 'loop-a@test.local'),
  ('e1030000-0000-4000-8000-00000000000b', 'loop-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1031000-0000-4000-8000-00000000000a', 'e1030000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1032000-0000-4000-8000-00000000000a', 'e1031000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20);
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1030000-0000-4000-8000-00000000000a', 16, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1030000-0000-4000-8000-00000000000a"}';

create temporary table s as select * from public.agent_open_session('e1032000-0000-4000-8000-00000000000a', 'fake');
grant select on s to authenticated;

-- ================================================================ câu hỏi
create temporary table t1 as select * from public.agent_begin_turn((select id from s), 'Pick a style', '[{"text":"x"}]');
grant select on t1 to authenticated;
select is(public.credit_balance('e1030000-0000-4000-8000-00000000000a'), 11, 'giữ 5 credit khi bắt đầu');
select lives_ok(
  $$ select public.agent_record_tool((select id from t1), 'q_0', 'ask_user', '{"question":"Which?"}', 'pending',
       '{"question":{"question":"Which?","options":["A","B"],"multi":false}}') $$,
  'câu hỏi lưu pending kèm thẻ'
);
select lives_ok($$ select public.agent_pause_turn((select id from t1), 'input') $$, 'tạm dừng chờ câu trả lời');
select is((select status from public.agent_turns where id = (select id from t1)), 'awaiting_input', 'lượt chờ câu trả lời');
select is((select pause_reason from public.agent_turns where id = (select id from t1)), 'input', 'lý do được ghi');
select ok(
  (select lock_until > now() + interval '20 minutes' from public.agent_sessions where id = (select id from s)),
  'chờ người thì khoá lâu'
);
select throws_ok(
  $$ select public.agent_begin_turn((select id from s), 'again', '[{"text":"x"}]') $$,
  'P0001', 'The assistant is already working on this clip.', 'đang chờ câu trả lời vẫn giữ khoá'
);
select throws_ok(
  $$ select public.agent_new_session('e1032000-0000-4000-8000-00000000000a', 'fake') $$,
  'P0001', 'The assistant is already working on this clip.', 'New chat chặn khi lượt đang sửa clip'
);
select is((select status from public.agent_resume_turn((select id from s))), 'running', 'resume từ chờ câu trả lời');
select is((select pause_reason from public.agent_turns where id = (select id from t1)), null, 'resume xoá lý do');

-- ================================================================ thời gian
select lives_ok($$ select public.agent_pause_turn((select id from t1), 'time') $$, 'tạm dừng vì trần thời gian');
select is((select status from public.agent_turns where id = (select id from t1)), 'awaiting_continue', 'lượt chờ nối tiếp');
select throws_ok(
  $$ select public.agent_mark_undone((select id from t1)) $$,
  'P0001', 'Wait for the assistant to finish before undoing.', 'không undo lượt đang chờ nối tiếp'
);
select is((select status from public.agent_resume_turn((select id from s))), 'running', 'nối tiếp không cần duyệt');

-- ================================================================ credit
select throws_ok(
  $$ select public.agent_extend_hold((select id from s)) $$,
  'P0001', 'The assistant is not waiting for more credits.', 'không gia hạn lượt không chờ gia hạn'
);
select lives_ok($$ select public.agent_pause_turn((select id from t1), 'budget') $$, 'tạm dừng vì hết phần giữ');
select throws_ok(
  $$ select public.agent_resume_turn((select id from s)) $$,
  'P0001', 'Approve more credits to let the assistant continue.', 'hết phần giữ thì resume thường bị chặn'
);
select is((select status from public.agent_extend_hold((select id from s))), 'running', 'gia hạn rồi chạy tiếp');
select is((select hold_credits from public.agent_turns where id = (select id from t1)), 15, 'phần giữ tăng 10');
select is(public.credit_balance('e1030000-0000-4000-8000-00000000000a'), 1, 'trừ thêm 10 khỏi số dư');
select lives_ok($$ select public.agent_pause_turn((select id from t1), 'budget') $$, 'hết phần giữ lần hai');
select throws_ok(
  $$ select public.agent_extend_hold((select id from s)) $$,
  'P0001', 'Not enough credits: 10 needed, 1 left. Top up on the Credits page.', 'thiếu credit thì không gia hạn'
);

-- người khác không gia hạn
set local request.jwt.claims = '{"sub":"e1030000-0000-4000-8000-00000000000b"}';
select throws_ok(
  $$ select public.agent_extend_hold((select id from s)) $$,
  'P0002', 'Assistant session not found.', 'người khác không gia hạn được'
);
set local request.jwt.claims = '{"sub":"e1030000-0000-4000-8000-00000000000a"}';

-- ================================================================ Stop khi chờ
select lives_ok($$ select public.agent_stop((select id from s)) $$, 'Stop khi chờ gia hạn');
select is((select status from public.agent_turns where id = (select id from t1)), 'stopped', 'lượt dừng');
select is((select pause_reason from public.agent_turns where id = (select id from t1)), null, 'lý do xoá khi chốt');
select is((select credits from public.agent_turns where id = (select id from t1)), 0, 'không usage thì không tính');
select is(public.credit_balance('e1030000-0000-4000-8000-00000000000a'), 16, 'hoàn toàn bộ 15 đã giữ');
select is(
  (select status from public.agent_tool_calls where turn_id = (select id from t1) and tool_use_id = 'q_0'),
  'failed', 'câu hỏi đang chờ thành failed'
);

-- ================================================================ New chat
select isnt(
  (select id from public.agent_new_session('e1032000-0000-4000-8000-00000000000a', 'fake')),
  (select id from s), 'New chat là phiên mới'
);
select is(
  (select count(*) from public.agent_sessions where clip_id = 'e1032000-0000-4000-8000-00000000000a'),
  2::bigint, 'hai phiên trong lịch sử'
);
select throws_ok(
  $$ select public.agent_new_session('e1032000-0000-4000-8000-00000000000a', 'default') $$,
  '22023', 'Unknown assistant model.', 'model lạ bị chặn'
);

select throws_ok(
  $$ select public.agent_pause_turn((select id from t1), 'nope') $$,
  '22023', 'Invalid pause reason.', 'lý do tạm dừng lạ bị chặn'
);

select * from finish();
rollback;
