-- Xuất bản job nguyên tử (D2) và chặn client xoá object đang được trỏ tới.
--
-- Hai ca quan trọng nhất: attempt cũ về muộn KHÔNG được ghi gì, và retry sau
-- khi mất response trả true mà không nhân đôi clip/revision/draft.
create extension if not exists pgtap with schema extensions;
begin;
set search_path to public, extensions;
select plan(42);

-- --------------------------------------------------------------- fixture
insert into auth.users(id, email) values
  ('c0000000-0000-4000-8000-000000000001', 'publication@test.local');

insert into public.jobs(id, user_id, source_url, status, attempt_id) values
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'storage://c0000000-0000-4000-8000-000000000001/ref.mp4', 'running', 'c9000000-0000-4000-8000-000000000001'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
   'https://youtu.be/queued', 'queued', 'c9000000-0000-4000-8000-000000000002'),
  ('c1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001',
   'https://youtu.be/cancelled', 'cancelled', 'c9000000-0000-4000-8000-000000000003'),
  ('c1000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001',
   'https://youtu.be/failed', 'failed', 'c9000000-0000-4000-8000-000000000004'),
  ('c1000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001',
   'https://youtu.be/running', 'running', 'c9000000-0000-4000-8000-000000000005');

-- Job 5 đã có clip idx 0 từ lần chạy trước với id khác.
insert into public.clips(id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('c2000000-0000-4000-8000-000000000099', 'c1000000-0000-4000-8000-000000000005', 0, 1, 20, 1, 20);

create temp table fixture as select
  jsonb_build_array(
    jsonb_build_object('id', 'c2000000-0000-4000-8000-000000000001', 'idx', 0, 'hook', 'Hook one',
      'start_seconds', 1.5, 'end_seconds', 20, 'score', 9, 'reason', 'Strong',
      'storage_path', 'u/j/a/00.mp4', 'preview_path', 'u/j/a/00.preview.mp4'),
    jsonb_build_object('id', 'c2000000-0000-4000-8000-000000000002', 'idx', 1, 'hook', 'Hook two',
      'start_seconds', 30, 'end_seconds', 50, 'score', 8, 'reason', 'Good',
      'storage_path', 'u/j/a/01.mp4', 'preview_path', 'u/j/a/01.preview.mp4')
  ) clips,
  jsonb_build_array(
    jsonb_build_object('clip_id', 'c2000000-0000-4000-8000-000000000001',
      'settings', jsonb_build_object('source_start', 1.5, 'source_end', 20), 'settings_hash', repeat('a', 64)),
    jsonb_build_object('clip_id', 'c2000000-0000-4000-8000-000000000002',
      'settings', jsonb_build_object('source_start', 30, 'source_end', 50), 'settings_hash', repeat('b', 64))
  ) revisions,
  jsonb_build_object('attempt_id', 'c9000000-0000-4000-8000-000000000001', 'sections', '[]'::jsonb,
    'proxies', '{}'::jsonb) manifest;

select ok(to_regprocedure('public.complete_job_publication(uuid,uuid,text,numeric,jsonb,jsonb,jsonb)') is not null,
  'có RPC complete_job_publication');

select throws_ok($q$insert into public.jobs(user_id, source_url) values
  ('c0000000-0000-4000-8000-000000000001',
   'storage://c0000000-0000-4000-8000-000000000001/../victim/video.mp4')$q$,
  '23514', null, 'DB chặn traversal trong source upload');
select throws_ok($q$insert into public.jobs(user_id, source_url) values
  ('c0000000-0000-4000-8000-000000000001',
   'storage://c0000000-0000-4000-8000-000000000099/video.mp4')$q$,
  '23514', null, 'DB chặn source upload của user khác');
select throws_ok($q$insert into public.jobs(user_id, source_url) values
  ('c0000000-0000-4000-8000-000000000001', 'file:///etc/passwd')$q$,
  '23514', null, 'DB chỉ nhận HTTP(S) hoặc upload canonical');

-- ================================================================ fence
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-00000000dead',
  'Title', 600, (select clips from fixture), (select revisions from fixture), (select manifest from fixture)),
  false, 'attempt lạ khi job đang running → false');
select is((select count(*) from public.clips where job_id = 'c1000000-0000-4000-8000-000000000001')::int, 0,
  'attempt lạ không chèn clip');
select is((select status::text from public.jobs where id = 'c1000000-0000-4000-8000-000000000001'), 'running',
  'attempt lạ không đổi trạng thái');

select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000002',
  'T', 1, '[]', '[]', '{}'), false, 'job queued → false');
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000003',
  'T', 1, '[]', '[]', '{}'), false, 'job cancelled → false');
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-000000000004',
  'T', 1, '[]', '[]', '{}'), false, 'job failed → false');
select is((select count(*) from public.jobs where id in ('c1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000004') and media_manifest is not null)::int, 0,
  'job không running không nhận manifest');

-- ============================================================ validation
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, (select clips from fixture),
  jsonb_build_array(jsonb_build_object('clip_id', 'c2000000-0000-4000-8000-0000000000ff',
    'settings', '{}'::jsonb, 'settings_hash', repeat('c', 64))),
  (select manifest from fixture))$q$,
  '22023', 'A revision points to a clip that is not being published.', 'revision trỏ clip ngoài p_clips bị chặn');
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, '{}', '[]', '{}')$q$,
  '22023', 'Clips must be a list.', 'p_clips không phải mảng bị chặn');
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, '[]', '[]', '[]')$q$,
  '22023', 'The media manifest must be an object.', 'p_manifest không phải object bị chặn');
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, (select clips from fixture),
  jsonb_build_array(jsonb_build_object('clip_id', 'c2000000-0000-4000-8000-000000000001',
    'settings', '{}'::jsonb, 'settings_hash', 'nope')),
  (select manifest from fixture))$q$,
  '22023', 'Clip settings are invalid.', 'settings_hash sai hình dạng bị chặn');
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000005', 'c9000000-0000-4000-8000-000000000005',
  'Title', 600, jsonb_build_array(jsonb_build_object('id', 'c2000000-0000-4000-8000-000000000005', 'idx', 0,
    'start_seconds', 1, 'end_seconds', 20)), '[]', '{}')$q$,
  '22023', 'A different clip already exists at this position.', 'idx trùng clip id khác bị chặn, không thay thế');
select throws_ok($q$select public.complete_job_publication('c1000000-0000-4000-8000-000000000005', 'c9000000-0000-4000-8000-000000000005',
  'Title', 600, jsonb_build_array(jsonb_build_object('id', 'c2000000-0000-4000-8000-000000000006', 'idx', 1,
    'start_seconds', 20, 'end_seconds', 20)), '[]', '{}')$q$,
  '22023', 'A clip must end after it starts.', 'clip end <= start bị chặn');
select is((select count(*) from public.clips where job_id = 'c1000000-0000-4000-8000-000000000001')::int, 0,
  'lỗi validation không để lại clip');

-- ============================================================= xuất bản
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, (select clips from fixture), (select revisions from fixture), (select manifest from fixture)),
  true, 'attempt hiện hành xuất bản');
select set_eq($$select id from public.clips where job_id = 'c1000000-0000-4000-8000-000000000001'$$,
  $$values ('c2000000-0000-4000-8000-000000000001'::uuid), ('c2000000-0000-4000-8000-000000000002'::uuid)$$,
  'clip giữ đúng id worker sinh');
select is((select source_start || '-' || source_end from public.clips where id = 'c2000000-0000-4000-8000-000000000001'),
  '1.5-20', 'source_start/source_end lấy từ start/end');
select is((select hook from public.clips where id = 'c2000000-0000-4000-8000-000000000002'), 'Hook two', 'clip giữ hook');
select is((select count(*) from public.clips
  where job_id = 'c1000000-0000-4000-8000-000000000001' and settings is not null)::int, 2, 'mỗi clip có settings gốc');
select is((select count(*) from public.clips c
  join jsonb_array_elements((select revisions from fixture)) r on (r ->> 'clip_id')::uuid = c.id
  where c.settings = r -> 'settings' and c.settings_hash = r ->> 'settings_hash')::int, 2,
  'settings + hash đúng bản worker gửi');
select ok((select status = 'done' and finished_at is not null and lease_until is null
  and title = 'Title' and duration_seconds = 600
  from public.jobs where id = 'c1000000-0000-4000-8000-000000000001'), 'job done cùng title, duration, finished_at');
select is((select media_manifest from public.jobs where id = 'c1000000-0000-4000-8000-000000000001'),
  (select manifest from fixture), 'manifest được lưu');
select is((select revisions from public.worker_draft_initializations
  where job_id = 'c1000000-0000-4000-8000-000000000001' and attempt_id = 'c9000000-0000-4000-8000-000000000001'),
  (select revisions from fixture), 'ghi biên nhận khởi tạo draft');

-- ================================================================ replay
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
  'Title', 600, (select clips from fixture), (select revisions from fixture), (select manifest from fixture)),
  true, 'replay cùng attempt → true');
select ok((select count(*) from public.clips where job_id = 'c1000000-0000-4000-8000-000000000001') = 2
  and (select count(*) from public.clips where job_id = 'c1000000-0000-4000-8000-000000000001'
    and settings is not null) = 2, 'replay không nhân đôi clip, settings giữ nguyên');
select is(public.complete_job_publication('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-00000000dead',
  'Other', 1, '[]', '[]', '{}'), false, 'attempt cũ gọi sau khi job done → false');
select is((select title from public.jobs where id = 'c1000000-0000-4000-8000-000000000001'), 'Title',
  'attempt cũ không đổi job đã done');

-- ================================================================= quyền
-- Kiểm quyền qua catalog, không gọi hàm thật: pgTAP trên Postgres 17 của
-- Supabase segfault backend khi bắt lỗi permission denied của HÀM (xem 035).
select is(has_function_privilege('anon', 'public.complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb)', 'execute'),
  false, 'anon không xuất bản job');
select is(has_function_privilege('authenticated', 'public.complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb)', 'execute'),
  false, 'authenticated không xuất bản job');
select is(has_function_privilege('service_role', 'public.complete_job_publication(uuid, uuid, text, numeric, jsonb, jsonb, jsonb)', 'execute'),
  true, 'service_role xuất bản job');

-- ============================================================== storage
insert into public.media_assets(user_id, job_id, storage_path, name) values
  ('c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   'media/c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/ref.mp4', 'ref.mp4');

insert into storage.objects(bucket_id, name) values
  ('sources', 'c0000000-0000-4000-8000-000000000001/ref.mp4'),
  ('sources', 'c0000000-0000-4000-8000-000000000001/free.mp4'),
  ('sources', 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/proxy/worker.mp4'),
  ('media', 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/ref.mp4'),
  ('media', 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/free.mp4');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-4000-8000-000000000001"}';
-- Trigger `storage.protect_delete` chặn DELETE SQL trực tiếp; bật cờ để đo
-- đúng tác dụng của policy chứ không phải của trigger.
set local storage.allow_delete_query = 'true';
-- Client chỉ ghi được đúng `<uid>/<file>`; key sâu hơn là của worker.
select throws_ok($q$insert into storage.objects(bucket_id, name) values
  ('sources', 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/proxy/x.mp4')$q$,
  '42501', 'new row violates row-level security policy for table "objects"', 'client không cài được file vào thư mục proxy');
select throws_ok($q$insert into storage.objects(bucket_id, name) values
  ('sources', 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/sections/a/0-1000.mp4')$q$,
  '42501', 'new row violates row-level security policy for table "objects"', 'client không cài được file vào thư mục sections');
select throws_ok($q$insert into storage.objects(bucket_id, name) values
  ('sources', 'c0000000-0000-4000-8000-000000000001/upload__x.mp4')$q$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'client không upload nguồn nếu chưa có reservation');
delete from storage.objects where bucket_id in ('sources', 'media');
set local role postgres;

select ok(exists(select 1 from storage.objects where bucket_id = 'sources'
  and name = 'c0000000-0000-4000-8000-000000000001/ref.mp4'), 'nguồn đang được job trỏ tới không xoá được');
select ok(exists(select 1 from storage.objects where bucket_id = 'media'
  and name = 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/ref.mp4'),
  'B-roll đang được trỏ tới không xoá được');
select ok(not exists(select 1 from storage.objects where bucket_id = 'sources'
  and name = 'c0000000-0000-4000-8000-000000000001/free.mp4'), 'nguồn không ai trỏ tới vẫn xoá được');
select ok(not exists(select 1 from storage.objects where bucket_id = 'media'
  and name = 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/free.mp4'),
  'B-roll không ai trỏ tới vẫn xoá được');
select ok(exists(select 1 from storage.objects where bucket_id = 'sources'
  and name = 'c0000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000001/proxy/worker.mp4'),
  'client không xoá được file lồng của worker');

select * from finish();
rollback;
