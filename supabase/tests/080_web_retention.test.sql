-- Retention: mọi bucket, tombstone trước khi xoá, hàng đợi bền vững qua cascade.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select has_table('public', 'storage_deletions', 'có hàng đợi xoá bền vững');
select has_column('public', 'jobs', 'purging_at', 'job có cột tombstone');

-- Bộ test có thể chạy trên DB dev đã có dữ liệu từ API/E2E trước đó. Hai bảng
-- này là state hàng đợi/cửa sổ đếm toàn cục, nên dọn trong transaction để các
-- assertion bên dưới chỉ nhìn fixture; rollback cuối file trả lại dữ liệu thật.
delete from public.storage_deletions;
delete from public.rate_limits;

insert into auth.users (id, email) values
  ('d0000000-0000-4000-8000-00000000d001', 'retention-one@test.local'),
  ('d0000000-0000-4000-8000-00000000d002', 'retention-two@test.local');

-- Project hết hạn, đủ object trong cả bốn bucket.
insert into public.jobs (id, user_id, source_url, status, expires_at, media_manifest) values
  ('d1000000-0000-4000-8000-00000000d001', 'd0000000-0000-4000-8000-00000000d001',
   'storage://d0000000-0000-4000-8000-00000000d001/upload-one.mp4', 'done', now() - interval '1 day',
   jsonb_build_object(
     'sections', jsonb_build_array(jsonb_build_object('bucket','sources','object','d0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/sections/att/0-1000.mp4')),
     'proxies', jsonb_build_object('d2000000-0000-4000-8000-00000000d001', jsonb_build_object('bucket','sources','object','d0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/proxy/clip.mp4')))),
  -- Project còn hạn: không được đụng tới.
  ('d1000000-0000-4000-8000-00000000d002', 'd0000000-0000-4000-8000-00000000d001',
   'storage://d0000000-0000-4000-8000-00000000d001/upload-two.mp4', 'done', now() + interval '3 days', null),
  -- Project hết hạn nhưng còn một export đang chạy.
  ('d1000000-0000-4000-8000-00000000d003', 'd0000000-0000-4000-8000-00000000d002',
   'https://example.com/video', 'done', now() - interval '1 day', null);

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end, storage_path, preview_path) values
  ('d2000000-0000-4000-8000-00000000d001', 'd1000000-0000-4000-8000-00000000d001', 0, 1, 20, 1, 20,
   'd0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/0/clip.mp4',
   'd0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/0/clip.preview.mp4'),
  ('d2000000-0000-4000-8000-00000000d002', 'd1000000-0000-4000-8000-00000000d002', 0, 1, 20, 1, 20,
   'd0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d002/0/keep.mp4', null),
  ('d2000000-0000-4000-8000-00000000d003', 'd1000000-0000-4000-8000-00000000d003', 0, 1, 20, 1, 20,
   'd0000000-0000-4000-8000-00000000d002/d1000000-0000-4000-8000-00000000d003/0/busy.mp4', null);

update public.clips set settings = '{"source_start": 1, "source_end": 20}'::jsonb, settings_hash = repeat('d', 64)
where id = 'd2000000-0000-4000-8000-00000000d001';

-- Export xong: manifest gồm mp4 + srt + txt, cộng một cache section trong `sources`.
insert into public.tasks (id, user_id, kind, clip_id, settings_hash, status, request_id, output_path, output) values
  ('d4000000-0000-4000-8000-00000000d001', 'd0000000-0000-4000-8000-00000000d001', 'render_document',
   'd2000000-0000-4000-8000-00000000d001', repeat('d', 64), 'done',
   'd4900000-0000-4000-8000-00000000d001',
   'd0000000-0000-4000-8000-00000000d001/d2000000-0000-4000-8000-00000000d001/task/att/clip.mp4',
   jsonb_build_object('manifest', jsonb_build_object(
     'files', jsonb_build_object(
       'mp4', jsonb_build_object('bucket','renders','object','d0000000-0000-4000-8000-00000000d001/d2000000-0000-4000-8000-00000000d001/task/att/clip.mp4'),
       'srt', jsonb_build_object('bucket','renders','object','d0000000-0000-4000-8000-00000000d001/d2000000-0000-4000-8000-00000000d001/task/att/clip.srt'),
       'txt', jsonb_build_object('bucket','renders','object','d0000000-0000-4000-8000-00000000d001/d2000000-0000-4000-8000-00000000d001/task/att/clip.txt')),
     'sections', jsonb_build_array(jsonb_build_object('bucket','sources','object','d0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/sections/task-x/att/0-2000.mp4'))))),
  -- ZIP của cùng project.
  ('d4000000-0000-4000-8000-00000000d002', 'd0000000-0000-4000-8000-00000000d001', 'zip',
   null, null, 'done', 'd4900000-0000-4000-8000-00000000d002', null,
   jsonb_build_object('manifest', jsonb_build_object('files', jsonb_build_object(
     'zip', jsonb_build_object('bucket','renders','object','d0000000-0000-4000-8000-00000000d001/zips/project.zip'))))),
  -- Export đang chạy của project thứ ba: retention không được đụng vào.
  ('d4000000-0000-4000-8000-00000000d003', 'd0000000-0000-4000-8000-00000000d002', 'render_document',
   'd2000000-0000-4000-8000-00000000d003', null, 'running', 'd4900000-0000-4000-8000-00000000d003', null, null);

update public.tasks set job_id = 'd1000000-0000-4000-8000-00000000d001'
 where id = 'd4000000-0000-4000-8000-00000000d002';

insert into public.media_assets (id, user_id, job_id, storage_path, name, status) values
  ('d5000000-0000-4000-8000-00000000d001', 'd0000000-0000-4000-8000-00000000d001',
   'd1000000-0000-4000-8000-00000000d001',
   'media/d0000000-0000-4000-8000-00000000d001/d1000000-0000-4000-8000-00000000d001/broll.mp4', 'B-roll', 'ready');

-- ------------------------------------------------------------------ quét
select lives_ok($$select public.expired_object_paths(500)$$, 'quét chạy được');

select is(
  (select count(*) from public.storage_deletions where job_id = 'd1000000-0000-4000-8000-00000000d001'),
  11::bigint,
  'đủ object của project hết hạn trong cả bốn bucket');

select bag_eq(
  $$select bucket, count(*)::int from public.storage_deletions group by bucket$$,
  $$values ('clips'::text, 2), ('renders'::text, 4), ('sources'::text, 4), ('media'::text, 1)$$,
  'không bucket nào bị bỏ sót');

select is((select purging_at is not null from public.jobs where id = 'd1000000-0000-4000-8000-00000000d001'),
  true, 'project hết hạn bị tombstone trước khi xoá file');
select is((select purging_at from public.jobs where id = 'd1000000-0000-4000-8000-00000000d002'),
  null::timestamptz, 'project còn hạn không bị tombstone');
select is((select purging_at from public.jobs where id = 'd1000000-0000-4000-8000-00000000d003'),
  null::timestamptz, 'project còn export đang chạy không bị tombstone');
select is((select count(*) from public.storage_deletions
           where path like '%keep.mp4' or path like '%busy.mp4'), 0::bigint,
  'không xếp hàng object của project chưa được phép xoá');

-- Quét lại không nhân đôi hàng đợi.
select lives_ok($$select public.expired_object_paths(500)$$, 'quét lần hai');
select is((select count(*) from public.storage_deletions), 11::bigint, 'quét lại không nhân đôi hàng đợi');

-- ------------------------------------------------- purge chỉ sau khi xoá hết
select is(public.purge_expired_jobs(null), 0, 'chưa xoá hết file thì chưa xoá hàng');
select is((select count(*) from public.jobs where id = 'd1000000-0000-4000-8000-00000000d001'),
  1::bigint, 'project tombstone vẫn còn hàng trong khi hàng đợi chưa rỗng');

-- Lô xoá hỏng bị đẩy xuống cuối chứ không chặn đầu hàng đợi.
select is(public.defer_object_deletions(array[(select min(id) from public.storage_deletions)]), 1,
  'hoãn được một hàng');
select is((select attempts from public.storage_deletions order by id limit 1), 1, 'đếm số lần thử');
select is((select d.id from public.expired_object_paths(500) d limit 1),
  (select id from public.storage_deletions where attempts = 0 order by id limit 1),
  'hàng đã hoãn không còn đứng đầu hàng đợi');

select is(public.confirm_object_deletions(
  array(select id from public.storage_deletions where job_id = 'd1000000-0000-4000-8000-00000000d001')),
  11, 'xác nhận xoá cả lô');
select is(public.purge_expired_jobs(null), 1, 'hàng đợi rỗng thì xoá hàng project');
select is((select count(*) from public.jobs where id = 'd1000000-0000-4000-8000-00000000d001'),
  0::bigint, 'project đã bị xoá');
select is((select count(*) from public.storage_deletions), 0::bigint,
  'purge không dựng lại đường dẫn đã xoá xong');

-- -------------------------------------- xoá tài khoản: manifest trước cascade
select is((select count(*) from public.storage_deletions), 0::bigint, 'hàng đợi rỗng trước khi xoá tài khoản');
delete from auth.users where id = 'd0000000-0000-4000-8000-00000000d002';
select is((select count(*) from public.storage_deletions where path like '%busy.mp4'), 1::bigint,
  'xoá tài khoản vẫn giữ dấu file của project chưa hết hạn');

-- ------------------------------------------------------ tombstone chặn đọc
insert into public.jobs (id, user_id, source_url, status, expires_at, purging_at) values
  ('d1000000-0000-4000-8000-00000000d004', 'd0000000-0000-4000-8000-00000000d001',
   'https://example.com/tombstoned', 'done', now() + interval '3 days', now());
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('d2000000-0000-4000-8000-00000000d004', 'd1000000-0000-4000-8000-00000000d004', 0, 1, 20, 1, 20);

select throws_ok(
  $$select public.owned_clip('d2000000-0000-4000-8000-00000000d004','d0000000-0000-4000-8000-00000000d001')$$,
  'P0002', 'Clip not found.', 'clip của project đang bị xoá không mở được');
select lives_ok(
  $$select public.owned_clip('d2000000-0000-4000-8000-00000000d002','d0000000-0000-4000-8000-00000000d001')$$,
  'clip của project còn hạn vẫn mở được');

-- ------------------------------------------------------------ rate_limits
insert into public.rate_limits (user_id, bucket, window_start, count) values
  ('d0000000-0000-4000-8000-00000000d001', 'daily_export', now() - interval '3 days', 4),
  ('d0000000-0000-4000-8000-00000000d001', 'daily_preview', now() - interval '1 hour', 2);
select is(public.purge_stale_rate_limits(), 1, 'chỉ xoá cửa sổ quá hai ngày');
select is((select count(*) from public.rate_limits), 1::bigint, 'cửa sổ đang đếm còn nguyên');

-- ---------------------------------------------------------------- quyền
select ok(not has_function_privilege('anon', 'public.expired_object_paths(int)', 'execute'),
  'anon không quét được retention');
select ok(not has_function_privilege('authenticated', 'public.purge_expired_jobs(uuid[])', 'execute'),
  'người dùng không tự xoá hàng loạt được');
select ok(not has_function_privilege('authenticated', 'public.confirm_object_deletions(bigint[])', 'execute'),
  'người dùng không xoá được hàng đợi');
select ok(has_function_privilege('service_role', 'public.expired_object_paths(int)', 'execute'),
  'cron quét được');

select throws_ok($$select public.expired_object_paths(0)$$, '22023', 'Invalid cleanup batch size.',
  'lô ngoài khoảng bị từ chối');

select * from finish();
rollback;
