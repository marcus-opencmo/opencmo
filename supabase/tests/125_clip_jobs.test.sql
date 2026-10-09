-- 20261027090000: một cửa tạo job clip — link phải có xác nhận chính chủ, ghi video_ownership;
-- create_job thôi công khai.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(6);

insert into auth.users (id, email) values ('e1250000-0000-4000-8000-00000000000a', 'cj-a@test.local');
insert into public.credit_ledger (user_id, delta, reason)
select 'e1250000-0000-4000-8000-00000000000a', 50, 'test';

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1250000-0000-4000-8000-00000000000a"}';

select throws_ok($$ select public.create_clip_job('https://youtu.be/mine', 3) $$,
  '22023', 'Confirm this is your own video to continue.', 'link không xác nhận bị từ chối');
select is((select count(*)::int from public.jobs where user_id = 'e1250000-0000-4000-8000-00000000000a'), 0, '...và không tạo job, không giữ credit');
create temp table made as select (public.create_clip_job('https://youtu.be/mine', 3, p_ownership_confirmed => true)).id as job_id;
select is((select source || ':' || url from public.video_ownership where job_id = (select job_id from made)), 'link:https://youtu.be/mine', 'có xác nhận: ghi video_ownership kèm link');
select ok(exists (select 1 from public.credit_ledger where job_id = (select job_id from made) and reason = 'Hold for new job'), 'giữ credit như create_job');
select throws_ok($$ select public.create_job('https://youtu.be/bypass', 3) $$, '42501', null, 'gọi thẳng create_job bị chặn');

reset role;
select is(has_function_privilege('authenticated', 'public.create_job(text, int, text, jsonb, text, text, text, boolean, text)', 'execute'), false, 'authenticated không còn quyền create_job');

select * from finish();
rollback;
