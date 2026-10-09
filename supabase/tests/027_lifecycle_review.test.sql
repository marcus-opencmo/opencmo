-- pgtap nằm ở schema `extensions`, không tự có trên search_path lúc chạy test;
-- thiếu dòng `set search_path` thì ngay `plan()` đã không phân giải được.
-- `create extension` đặt NGOÀI transaction như các file test khác, để lần chạy
-- sau không phải tạo lại.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(10);
insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-000000000001','review-a@test.local'),
 ('a1000000-0000-0000-0000-000000000002','review-b@test.local');
insert into public.jobs(id,user_id,source_url,status) values
 ('b1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','https://youtu.be/test','queued');
insert into public.credit_ledger(user_id,delta,reason,job_id) values
 ('a1000000-0000-0000-0000-000000000001',-10,'Hold','b1000000-0000-0000-0000-000000000001');
select ok(not has_function_privilege('anon','public.credit_balance(uuid)','execute'), 'anon cannot read balances');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000002"}';
select is(public.credit_balance('a1000000-0000-0000-0000-000000000001'),0,'other balance hidden by RLS');
select throws_ok($$update public.profiles set plan='pro' where id='a1000000-0000-0000-0000-000000000002'$$,
 '42501',null,'user cannot change own billing plan');
select throws_ok($$select public.cancel_job('b1000000-0000-0000-0000-000000000001')$$,
 'P0002','Project not found.','other user cannot cancel');
set local request.jwt.claims = '{"sub":"a1000000-0000-0000-0000-000000000001"}';
select throws_ok($$select public.delete_job('b1000000-0000-0000-0000-000000000001')$$,
 '22023','Stop this project before deleting it.','queued job must cancel before deletion');
select is((public.cancel_job('b1000000-0000-0000-0000-000000000001')).status::text,'cancelled','cancel transitions');
select is((public.cancel_job('b1000000-0000-0000-0000-000000000001')).status::text,'cancelled','cancel retry is idempotent');
reset role;
select is(public.job_credits_spent('b1000000-0000-0000-0000-000000000001'),0,'cancel refunds all held credits');
select is((select count(*)::int from public.credit_ledger where job_id='b1000000-0000-0000-0000-000000000001' and delta>0),1,'only one refund');
set local role authenticated;
select is(public.delete_job('b1000000-0000-0000-0000-000000000001'),true,'cancelled job may delete');
select * from finish();
rollback;
