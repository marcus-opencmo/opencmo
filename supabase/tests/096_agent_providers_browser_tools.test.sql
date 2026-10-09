-- Assistant đa provider + tool trình duyệt (20260927090000).
--
--   giá      — theo model, model lạ tính giá cao nhất, không bao giờ 0
--   phiên    — gắn với model: đổi model là phiên mới, model lạ bị chặn
--   chờ      — pause → resume, tool pending → complete, Stop khi đang chờ
--              hoàn khoản giữ và đánh dấu tool pending là failed
--   quyền    — người khác không resume, không complete được
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e9600000-0000-4000-8000-00000000000a', 'prov-a@test.local'),
  ('e9600000-0000-4000-8000-00000000000b', 'prov-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9610000-0000-4000-8000-00000000000a', 'e9600000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9620000-0000-4000-8000-00000000000a', 'e9610000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20);
insert into public.credit_ledger(user_id, delta, reason) values
  ('e9600000-0000-4000-8000-00000000000a', 20, 'test grant');

-- ================================================================ giá
select is(public.agent_micro_usd('claude-opus-5', 1000, 100, 0, 0), 7500::bigint, 'Opus: 1000×5 + 100×25');
select is(public.agent_micro_usd('gemini-3-pro-preview', 1000, 100, 1000, 0), 4250::bigint, 'Gemini Pro theo mẫu gemini-%pro%');
select is(public.agent_micro_usd('gemini-3.6-flash', 1000, 100, 0, 0), 800::bigint, 'Gemini Flash rẻ hơn');
select is(public.agent_micro_usd('mystery-model', 1000, 100, 0, 0), 7500::bigint, 'model lạ tính giá cao nhất');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9600000-0000-4000-8000-00000000000a"}';

-- ================================================================ phiên
create temporary table sg as select * from public.agent_open_session('e9620000-0000-4000-8000-00000000000a', 'gemini-pro-latest');
grant select on sg to authenticated;
select isnt(
  (select id from public.agent_open_session('e9620000-0000-4000-8000-00000000000a', 'claude-opus-5')),
  (select id from sg), 'đổi model là phiên mới'
);
select is(
  (select id from public.agent_open_session('e9620000-0000-4000-8000-00000000000a', 'gemini-pro-latest')),
  (select id from sg), 'cùng model thì cùng phiên'
);
select throws_ok(
  $$ select public.agent_open_session('e9620000-0000-4000-8000-00000000000a', 'default') $$,
  '22023', 'Unknown assistant model.', 'dòng default không mở phiên được'
);

-- ================================================================ chờ trình duyệt
create temporary table t as
  select * from public.agent_begin_turn((select id from sg), 'Check the frame', '[{"text":"Check the frame"}]');
grant select on t to authenticated;
select lives_ok(
  $$ select public.agent_record_tool((select id from t), 'gc_0', 'set_frame', '{}', 'done', '{"summary":"x"}', '{"text":"{}"}') $$,
  'tool server của bước lưu kèm content'
);
select lives_ok(
  $$ select public.agent_record_tool((select id from t), 'gc_1', 'capture_frames', '{"times":[1]}', 'pending', null) $$,
  'tool trình duyệt lưu pending'
);
select lives_ok($$ select public.agent_pause_turn((select id from t)) $$, 'tạm dừng lượt');
select is((select status from public.agent_turns where id = (select id from t)), 'awaiting_browser', 'lượt chờ trình duyệt');
select throws_ok(
  $$ select public.agent_append((select id from t), 'assistant', '[]') $$,
  'P0001', 'This assistant turn was stopped.', 'đang chờ thì không nối tin nhắn'
);
select throws_ok(
  $$ select public.agent_begin_turn((select id from sg), 'again', '[{"text":"x"}]') $$,
  'P0001', 'The assistant is already working on this clip.', 'đang chờ vẫn giữ khoá'
);

select is((select status from public.agent_resume_turn((select id from sg))), 'running', 'resume chạy lại lượt');
select throws_ok(
  $$ select public.agent_resume_turn((select id from sg)) $$,
  'P0001', 'The assistant is not waiting for you.', 'resume hai lần bị chặn'
);
select lives_ok(
  $$ select public.agent_complete_tool((select id from t), 'gc_1', 'done', '{"summary":"Checked 1 frame"}') $$,
  'hoàn tất tool pending'
);
select throws_ok(
  $$ select public.agent_complete_tool((select id from t), 'gc_1', 'done', '{}') $$,
  'P0001', 'That tool call is not waiting for a result.', 'không hoàn tất hai lần'
);

-- Stop khi đang chờ: chốt, hoàn khoản giữ, tool pending thành failed.
select lives_ok(
  $$ select public.agent_record_tool((select id from t), 'gc_2', 'capture_frames', '{"times":[2]}', 'pending', null) $$,
  'một tool pending khác'
);
select lives_ok($$ select public.agent_pause_turn((select id from t)) $$, 'tạm dừng lần hai');
select is((select status from public.agent_stop((select id from sg))), 'stopped', 'Stop khi đang chờ trình duyệt');
select is(public.credit_balance('e9600000-0000-4000-8000-00000000000a'), 20, 'không usage thì hoàn đủ');
select is(
  (select status from public.agent_tool_calls where turn_id = (select id from t) and tool_use_id = 'gc_2'),
  'failed', 'tool pending thành failed khi chốt'
);

-- ================================================================ người khác
create temporary table t2 as
  select * from public.agent_begin_turn((select id from sg), 'Check again', '[{"text":"x"}]');
grant select on t2 to authenticated;
select lives_ok($$ select public.agent_pause_turn((select id from t2)) $$, 'A tạm dừng lượt 2');
set local request.jwt.claims = '{"sub":"e9600000-0000-4000-8000-00000000000b"}';
select throws_ok(
  $$ select public.agent_resume_turn((select id from sg)) $$,
  'P0002', 'Assistant session not found.', 'B không resume lượt của A'
);
select throws_ok(
  $$ select public.agent_complete_tool((select id from t2), 'gc_1', 'done', '{}') $$,
  'P0002', 'Assistant turn not found.', 'B không hoàn tất tool của A'
);

select * from finish();
rollback;
