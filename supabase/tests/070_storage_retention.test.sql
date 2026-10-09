create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select plan(3);

insert into auth.users (id, email)
values ('70000000-0000-4000-8000-000000000007', 'retention@test.local');

insert into public.jobs (id, user_id, source_url)
values (
  '71000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000007',
  'https://example.com/video'
);

select ok(
  (select expires_at between created_at + interval '6 days 23 hours'
                         and created_at + interval '7 days 1 hour'
   from public.jobs where id = '71000000-0000-4000-8000-000000000007'),
  'job mới mặc định hết hạn sau bảy ngày'
);

update public.jobs
set status = 'done', finished_at = '2026-09-18 12:00:00+00'
where id = '71000000-0000-4000-8000-000000000007';

select is(
  (select expires_at from public.jobs where id = '71000000-0000-4000-8000-000000000007'),
  '2026-09-25 12:00:00+00'::timestamptz,
  'job done hết hạn đúng bảy ngày từ finished_at'
);

update public.jobs
set status = 'queued', finished_at = null
where id = '71000000-0000-4000-8000-000000000007';

select ok(
  (select expires_at between now() + interval '6 days 23 hours'
                         and now() + interval '7 days 1 hour'
   from public.jobs where id = '71000000-0000-4000-8000-000000000007'),
  'retry mở lại cửa sổ lưu trữ bảy ngày'
);

select * from finish();
rollback;

