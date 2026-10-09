-- 20261020090000: cửa sổ 60 giây không cộng vào hàng của hạn mức ngày.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(3);

insert into auth.users (id, email) values ('e1180000-0000-4000-8000-00000000000a', 'rl@test.local');
-- Dựng lại đúng ca nửa đêm: hàng ngày `preview` đã đầy và có cùng đầu cửa sổ
-- với cửa sổ 60 giây hiện tại.
insert into public.rate_limits (user_id, bucket, window_start, count) values (
  'e1180000-0000-4000-8000-00000000000a', 'preview',
  to_timestamp(floor(extract(epoch from now()) / 60) * 60), 50);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1180000-0000-4000-8000-00000000000a"}';

select ok(public.rate_limit_hit('preview', 2, 60), 'lượt đầu của cửa sổ 60 giây không bị số trong ngày chặn');
select ok(public.rate_limit_hit('preview', 2, 60), 'lượt thứ hai vẫn trong hạn mức');
select ok(not public.rate_limit_hit('preview', 2, 60), 'lượt thứ ba vượt hạn mức 60 giây');

select * from finish();
rollback;
