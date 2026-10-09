-- R2: một lượt `claim_next_task` với cả mảng kind, thứ tự mảng là thứ tự ưu tiên.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select plan(5);

insert into auth.users (id, email) values ('f1290000-0000-4000-8000-00000000000a', 'r2@test.local');
insert into public.jobs (id, user_id, source_url, status) values
  ('f1291000-0000-4000-8000-00000000000a', 'f1290000-0000-4000-8000-00000000000a', 'https://a', 'done');

-- zip vào hàng TRƯỚC (cũ hơn), probe_media sau: ưu tiên phải thắng tuổi.
insert into public.tasks (id, user_id, kind, job_id, request_id, created_at) values
  ('f1292000-0000-4000-8000-000000000001', 'f1290000-0000-4000-8000-00000000000a', 'zip',
   'f1291000-0000-4000-8000-00000000000a', gen_random_uuid(), now() - interval '1 hour'),
  ('f1292000-0000-4000-8000-000000000002', 'f1290000-0000-4000-8000-00000000000a', 'zip',
   'f1291000-0000-4000-8000-00000000000a', gen_random_uuid(), now() - interval '2 hours'),
  ('f1292000-0000-4000-8000-000000000003', 'f1290000-0000-4000-8000-00000000000a', 'probe_media',
   'f1291000-0000-4000-8000-00000000000a', gen_random_uuid(), now());

set local role service_role;
select is(
  (select id from public.claim_next_task(array['probe_media', 'zip'])),
  'f1292000-0000-4000-8000-000000000003'::uuid,
  'kind đứng trước trong mảng thắng task cũ hơn'
);
select is(
  (select id from public.claim_next_task(array['probe_media', 'zip'])),
  'f1292000-0000-4000-8000-000000000002'::uuid,
  'cùng kind thì task cũ nhất trước'
);
select is(
  (select id from public.claim_next_task(array['zip', 'probe_media'])),
  'f1292000-0000-4000-8000-000000000001'::uuid,
  'đổi thứ tự mảng là đổi ưu tiên'
);
select is_empty(
  $$ select id from public.claim_next_task(array['probe_media', 'zip']) $$,
  'hàng đợi rỗng thì không trả hàng nào'
);
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.claim_next_task(text[], int)', 'execute'),
  'người dùng không tự claim việc của worker'
);

select * from finish();
rollback;
