-- 20261023090000: cancel_export — chủ huỷ được export chờ/chạy; xong rồi thì không; người khác không thấy.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(6);

insert into auth.users (id, email) values
  ('e1210000-0000-4000-8000-00000000000a', 'ce-a@test.local'),
  ('e1210000-0000-4000-8000-00000000000b', 'ce-b@test.local');
insert into public.tasks (id, user_id, kind, status, request_id, payload) values
  ('e1211000-0000-4000-8000-00000000000a', 'e1210000-0000-4000-8000-00000000000a', 'render_document', 'queued', gen_random_uuid(), '{}'),
  ('e1211100-0000-4000-8000-00000000000a', 'e1210000-0000-4000-8000-00000000000a', 'render_document', 'running', gen_random_uuid(), '{}'),
  ('e1211200-0000-4000-8000-00000000000a', 'e1210000-0000-4000-8000-00000000000a', 'render_document', 'done', gen_random_uuid(), '{}'),
  ('e1211300-0000-4000-8000-00000000000a', 'e1210000-0000-4000-8000-00000000000a', 'zip', 'queued', gen_random_uuid(), '{}');
update public.tasks set attempt_id = 'e1219000-0000-4000-8000-00000000000a' where id = 'e1211100-0000-4000-8000-00000000000a';

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1210000-0000-4000-8000-00000000000a"}';

select is((public.cancel_export('e1211000-0000-4000-8000-00000000000a')).status, 'cancelled', 'export đang chờ: huỷ ngay');
select is((public.cancel_export('e1211100-0000-4000-8000-00000000000a')).status, 'cancelled', 'export đang chạy: đánh dấu huỷ');
select throws_ok($$ select public.cancel_export('e1211200-0000-4000-8000-00000000000a') $$, 'P0001', 'This export has already finished.', 'export đã xong thì không huỷ');
select throws_ok($$ select public.cancel_export('e1211300-0000-4000-8000-00000000000a') $$, 'P0002', null, 'không phải export (zip) thì không huỷ ở đây');

reset role;
select is(public.heartbeat_task('e1211100-0000-4000-8000-00000000000a', 'e1219000-0000-4000-8000-00000000000a'), false, 'heartbeat của worker trả false sau khi huỷ');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1210000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.cancel_export('e1211000-0000-4000-8000-00000000000a') $$, 'P0002', 'Export not found.', 'người khác không huỷ được');

select * from finish();
rollback;
