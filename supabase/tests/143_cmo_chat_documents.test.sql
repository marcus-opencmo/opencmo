-- 20261113090000: the CMO chat saves a new version of the founder's own document, badged as OpenCMO's.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(7);

insert into auth.users (id, email) values
  ('e1430000-0000-4000-8000-00000000000a', 'cd-a@test.local'),
  ('e1430000-0000-4000-8000-00000000000b', 'cd-b@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1430000-0000-4000-8000-00000000000a"}';

select is((select version from public.save_marketing_document('product', '{"name":"Paylane"}')), 1, 'the founder saves version 1');
select is((select version from public.cmo_chat_save_document('product', '{"name":"Paylane","pricing":"$12/month"}')), 2, 'the chat saves the next version');
select is((select created_by from public.marketing_documents where kind = 'product' and version = 2), 'agent', 'badged as OpenCMO');
select is((select created_by from public.marketing_documents where kind = 'product' and version = 1), 'user', 'the old version stays in history');
select throws_ok($$ select public.cmo_chat_save_document('calendar_x', '{}') $$, '22023', 'Unknown document.', 'unknown documents are refused');
select throws_ok($$ select public.cmo_chat_save_document('product', '[]') $$, '22023', 'This document is not valid.', 'the body must be an object');

set local request.jwt.claims = '{"sub":"e1430000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.marketing_documents), 0, 'another founder sees none of it');

select * from finish();
rollback;
