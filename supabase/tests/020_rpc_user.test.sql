-- RPC của người dùng: đúng chủ thì chạy, chủ khác thì "không tìm thấy", tham số
-- sai thì có một câu tiếng Anh cụ thể.
--
-- Mọi assertion chạy DƯỚI vai `authenticated` với một JWT giả, tức đúng đường mà
-- PostgREST đi. Chạy dưới vai postgres sẽ bỏ qua cả RLS lẫn phần kiểm quyền.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(16);

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

-- ======================================================= register_media_asset
-- Bốn tham số từ D3: bản ba tham số đã thu quyền, vì gọi nó là tạo asset mà
-- không có task probe nào — asset nằm 'pending' vĩnh viễn.
reset role;
insert into public.upload_reservations(user_id,bucket,object_name,declared_size,content_type,project_id)
values('a0000000-0000-4000-8000-00000000000a','media',
 'a0000000-0000-4000-8000-00000000000a/a1000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',100,'video/mp4','a1000000-0000-4000-8000-00000000000a');
insert into storage.objects(bucket_id,name,metadata) values('media',
 'a0000000-0000-4000-8000-00000000000a/a1000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4','{"size":100,"mimetype":"video/mp4"}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';
select is(
  public.register_media_asset('a1000000-0000-4000-8000-00000000000a',
     'media/a0000000-0000-4000-8000-00000000000a/a1000000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',
     'broll.mp4', 'a5000000-0000-4000-8000-00000000000a') -> 'asset' ->> 'status',
  'pending', 'B-roll mới chờ worker probe'
);

select throws_ok(
  $$ select public.register_media_asset('a1000000-0000-4000-8000-00000000000a',
       'media/a0000000-0000-4000-8000-00000000000a/../../b0000000-0000-4000-8000-00000000000b/x.mp4', 'x.mp4',
       gen_random_uuid()) $$,
  '22023', 'That media file is no longer available. Please try again.',
  'đường dẫn vượt thư mục bị chặn (đủ số segment, không chỉ segment đầu)'
);

select throws_ok(
  $$ select public.register_media_asset('b1000000-0000-4000-8000-00000000000b',
       'media/a0000000-0000-4000-8000-00000000000a/b1000000-0000-4000-8000-00000000000b/c0000000-0000-4000-8000-0000000000c2.mp4', 'x.mp4',
       gen_random_uuid()) $$,
  'P0002', 'Project not found.', 'A không gắn B-roll vào project của B'
);

-- ============================================================== project
select is(
  (public.rename_project('a1000000-0000-4000-8000-00000000000a', '  Tên mới  ')).name,
  'Tên mới', 'rename_project cắt khoảng trắng'
);

select throws_ok(
  $$ select public.rename_project('b1000000-0000-4000-8000-00000000000b', 'Của B') $$,
  'P0002', 'Project not found.', 'A không đổi tên project của B'
);

select is(
  (public.cancel_job('a1100000-0000-4000-8000-00000000000a')).status::text,
  'cancelled', 'cancel_job huỷ được job đang chạy'
);

select throws_ok(
  $$ select public.cancel_job('a1000000-0000-4000-8000-00000000000a') $$,
  '22023', 'This project has already finished.', 'job đã xong thì không huỷ'
);

select throws_ok(
  $$ select public.delete_job('b1000000-0000-4000-8000-00000000000b') $$,
  'P0002', 'Project not found.', 'A không xoá project của B'
);

-- ========================================================= list_projects
select is(
  (select count(*) from public.list_projects())::int, 2,
  'list_projects chỉ trả project của mình'
);

select is(
  (select count(*) from public.list_projects(null, null, 'Tên'))::int, 1,
  'tìm theo tên'
);

-- `%` người dùng gõ là chữ, không phải ký tự đại diện.
select is(
  (select count(*) from public.list_projects(null, null, '%'))::int, 0,
  'ký tự đại diện trong ô tìm kiếm được escape'
);

-- Hai job của A tạo trong cùng một câu lệnh nên `created_at` bằng nhau; đây
-- chính là ca mà con trỏ chỉ có `created_at` sẽ lặp vô hạn, và là lý do khoá
-- phân trang phải là cặp `(created_at, id)`.
select is(
  (select count(*) from public.list_projects(
     (select created_at from public.list_projects() limit 1),
     (select id from public.list_projects() limit 1)))::int,
  1, 'con trỏ keyset bỏ qua các hàng đã trả'
);

select is(
  (select count(*) from public.list_projects(null, null, null, 1000))::int, 2,
  'p_limit bị kẹp, không trả cả bảng'
);

-- ======================================================= rate_limit_hit
select ok(public.rate_limit_hit('preview', 2, 60), 'lượt đầu trong hạn mức');
select ok(public.rate_limit_hit('preview', 2, 60), 'lượt thứ hai vẫn trong hạn mức');
select ok(not public.rate_limit_hit('preview', 2, 60), 'lượt thứ ba vượt hạn mức');

set local role postgres;
select * from finish();
rollback;
