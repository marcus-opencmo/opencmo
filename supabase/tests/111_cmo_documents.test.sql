-- Tầng CMO bước 1 (20261013090000): document marketing ghi theo version qua RPC,
-- agent chỉ ghi trong lượt đang chạy của chính người dùng, không chạy chồng,
-- trần 5 lượt/ngày, lượt chết sau 10 phút không chặn người dùng.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1110000-0000-4000-8000-00000000000a', 'cmo-a@test.local'),
  ('e1110000-0000-4000-8000-00000000000b', 'cmo-b@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1110000-0000-4000-8000-00000000000a"}';

select throws_ok($$ insert into public.marketing_documents (user_id, kind, version, body, created_by)
    values ('e1110000-0000-4000-8000-00000000000a', 'product', 1, '{}', 'user') $$,
  '42501', null, 'không insert thẳng document được');
select throws_ok($$ insert into public.cmo_runs (user_id, kind) values ('e1110000-0000-4000-8000-00000000000a', 'onboard') $$,
  '42501', null, 'không insert thẳng lượt chạy được');

select throws_ok($$ select public.start_cmo_run('post_draft', '{}') $$, '22023', 'Unknown task.', 'loại việc lạ bị chặn');

create temp table run1 as select (public.start_cmo_run('onboard', '{"site":"https://example.com"}')).id as id;
grant select on run1 to authenticated;
select is((select status from public.cmo_runs where id = (select id from run1)), 'running', 'lượt mới đang chạy');
select throws_ok($$ select public.start_cmo_run('onboard', '{}') $$,
  'P0001', 'Your marketing plan is already being built. Give it a minute.', 'không chạy chồng');

select is((public.save_marketing_document('product', '{"name":"Acme"}', (select id from run1))).created_by, 'agent', 'ghi trong lượt chạy = agent');
select is((public.save_marketing_document('product', '{"name":"Acme Inc"}')).created_by, 'user', 'không có lượt = người dùng');
select is((select max(version) from public.marketing_documents where kind = 'product'), 2, 'mỗi lần ghi một version mới');
select is((select body->>'name' from public.marketing_documents_latest where kind = 'product'), 'Acme Inc', 'view latest lấy bản mới nhất');
select is((select count(*) from public.marketing_documents_latest), 1::bigint, 'latest: một hàng mỗi loại');

select throws_ok($$ select public.save_marketing_document('lead_list', '{}') $$, '22023', 'Unknown document.', 'loại document lạ');
select throws_ok($$ select public.save_marketing_document('product', '[]') $$, '22023', 'This document is not valid.', 'body phải là object');
select throws_ok($$ select public.save_marketing_document('product', jsonb_build_object('x', repeat('a', 70000))) $$,
  '22023', 'This document is too long.', 'body quá 64 KB');

select is((public.finish_cmo_run((select id from run1), true)).status, 'done', 'kết thúc lượt');
select throws_ok($$ select public.finish_cmo_run((select id from run1), true) $$,
  'P0002', 'This task has already finished.', 'không kết thúc hai lần');
select throws_ok($$ select public.save_marketing_document('product', '{}', (select id from run1)) $$,
  'P0002', 'This task has already finished.', 'agent không ghi được sau khi lượt kết thúc');

-- Lượt chết (quá 10 phút) không chặn lượt mới.
reset role;
insert into public.cmo_runs (user_id, kind, created_at)
values ('e1110000-0000-4000-8000-00000000000a', 'onboard', now() - interval '11 minutes');
set local role authenticated;
create temp table run2 as select (public.start_cmo_run('onboard', '{}')).id as id;
grant select on run2 to authenticated;
select is((select count(*) from public.cmo_runs where status = 'failed' and error = 'Timed out.'), 1::bigint, 'lượt chết thành failed');
select lives_ok($$ select public.finish_cmo_run((select id from run2), false, 'Could not read the website.') $$, 'kết thúc lỗi');
select is((select error from public.cmo_runs where id = (select id from run2)), 'Could not read the website.', 'lưu lỗi');

-- Trần 5 lượt/ngày: đã có 3 (run1, lượt chết, run2) → thêm 2 thì đủ 5.
select lives_ok($$ select public.finish_cmo_run((public.start_cmo_run('onboard', '{}')).id, true) $$, 'lượt thứ 4');
select lives_ok($$ select public.finish_cmo_run((public.start_cmo_run('onboard', '{}')).id, true) $$, 'lượt thứ 5');
select throws_ok($$ select public.start_cmo_run('onboard', '{}') $$, 'P0001',
  'You can rebuild your plan 5 times a day. Try again tomorrow, or edit the documents directly.', 'lượt thứ 6 bị chặn');

-- B không đọc được của A, không ghi được vào lượt của A.
create temp table b_reuses as select id from run1;
grant select on b_reuses to authenticated;
reset role;
update public.cmo_runs set status = 'running' where id = (select id from run1);
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1110000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.marketing_documents), 0::bigint, 'B không đọc document của A');
select is((select count(*) from public.cmo_runs), 0::bigint, 'B không đọc lượt chạy của A');
select throws_ok($$ select public.save_marketing_document('product', '{}', (select id from b_reuses)) $$,
  'P0002', 'This task has already finished.', 'B không ghi vào lượt của A');
select throws_ok($$ select public.finish_cmo_run((select id from b_reuses), true) $$,
  'P0002', 'This task has already finished.', 'B không kết thúc lượt của A');

select * from finish();
rollback;
