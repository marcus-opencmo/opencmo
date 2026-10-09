-- RLS chứng minh bằng HAI người dùng thật, không phải bằng việc đọc policy.
--
-- Mỗi bảng được hỏi hai câu: "A có thấy của A không" và "A có thấy của B không".
-- Câu thứ hai mới là câu quan trọng — một policy viết sai thường vẫn cho chủ sở
-- hữu thấy đồ của mình.
--
-- Về ghi: RLS KHÔNG ném lỗi khi update/delete không khớp policy, nó lặng lẽ
-- sửa 0 hàng. Nên insert kiểm bằng `throws_ok` (42501), còn update/delete kiểm
-- bằng "returning không trả hàng nào". Cả hai đều là "không ghi được".
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(31);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-00000000000a', 'a@test.local'),
  ('b0000000-0000-4000-8000-00000000000b', 'b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('a1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('b1000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('b2000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

insert into public.artifacts (job_id, kind, data) values
  ('a1000000-0000-4000-8000-00000000000a', 'transcript', '{"v":1}'::jsonb),
  ('b1000000-0000-4000-8000-00000000000b', 'transcript', '{"v":1}'::jsonb);

update public.clips set settings = '{}'::jsonb, settings_hash = repeat(left(id::text, 1), 64);

insert into public.media_assets (id, user_id, job_id, storage_path, name) values
  ('a5000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a',
   'a1000000-0000-4000-8000-00000000000a', 'media/a0000000-0000-4000-8000-00000000000a/a1/one.mp4', 'one.mp4'),
  ('b5000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b',
   'b1000000-0000-4000-8000-00000000000b', 'media/b0000000-0000-4000-8000-00000000000b/b1/one.mp4', 'one.mp4');

insert into public.tasks (id, user_id, kind, clip_id, settings_hash, request_id) values
  ('a6000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'render_document',
   'a2000000-0000-4000-8000-00000000000a', repeat('a', 64), gen_random_uuid()),
  ('b6000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'render_document',
   'b2000000-0000-4000-8000-00000000000b', repeat('b', 64), gen_random_uuid());

insert into public.rate_limits (user_id, bucket, window_start, count) values
  ('a0000000-0000-4000-8000-00000000000a', 'preview', now(), 1),
  ('b0000000-0000-4000-8000-00000000000b', 'preview', now(), 1);

insert into storage.objects (bucket_id, name) values
  ('media', 'a0000000-0000-4000-8000-00000000000a/a1/one.mp4'),
  ('media', 'b0000000-0000-4000-8000-00000000000b/b1/one.mp4'),
  ('renders', 'a0000000-0000-4000-8000-00000000000a/a2/preview.mp4'),
  ('renders', 'b0000000-0000-4000-8000-00000000000b/b2/preview.mp4');

-- =========================================================== vai của A
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';

-- A thấy đúng đồ của A...
select is((select count(*) from public.jobs)::int, 1, 'A thấy job của A');
select is((select count(*) from public.clips)::int, 1, 'A thấy clip của A');
select is((select count(*) from public.artifacts)::int, 1, 'A thấy artifact của A');
select is((select settings_hash from public.clips), repeat('a', 64), 'A đọc settings gốc của clip mình');
select is((select count(*) from public.media_assets)::int, 1, 'A thấy B-roll của A');
select is((select count(*) from public.tasks)::int, 1, 'A thấy task của A');

-- ...và KHÔNG thấy gì của B, ở mọi bảng.
select is_empty($$ select id from public.jobs where user_id = 'b0000000-0000-4000-8000-00000000000b' $$, 'A không thấy job của B');
select is_empty($$ select id from public.clips where id = 'b2000000-0000-4000-8000-00000000000b' $$, 'A không thấy clip của B');
select is_empty($$ select data from public.artifacts where job_id = 'b1000000-0000-4000-8000-00000000000b' $$, 'A không thấy artifact của B');
select is_empty($$ select id from public.media_assets where user_id = 'b0000000-0000-4000-8000-00000000000b' $$, 'A không thấy B-roll của B');
select is_empty($$ select id from public.tasks where user_id = 'b0000000-0000-4000-8000-00000000000b' $$, 'A không thấy task của B');

-- Bảng đếm nhịp không có policy nào: kể cả hàng của chính mình cũng không đọc được.
select is_empty($$ select bucket from public.rate_limits $$, 'không ai đọc được rate_limits');

-- ------------------------------------------------------------ A không ghi
select throws_ok(
  $$ insert into public.tasks (user_id, kind, request_id)
     values ('a0000000-0000-4000-8000-00000000000a', 'render_document', gen_random_uuid()) $$,
  '42501', null, 'A không insert thẳng vào tasks'
);
select throws_ok(
  $$ insert into public.media_assets (user_id, job_id, storage_path, name)
     values ('a0000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a', 'media/x/y.mp4', 'y.mp4') $$,
  '42501', null, 'A không insert thẳng vào media_assets'
);
select throws_ok(
  $$ insert into public.artifacts (job_id, kind, data)
     values ('a1000000-0000-4000-8000-00000000000a', 'moments', '{}'::jsonb) $$,
  '42501', null, 'A không insert thẳng vào artifacts'
);
select throws_ok(
  $$ insert into public.rate_limits (user_id, bucket, window_start, count)
     values ('a0000000-0000-4000-8000-00000000000a', 'x', now(), 0) $$,
  '42501', null, 'A không insert thẳng vào rate_limits'
);

-- Update/delete không ném lỗi, chỉ không chạm được hàng nào — kể cả hàng của chính A.
select is_empty(
  $$ update public.tasks set status = 'done' where id = 'a6000000-0000-4000-8000-00000000000a' returning id $$,
  'A không tự chốt task'
);
select is_empty(
  $$ update public.clips set settings = '{"x": 1}'::jsonb where id = 'a2000000-0000-4000-8000-00000000000a' returning id $$,
  'A không tự sửa settings gốc của clip'
);

-- ---------------------------------------------------------------- storage
select is(
  (select count(*) from storage.objects where bucket_id = 'media')::int, 1,
  'A chỉ thấy B-roll trong thư mục của mình'
);
select is_empty(
  $$ select name from storage.objects
     where bucket_id = 'media' and name like 'b0000000-0000-4000-8000-00000000000b/%' $$,
  'A không thấy file media của B'
);
select is_empty(
  $$ select name from storage.objects
     where bucket_id = 'renders' and name like 'b0000000-0000-4000-8000-00000000000b/%' $$,
  'A không thấy bản render của B'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'renders')::int, 1,
  'A đọc được bản render của mình'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('media', 'a0000000-0000-4000-8000-00000000000a/a1/two.mp4') $$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'A không upload B-roll nếu chưa có reservation'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('media', 'b0000000-0000-4000-8000-00000000000b/b1/two.mp4') $$,
  '42501', null, 'A không upload vào thư mục của B'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('renders', 'a0000000-0000-4000-8000-00000000000a/a2/gia-mao.mp4') $$,
  '42501', null, 'A không ghi vào renders — chỉ worker ghi'
);

-- =========================================================== vai anon
set local role postgres;
reset request.jwt.claims;
set local role anon;

select is_empty($$ select job_id from public.artifacts $$, 'anon không đọc artifacts');
select is_empty($$ select settings from public.clips $$, 'anon không đọc settings của clip');
select is_empty($$ select id from public.media_assets $$, 'anon không đọc media_assets');
select is_empty($$ select id from public.tasks $$, 'anon không đọc tasks');
select is_empty($$ select bucket from public.rate_limits $$, 'anon không đọc rate_limits');
select is_empty($$ select name from storage.objects $$, 'anon không đọc file nào');

set local role postgres;
select * from finish();
rollback;
