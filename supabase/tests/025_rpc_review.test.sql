-- RPC của người dùng: đúng chủ thì chạy, chủ khác thì "không tìm thấy", tham số
-- sai thì có một câu tiếng Anh cụ thể.
--
-- Mọi assertion chạy DƯỚI vai `authenticated` với một JWT giả, tức đúng đường mà
-- PostgREST đi. Chạy dưới vai postgres sẽ bỏ qua cả RLS lẫn phần kiểm quyền.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(1);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-00000000000a', 'a@test.local'),
  ('b0000000-0000-4000-8000-00000000000b', 'b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('a1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('a1100000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'https://a2', 600, 'running'),
  ('b1000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('b2000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

update public.clips set settings = '{"source_start": 1, "source_end": 20}'::jsonb, settings_hash = repeat('a', 64)
where id in ('a2000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-00000000000b');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';


reset role;
insert into public.media_assets (user_id, job_id, storage_path, name)
select 'a0000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 'media/a0000000-0000-4000-8000-00000000000a/a1000000-0000-4000-8000-00000000000a/' || gen_random_uuid() || '.mp4', 'Video'
from generate_series(1,50);
set local role authenticated;
select lives_ok(format('select public.register_media_asset(%L, %L, %L, %L)', 'a1000000-0000-4000-8000-00000000000a',
 (select storage_path from public.media_assets where job_id='a1000000-0000-4000-8000-00000000000a' limit 1), 'Retry',
 gen_random_uuid()), 'Replay thành công khi đủ 50 media');
select * from finish();
rollback;
