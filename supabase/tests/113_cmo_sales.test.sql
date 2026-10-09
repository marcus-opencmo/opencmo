-- Tầng CMO đợt 2 (20261015090000): W4 quét Reddit — giá 5 credit, trần 3 lần/ngày,
-- lượt quét rỗng được hoàn credit, thread không lặp, người dùng tự trả lời/bỏ.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1130000-0000-4000-8000-00000000000a', 'sales-a@test.local'),
  ('e1130000-0000-4000-8000-00000000000b', 'sales-b@test.local');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1130000-0000-4000-8000-00000000000a', 50, 'test grant'),
  ('e1130000-0000-4000-8000-00000000000b', 50, 'test grant');
create temp table bal as select public.credit_balance('e1130000-0000-4000-8000-00000000000a') as v;
grant select on bal to authenticated, service_role;

-- Một mục Reddit tới hạn hôm nay trên lịch của A.
insert into public.content_items (user_id, department, platform, day, idea)
values ('e1130000-0000-4000-8000-00000000000a', 'sales', 'Reddit', current_date, 'Join late-payment threads');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1130000-0000-4000-8000-00000000000a"}';

select throws_ok($$ insert into public.opportunities (user_id, url, title, score, reply)
    values ('e1130000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/x/1', 't', 80, 'r') $$,
  '42501', null, 'không insert thẳng opportunities được');

create temp table r1 as select * from public.enqueue_cmo_run('sales_scan', '{}');
grant select on r1 to authenticated, service_role;
select is((select credits from r1), 5, 'quét Reddit giữ 5 credit');
select is(public.credit_balance('e1130000-0000-4000-8000-00000000000a'), (select v from bal) - 5, 'số dư trừ 5');

reset role;
set local role service_role;
select is((public.claim_cmo_run((select id from r1))).attempt, 1, 'nhận lượt quét');

select throws_ok($$ select public.cmo_save_opportunities('e1130000-0000-4000-8000-00000000000a', null, '{}') $$,
  '22023', 'These conversations are not valid.', 'phải là mảng');
select is(public.cmo_save_opportunities('e1130000-0000-4000-8000-00000000000a', (select id from r1), jsonb_build_array(
  jsonb_build_object('url', 'https://www.reddit.com/r/freelance/comments/abc/late', 'community', 'r/freelance', 'title', 'Clients pay 60 days late',
    'author', 'u/mo', 'snippet', 'I hate chasing', 'posted_at', now() - interval '5 hours', 'comments', 23, 'score', 88,
    'score_parts', '[{"label":"Pain","score":23,"max":25,"evidence":"I hate chasing"}]'::jsonb, 'reply', 'Put the due date on the invoice.'),
  jsonb_build_object('url', 'https://www.reddit.com/r/smallbusiness/comments/def/tool', 'title', 'Invoicing tool?', 'score', 64, 'reply', 'Look for reminders.')
)), 2, 'ghi 2 cơ hội');
select is(public.cmo_save_opportunities('e1130000-0000-4000-8000-00000000000a', (select id from r1), jsonb_build_array(
  jsonb_build_object('url', 'https://www.reddit.com/r/freelance/comments/abc/late', 'title', 'Again', 'score', 90, 'reply', 'x')
)), 0, 'thread đã thấy không ghi lại');
select throws_ok($$ select public.cmo_save_opportunities('e1130000-0000-4000-8000-00000000000a', null, jsonb_build_array(
  jsonb_build_object('url', 'https://evil.example/r/x', 'title', 't', 'score', 70, 'reply', 'r'))) $$,
  '23514', null, 'chỉ nhận link reddit.com');
select is((select priority from public.opportunities where title = 'Clients pay 60 days late'), 'high', 'điểm ≥ 85 là high');
select is((select priority from public.opportunities where title = 'Invoicing tool?'), 'low', 'điểm < 70 là low');
select is((select status from public.content_items where department = 'sales'), 'published', 'mục Reddit tới hạn coi như đã làm');

select ok(public.complete_cmo_run((select id from r1), 1, true, '{"cards":2}'), 'lượt quét xong');
select is(public.credit_balance('e1130000-0000-4000-8000-00000000000a'), (select v from bal) - 5, 'lượt có thẻ không hoàn credit');

-- Lượt quét rỗng: xong nhưng hoàn credit.
create temp table r2 as select * from public.enqueue_cmo_run_for('e1130000-0000-4000-8000-00000000000a', 'sales_scan', '{}');
select is((public.claim_cmo_run((select id from r2))).attempt, 1, 'nhận lượt quét thứ hai');
select ok(public.complete_cmo_run((select id from r2), 1, true, '{"cards":0,"refund":true}'), 'lượt rỗng xong');
select is((select status from public.cmo_runs where id = (select id from r2)), 'done', 'lượt rỗng vẫn là done');
select is(public.credit_balance('e1130000-0000-4000-8000-00000000000a'), (select v from bal) - 5, 'lượt rỗng được hoàn 5 credit');

-- ------------------------------------------------------------ người dùng quyết
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1130000-0000-4000-8000-00000000000a"}';
select is((select count(*) from public.opportunities where status = 'in_review'), 2::bigint, 'A thấy 2 cơ hội');
select throws_ok($$ select public.cmo_decide_opportunity((select id from public.opportunities where title = 'Invoicing tool?'), 'post') $$,
  '22023', 'Unknown action.', 'không có hành động đăng');
select is((public.cmo_decide_opportunity((select id from public.opportunities where title = 'Clients pay 60 days late'), 'replied')).status,
  'replied', 'đánh dấu đã trả lời');
select throws_ok($$ select public.cmo_decide_opportunity((select id from public.opportunities where title = 'Clients pay 60 days late'), 'dismissed') $$,
  'P0001', 'This conversation was already decided.', 'không quyết hai lần');
select is((public.cmo_decide_opportunity((select id from public.opportunities where title = 'Invoicing tool?'), 'dismissed', 'Not our market')).status,
  'dismissed', 'bỏ');
select is((select body from public.cmo_memories where type = 'feedback'), 'Dismissed the Reddit thread "Invoicing tool?": Not our market',
  'lý do bỏ thành trí nhớ');

-- Trần 3 lần quét/ngày: đã có 2 lượt.
create temp table r3 as select * from public.enqueue_cmo_run('sales_scan', '{}');
grant select on r3 to authenticated;
reset role;
update public.cmo_runs set status = 'done' where id = (select id from r3);
set local role authenticated;
select throws_ok($$ select public.enqueue_cmo_run('sales_scan', '{}') $$, 'P0001',
  'You have reached today''s limit for this task. Try again tomorrow.', 'trần 3 lần quét/ngày');

-- ------------------------------------------------------------ cô lập
set local request.jwt.claims = '{"sub":"e1130000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.opportunities), 0::bigint, 'B không thấy cơ hội của A');
select throws_ok($$ select public.cmo_decide_opportunity('00000000-0000-4000-8000-000000000000', 'replied') $$,
  'P0002', 'Conversation not found.', 'B không quyết được thứ không có');

select * from finish();
rollback;
