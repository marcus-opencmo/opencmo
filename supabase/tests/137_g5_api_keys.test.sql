-- 20261107090000 (G5): khoá API cho MCP — chỉ lưu hash, khoá gốc trả một lần, thu hồi được.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(11);

insert into auth.users (id, email) values
  ('e1370000-0000-4000-8000-00000000000a', 'mcp-a@test.local'),
  ('e1370000-0000-4000-8000-00000000000b', 'mcp-b@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1370000-0000-4000-8000-00000000000a"}';

create temporary table made as select public.create_api_key('Claude Desktop') as k;
select ok((select k->>'key' from made) ~ '^ocm_[0-9a-f]{48}$', 'khoá gốc trả về một lần, dạng ocm_…');
select is((select k->>'prefix' from made), left((select k->>'key' from made), 12), 'prefix để nhận ra khoá');
select is((select count(*)::int from public.api_keys), 1, 'chủ thấy khoá của mình');
select throws_ok($$ select key_hash from public.api_keys $$, '42501', null, 'không đọc được cột hash, kể cả của mình');
select throws_ok($$ select public.create_api_key('   ') $$, '22023', 'Name the key in 1 to 60 characters.', 'tên rỗng');
-- Kiểm quyền qua catalog (như 035): pgTAP trên PG17 của Supabase từng segfault khi bắt
-- permission denied của HÀM.
select is(has_function_privilege('authenticated', 'public.api_key_owner(text)', 'execute'), false, 'người dùng không tra chủ khoá');

set local request.jwt.claims = '{"sub":"e1370000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.api_keys), 0, 'người khác không thấy khoá');
select is(public.revoke_api_key((select (k->>'id')::uuid from made)), false, 'người khác không thu hồi được');

reset role;
select is(public.api_key_owner(encode(digest((select k->>'key' from made), 'sha256'), 'hex')),
  'e1370000-0000-4000-8000-00000000000a'::uuid, 'service: hash → chủ khoá');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1370000-0000-4000-8000-00000000000a"}';
select is(public.revoke_api_key((select (k->>'id')::uuid from made)), true, 'chủ thu hồi khoá');
reset role;
select is(public.api_key_owner(encode(digest((select k->>'key' from made), 'sha256'), 'hex')), null, 'khoá đã thu hồi không còn chủ');

select * from finish();
rollback;
