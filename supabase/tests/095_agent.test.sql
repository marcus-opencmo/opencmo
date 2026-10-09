-- Assistant (20260926090000_agent).
--
--   phiên     — chỉ trên clip của mình, mở lại trả phiên cũ, model allowlist
--   lượt      — giữ 5 credit, khoá mềm chặn lượt thứ hai, thiếu credit bị chặn
--   tin nhắn  — chỉ nối thêm, bất biến, lượt đã Stop thì từ chối
--   chốt      — credit theo usage thật, trần = khoản giữ, hoàn phần dư, gỡ khoá
--   treo      — khoá hết hạn thì lượt mới chốt lượt treo rồi chạy
--   RLS       — người khác không đọc được gì
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('e9500000-0000-4000-8000-00000000000a', 'agent-a@test.local'),
  ('e9500000-0000-4000-8000-00000000000b', 'agent-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9510000-0000-4000-8000-00000000000a', 'e9500000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('e9510000-0000-4000-8000-00000000000b', 'e9500000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9520000-0000-4000-8000-00000000000a', 'e9510000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('e9520000-0000-4000-8000-00000000000b', 'e9510000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

insert into public.credit_ledger(user_id, delta, reason) values
  ('e9500000-0000-4000-8000-00000000000a', 12, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9500000-0000-4000-8000-00000000000a"}';

-- ================================================================ phiên
create temporary table s as
  select * from public.agent_open_session('e9520000-0000-4000-8000-00000000000a', 'claude-opus-5');
grant select on s to authenticated;

select is(
  (select id from public.agent_open_session('e9520000-0000-4000-8000-00000000000a', 'claude-opus-5')),
  (select id from s), 'mở lại trả đúng phiên cũ'
);
select throws_ok(
  $$ select public.agent_open_session('e9520000-0000-4000-8000-00000000000b', 'claude-opus-5') $$,
  'P0002', 'Clip not found.', 'clip người khác là 404'
);
select throws_ok(
  $$ select public.agent_open_session('e9520000-0000-4000-8000-00000000000a', 'gpt-9') $$,
  '22023', 'Unknown assistant model.', 'model ngoài allowlist bị chặn'
);

-- ================================================================ lượt
create temporary table t1 as
  select * from public.agent_begin_turn((select id from s), 'Make it square',
    '[{"type":"text","text":"Make it square"}]'::jsonb);
grant select on t1 to authenticated;

select is((select hold_credits from t1), 5, 'giữ 5 credit');
select is(public.credit_balance('e9500000-0000-4000-8000-00000000000a'), 7, 'số dư trừ khoản giữ');
select ok(
  (select lock_until > now() from public.agent_sessions where id = (select id from s)),
  'phiên bị khoá khi lượt chạy'
);
select throws_ok(
  $$ select public.agent_begin_turn((select id from s), 'again', '[{"type":"text","text":"again"}]') $$,
  'P0001', 'The assistant is already working on this clip.', 'khoá mềm chặn lượt thứ hai'
);

select is(
  public.agent_append((select id from t1), 'assistant', '[{"type":"text","text":"Done."}]'),
  2, 'tin nhắn nối thêm theo seq'
);
reset role;
select throws_ok(
  $$ update public.agent_messages set content = '[]' where session_id = (select id from s) $$,
  '55000', 'Assistant messages cannot be changed.', 'tin nhắn bất biến, kể cả với quyền cao'
);
set local role authenticated;

select lives_ok(
  $$ select public.agent_record_tool((select id from t1), 'toolu_1', 'set_frame',
       '{"width":1080,"height":1080}', 'done', '{"ok":true}') $$,
  'ghi tool call'
);

-- 10 000 token vào + 2 000 ra = 50 000 + 50 000 = 100 000 micro-USD = 2 credit.
select is(
  public.agent_record_usage((select id from t1), 'claude-opus-5', 10000, 2000, 0, 0),
  2, 'credit tính từ usage thật'
);

create temporary table f1 as
  select * from public.agent_finish_turn((select id from t1), 'done', null);
select is((select credits from f1), 2, 'chốt 2 credit');
select is(public.credit_balance('e9500000-0000-4000-8000-00000000000a'), 10, 'hoàn 3 credit dư');
select is(
  (select lock_until from public.agent_sessions where id = (select id from s)), null,
  'gỡ khoá khi chốt'
);
select is(
  (select credits from public.agent_finish_turn((select id from t1), 'failed', 'x')), 2,
  'chốt lại lượt đã chốt không đổi gì'
);
select is(public.credit_balance('e9500000-0000-4000-8000-00000000000a'), 10, 'không hoàn hai lần');

-- ======================================================= trần + Stop
create temporary table t2 as
  select * from public.agent_begin_turn((select id from s), 'Big job', '[{"type":"text","text":"Big job"}]');
grant select on t2 to authenticated;
select is(
  public.agent_record_usage((select id from t2), 'claude-opus-5', 400000, 0, 0, 0),
  40, 'usage vượt khoản giữ vẫn được ghi'
);
select is((select credits from public.agent_stop((select id from s))), 5, 'Stop chốt, credit không vượt khoản giữ');
select throws_ok(
  $$ select public.agent_append((select id from t2), 'assistant', '[{"type":"text","text":"late"}]') $$,
  'P0001', 'This assistant turn was stopped.', 'lượt đã Stop từ chối tin nhắn mới'
);

-- ======================================================= lượt treo
create temporary table t3 as
  select * from public.agent_begin_turn((select id from s), 'Hang', '[{"type":"text","text":"Hang"}]');
grant select on t3 to authenticated;
reset role;
update public.agent_sessions set lock_until = now() - interval '1 minute' where id = (select id from s);
set local role authenticated;
select lives_ok(
  $$ select public.agent_begin_turn((select id from s), 'After hang', '[{"type":"text","text":"x"}]') $$,
  'khoá hết hạn: lượt mới chạy được'
);
select is(
  (select status || ':' || credits from public.agent_turns where id = (select id from t3)),
  'failed:0', 'lượt treo được chốt failed, hoàn đủ'
);

-- ======================================================= thiếu credit
select is(public.credit_balance('e9500000-0000-4000-8000-00000000000a'), 0, 'số dư còn 0 khi lượt 4 đang giữ');
select lives_ok($$ select public.agent_stop((select id from s)) $$, 'dừng lượt 4');
reset role;
insert into public.credit_ledger(user_id, delta, reason) values
  ('e9500000-0000-4000-8000-00000000000a', -3, 'test spend');
set local role authenticated;
select throws_ok(
  $$ select public.agent_begin_turn((select id from s), 'x', '[{"type":"text","text":"x"}]') $$,
  'P0001', 'Not enough credits: 5 needed, 2 left. Top up on the Credits page.', 'thiếu credit bị chặn'
);

-- ======================================================= undo
select throws_ok(
  $$ select public.agent_mark_undone((select id from t1)) $$,
  '22023', 'This request did not change the clip.', 'lượt không ghi gì thì không có gì để undo'
);

-- ======================================================= người khác
set local request.jwt.claims = '{"sub":"e9500000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.agent_sessions), 0, 'B không thấy phiên của A');
select is((select count(*)::int from public.agent_messages), 0, 'B không thấy tin nhắn của A');
select is((select count(*)::int from public.agent_usage), 0, 'B không thấy usage của A');
select throws_ok(
  $$ select public.agent_begin_turn((select id from s), 'x', '[{"type":"text","text":"x"}]') $$,
  'P0002', 'Assistant session not found.', 'B không chạy lượt trên phiên của A'
);
select throws_ok(
  $$ select public.agent_append((select id from t1), 'user', '[]') $$,
  'P0002', 'Assistant turn not found.', 'B không nối tin nhắn vào lượt của A'
);
select throws_ok(
  $$ select public.agent_stop((select id from s)) $$,
  'P0002', 'Assistant session not found.', 'B không dừng được phiên của A'
);

select * from finish();
rollback;
