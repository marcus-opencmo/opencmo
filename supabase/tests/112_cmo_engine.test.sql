-- Tầng CMO đợt 1 (20261014090000): hàng đợi cmo_runs (giữ/hoàn credit, không
-- chạy chồng, trần mỗi ngày, lease), lịch + bài, duyệt có trần và chống trùng,
-- trí nhớ, phiên chat scope cmo.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1120000-0000-4000-8000-00000000000a', 'engine-a@test.local'),
  ('e1120000-0000-4000-8000-00000000000b', 'engine-b@test.local'),
  ('e1120000-0000-4000-8000-00000000000c', 'engine-c@test.local');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1120000-0000-4000-8000-00000000000a', 50, 'test grant'),
  ('e1120000-0000-4000-8000-00000000000b', 50, 'test grant');
-- C tiêu hết credit để thử "không đủ credit".
insert into public.credit_ledger(user_id, delta, reason)
select 'e1120000-0000-4000-8000-00000000000c', -public.credit_balance('e1120000-0000-4000-8000-00000000000c'), 'test drain'
where public.credit_balance('e1120000-0000-4000-8000-00000000000c') <> 0;

create temp table bal as select public.credit_balance('e1120000-0000-4000-8000-00000000000a') as v;
grant select on bal to authenticated, service_role;

-- ------------------------------------------------------------ thả việc
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000a"}';

select throws_ok($$ insert into public.content_items (user_id, department, platform, day, idea)
    values ('e1120000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'x') $$,
  '42501', null, 'không insert thẳng content_items được');
select throws_ok($$ select public.enqueue_cmo_run('onboard', '{}') $$, '22023', 'Unknown task.', 'onboard không đi qua hàng đợi');
select throws_ok($$ select public.claim_cmo_run() $$, '42501', null, 'người dùng không nhận việc được');

create temp table r1 as select * from public.enqueue_cmo_run('plan_week', '{}');
grant select on r1 to authenticated, service_role;
select is((select status from r1), 'queued', 'việc mới nằm trong hàng đợi');
select is(public.credit_balance('e1120000-0000-4000-8000-00000000000a'), (select v from bal) - 1, 'giữ 1 credit');
select is((public.enqueue_cmo_run('plan_week', '{}')).id, (select id from r1), 'thả lại khi đang chờ: trả lượt cũ');
select is(public.credit_balance('e1120000-0000-4000-8000-00000000000a'), (select v from bal) - 1, 'không giữ credit hai lần');

-- ------------------------------------------------------------ worker
reset role;
set local role service_role;
create temp table c1 as select * from public.claim_cmo_run((select id from r1));
select is((select status from c1), 'running', 'nhận việc');
select is((select attempt from c1), 1, 'lần thử 1');
select is((public.claim_cmo_run((select id from r1))).id, null, 'không nhận một việc hai lần');
select ok(public.cmo_run_step((select id from r1), 1, '[{"tool":"read_doc","label":"Read","status":"done"}]'), 'ghi bước');
select ok(not public.cmo_run_step((select id from r1), 2, '[]'), 'lần thử cũ/sai không ghi được');

select is(public.cmo_plan_week('e1120000-0000-4000-8000-00000000000a', (select id from r1), jsonb_build_array(
  jsonb_build_object('department', 'post', 'platform', 'X', 'day', current_date, 'idea', 'Launch post', 'reason', 'Pain #1'),
  jsonb_build_object('department', 'post', 'platform', 'X', 'day', current_date + 1, 'idea', 'Tip thread', 'reason', 'Hook'),
  jsonb_build_object('department', 'sales', 'platform', 'Reddit', 'day', current_date + 2, 'idea', 'Join r/saas', 'reason', 'Fit'),
  jsonb_build_object('department', 'post', 'platform', 'X', 'day', current_date + 40, 'idea', 'Too far', 'reason', 'x')
)), 3, 'ghi 3 mục, bỏ mục quá xa');
select ok(public.complete_cmo_run((select id from r1), 1, true, '{"items":3}'), 'kết thúc lượt');
select ok(not public.complete_cmo_run((select id from r1), 1, true, null), 'không kết thúc hai lần');

-- Lượt hỏng hoàn credit.
create temp table r2 as select * from public.enqueue_cmo_run_for('e1120000-0000-4000-8000-00000000000a', 'post_draft', '{}');
select is((public.claim_cmo_run((select id from r2))).attempt, 1, 'nhận lượt soạn bài');
select ok(public.complete_cmo_run((select id from r2), 1, false, null, 'The model is busy.'), 'lượt hỏng');
select is(public.credit_balance('e1120000-0000-4000-8000-00000000000a'), (select v from bal) - 1, 'lượt hỏng được hoàn credit');

-- Lease hết hạn → thả lại; quá 3 lần → hỏng và hoàn.
create temp table r3 as select * from public.enqueue_cmo_run_for('e1120000-0000-4000-8000-00000000000a', 'post_draft', '{}');
select is((public.claim_cmo_run((select id from r3))).attempt, 1, 'lần 1');
update public.cmo_runs set lease_until = now() - interval '1 second' where id = (select id from r3);
select is((public.claim_cmo_run((select id from r3))).attempt, 2, 'hết lease → nhận lại, lần 2');
update public.cmo_runs set lease_until = now() - interval '1 second', attempt = 3 where id = (select id from r3);
select is((public.claim_cmo_run((select id from r3))).id, null, 'quá 3 lần thì không nhận nữa');
select is((select status from public.cmo_runs where id = (select id from r3)), 'failed', 'lượt quá 3 lần thành failed');
select is(public.credit_balance('e1120000-0000-4000-8000-00000000000a'), (select v from bal) - 1, 'và được hoàn credit');

-- Bản nháp cho mục lịch hôm nay + một bài ngoài lịch.
create temp table d1 as select * from public.cmo_save_draft(
  'e1120000-0000-4000-8000-00000000000a', null,
  (select id from public.content_items where idea = 'Launch post'), null,
  '{"text":"We shipped reminders.","alternates":["a","b"],"rationale":"why"}', 'high');
select is((select status from d1), 'in_review', 'mục lịch thành bản nháp chờ duyệt');
create temp table d2 as select * from public.cmo_save_draft(
  'e1120000-0000-4000-8000-00000000000a', null, null, 'Ad-hoc', '{"text":"Second post"}', 'medium');
select is((select platform from d2), 'x', 'bài ngoài lịch mặc định là X');
select throws_ok($$ select public.cmo_save_draft('e1120000-0000-4000-8000-00000000000a', null, null, 'x', '{}', 'low') $$,
  '22023', 'This draft is not valid.', 'nháp phải có text');
grant select on d1, d2 to authenticated;

-- ------------------------------------------------------------ người dùng quyết
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000a"}';

select is((select count(*) from public.content_items where status = 'planned'), 2::bigint, 'A thấy 2 mục còn trên lịch');
select is((public.cmo_update_item((select id from public.content_items where idea = 'Tip thread'), 'Better tip thread', current_date + 2)).idea,
  'Better tip thread', 'sửa mục lịch');
select throws_ok($$ select public.cmo_update_item((select id from public.content_items where idea = 'Better tip thread'), 'x', current_date + 30) $$,
  '22023', 'Pick a day in the next two weeks.', 'ngày quá xa');
select lives_ok($$ select public.cmo_remove_item((select id from public.content_items where idea = 'Join r/saas')) $$, 'xoá mục lịch');
select throws_ok($$ select public.cmo_remove_item((select id from d1)) $$,
  'P0002', 'This calendar item is no longer open.', 'không xoá bài đã thành nháp');

select throws_ok($$ select public.cmo_decide_post((select id from d1), 'approve', repeat('a', 281)) $$,
  '22023', 'Posts on X can be at most 280 characters.', 'quá 280 ký tự');
select throws_ok($$ select public.cmo_mark_posted((select id from d1)) $$,
  'P0001', 'Approve the post before marking it as posted.', 'chưa duyệt thì chưa đánh dấu đã đăng');
select is((public.cmo_decide_post((select id from d1), 'approve', 'We shipped reminders today.')).status, 'approved', 'duyệt');
select is((select final_text from public.content_items where id = (select id from d1)), 'We shipped reminders today.', 'lưu bản đã sửa');
select throws_ok($$ select public.cmo_decide_post((select id from d1), 'approve') $$,
  'P0001', 'This post was already decided.', 'không duyệt hai lần');
select throws_ok($$ select public.cmo_mark_posted((select id from d1), 'https://evil.com/x') $$,
  '22023', 'Paste the link to your post on X, like https://x.com/you/status/123.', 'link phải là bài trên X');
select is((public.cmo_mark_posted((select id from d1), 'https://x.com/acme/status/123')).status, 'published', 'đánh dấu đã đăng');

select is((public.cmo_decide_post((select id from d2), 'skip', null, 'Too salesy')).status, 'skipped', 'bỏ bài');
select is((select body from public.cmo_memories where type = 'feedback'), 'Skipped the X post "Ad-hoc": Too salesy', 'lý do bỏ thành trí nhớ');
select is((public.cmo_remember('Never mention pricing in posts.')).type, 'user', 'ghi điều người dùng dặn');

-- Trần 5 bài duyệt/ngày.
reset role;
insert into public.operation_log (user_id, platform, action, target)
select 'e1120000-0000-4000-8000-00000000000a', 'x', 'approve', 'seed-' || g from generate_series(1, 4) g;
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e1123000-0000-4000-8000-00000000000a', 'e1120000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'Over cap', 'in_review', '{"text":"over"}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select public.cmo_decide_post('e1123000-0000-4000-8000-00000000000a', 'approve') $$,
  'P0001', 'You can approve 5 posts for X a day. Try again tomorrow.', 'trần 5 bài/ngày');

-- ------------------------------------------------------------ cô lập + credit
set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.content_items), 0::bigint, 'B không thấy lịch của A');
select is((select count(*) from public.cmo_memories), 0::bigint, 'B không thấy trí nhớ của A');
select is((select count(*) from public.operation_log), 0::bigint, 'B không thấy nhật ký của A');
select throws_ok($$ select public.cmo_decide_post('e1123000-0000-4000-8000-00000000000a', 'approve') $$,
  'P0002', 'Post not found.', 'B không duyệt bài của A');

set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000c"}';
select throws_ok($$ select public.enqueue_cmo_run('post_draft', '{}') $$, 'P0001',
  'Not enough credits: 1 needed, 0 left. Top up on the Credits page.', 'không đủ credit');

-- Trần mỗi ngày: lập kế hoạch 5 lần/ngày.
set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000b"}';
reset role;
insert into public.cmo_runs (user_id, kind, status, created_at)
select 'e1120000-0000-4000-8000-00000000000b', 'plan_week', 'done', now() - interval '1 hour' from generate_series(1, 5);
set local role authenticated;
select throws_ok($$ select public.enqueue_cmo_run('plan_week', '{}') $$, 'P0001',
  'You have reached today''s limit for this task. Try again tomorrow.', 'trần lập kế hoạch mỗi ngày');

-- ------------------------------------------------------------ phiên chat cmo
create temp table cs as select * from public.agent_open_cmo_session('fake');
grant select on cs to authenticated;
select is((select scope from cs), 'cmo', 'mở phiên cmo');
select is((public.agent_open_cmo_session('fake')).id, (select id from cs), 'mở lại trả phiên cũ');
select isnt((public.agent_open_cmo_session('fake', true)).id, (select id from cs), 'p_new tạo phiên mới');
select throws_ok($$ select public.agent_open_cmo_session('gpt-9') $$, '22023', 'Unknown assistant model.', 'model lạ');
select lives_ok($$ select public.agent_begin_turn((select id from cs), 'Plan my week', '[{"text":"Plan my week"}]') $$,
  'bắt đầu lượt chat trên phiên cmo (agent_owned_session không đòi job)');

set local request.jwt.claims = '{"sub":"e1120000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select public.agent_begin_turn((select id from cs), 'x', '[{"text":"x"}]') $$,
  'P0002', 'Assistant session not found.', 'A không dùng phiên cmo của B');

select * from finish();
rollback;
