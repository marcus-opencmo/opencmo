-- 20261108090000: tài khoản chưa từng trả tiền bị xoá sau 30 ngày kể từ `retention_from`.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(14);

-- a: free quá hạn · b: free còn hạn · c: đơn đã trả · d: đơn hoàn hết · e: đơn $0
-- f: gói active · g: quá hạn nhưng có task đang chạy · h: miễn tay
insert into auth.users (id, email) values
  ('e1380000-0000-4000-8000-00000000000a', 'ret-a@test.local'),
  ('e1380000-0000-4000-8000-00000000000b', 'ret-b@test.local'),
  ('e1380000-0000-4000-8000-00000000000c', 'ret-c@test.local'),
  ('e1380000-0000-4000-8000-00000000000d', 'ret-d@test.local'),
  ('e1380000-0000-4000-8000-00000000000e', 'ret-e@test.local'),
  ('e1380000-0000-4000-8000-00000000000f', 'ret-f@test.local'),
  ('e1380000-0000-4000-8000-000000000010', 'ret-g@test.local'),
  ('e1380000-0000-4000-8000-000000000011', 'ret-h@test.local');

select ok((select retention_from > now() - interval '1 minute' from public.profiles where id = 'e1380000-0000-4000-8000-00000000000b'),
  'user mới: đồng hồ bắt đầu lúc đăng ký');

update public.profiles set retention_from = now() - interval '31 days'
where id::text like 'e1380000-%' and id <> 'e1380000-0000-4000-8000-00000000000b';
update public.profiles set retention_exempt = true where id = 'e1380000-0000-4000-8000-000000000011';

insert into public.polar_purchases (order_id, customer_id, user_id, total_amount, refunded_amount, paid_at) values
  ('ord-c', 'cus-c', 'e1380000-0000-4000-8000-00000000000c', 1500, 0, now()),
  ('ord-d', 'cus-d', 'e1380000-0000-4000-8000-00000000000d', 1500, 1500, now()),
  ('ord-e', 'cus-e', 'e1380000-0000-4000-8000-00000000000e', 0, 0, now());
insert into public.polar_subscriptions (subscription_id, customer_id, user_id, plan, status, provider_updated_at, status_priority, event_id)
values ('sub-f', 'cus-f', 'e1380000-0000-4000-8000-00000000000f', 'starter', 'active', now(), 1, 'evt-f');

select is(public.account_is_paid('e1380000-0000-4000-8000-00000000000c'), true, 'đơn đã trả → đã trả tiền');
select is(public.account_is_paid('e1380000-0000-4000-8000-00000000000d'), false, 'đơn hoàn hết → coi như chưa trả');
select is(public.account_is_paid('e1380000-0000-4000-8000-00000000000e'), false, 'đơn $0 không tính');
select is(public.account_is_paid('e1380000-0000-4000-8000-00000000000f'), true, 'gói active → đã trả tiền');
select is(public.account_is_paid('e1380000-0000-4000-8000-000000000011'), true, 'miễn tay');

-- g có task đang chạy: chờ lượt sau.
insert into public.jobs (id, user_id, source_url, kind)
values ('e1380000-0000-4000-8000-0000000000aa', 'e1380000-0000-4000-8000-000000000010', 'editor://blank', 'edit');
insert into public.tasks (user_id, job_id, kind, status, request_id)
values ('e1380000-0000-4000-8000-000000000010', 'e1380000-0000-4000-8000-0000000000aa', 'zip', 'running', gen_random_uuid());

insert into storage.objects (bucket_id, name) values
  ('media', 'e1380000-0000-4000-8000-00000000000a/j/a.png'),
  ('brand', 'e1380000-0000-4000-8000-00000000000a/logo.png'),
  ('media', 'e1380000-0000-4000-8000-00000000000c/j/c.png');

-- Banner của chính mình.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1380000-0000-4000-8000-00000000000b"}';
select ok((public.account_retention()->>'delete_after')::timestamptz > now() + interval '29 days', 'banner: còn ~30 ngày');
set local request.jwt.claims = '{"sub":"e1380000-0000-4000-8000-00000000000c"}';
select is(public.account_retention()->>'paid', 'true', 'banner: đã trả tiền thì không có hạn');
select is(has_function_privilege('authenticated', 'public.purge_unpaid_accounts(integer)', 'execute'), false, 'người dùng không gọi purge');
select throws_ok($$ update public.profiles set retention_exempt = true where id = auth.uid() $$, '42501', null, 'người dùng không tự miễn');
reset role;

create temporary table purged as select * from public.purge_unpaid_accounts(500) as id;
select set_eq(
  $$ select id from purged where id::text like 'e1380000-%' $$,
  $$ values ('e1380000-0000-4000-8000-00000000000a'::uuid), ('e1380000-0000-4000-8000-00000000000d'::uuid), ('e1380000-0000-4000-8000-00000000000e'::uuid) $$,
  'chỉ chọn free quá hạn, không việc đang chạy'
);
select set_eq(
  $$ select bucket || ':' || path from public.storage_deletions where user_id = 'e1380000-0000-4000-8000-00000000000a' $$,
  $$ values ('media:e1380000-0000-4000-8000-00000000000a/j/a.png'), ('brand:e1380000-0000-4000-8000-00000000000a/logo.png') $$,
  'mọi file của user vào hàng đợi xoá'
);
select is((select count(*)::int from public.storage_deletions where path like 'e1380000-0000-4000-8000-00000000000c/%'), 0, 'file người đã trả không bị đụng');
select throws_ok($$ select public.purge_unpaid_accounts(0) $$, 'P0001', 'p_limit must be between 1 and 500.', 'giới hạn lô');

select * from finish();
rollback;
