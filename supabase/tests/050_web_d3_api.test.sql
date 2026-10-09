-- RPC của D3: retry_job, request_zip, register_media_asset (bản có probe),
-- account_summary. Cùng luật với 020: chạy dưới vai `authenticated` với JWT giả,
-- vì đó là đường PostgREST đi — chạy dưới postgres sẽ bỏ qua cả RLS lẫn grant.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(26);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-00000000000a', 'a@test.local'),
  ('b0000000-0000-4000-8000-00000000000b', 'b@test.local');

-- Số dư: trigger đăng ký đã cấp quà, nhưng test dựng user bằng insert thẳng nên
-- nạp tay cho chắc.
insert into public.credit_ledger (user_id, delta, reason)
values ('a0000000-0000-4000-8000-00000000000a', 100, 'Test top-up'),
       ('b0000000-0000-4000-8000-00000000000b', 100, 'Test top-up');

insert into public.jobs (id, user_id, source_url, duration_seconds, status, error) values
  ('a1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'https://a', 600, 'failed', 'Processing failed. Please try again.'),
  ('a1100000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'https://a2', 600, 'done', null),
  ('b1000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'https://b', 600, 'failed', null);

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('a2100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-00000000000a', 1, 30, 50, 30, 50),
  ('b2000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

update public.clips set settings = jsonb_build_object('source_start', source_start, 'source_end', source_end),
  settings_hash = repeat('a', 64)
where id in ('a2000000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-00000000000a',
             'b2000000-0000-4000-8000-00000000000b');

-- Bản xuất từ editor (`render_document`) đã xong của từng clip: thứ ZIP gói.
insert into public.editor_revisions (id, clip_id, number, source_hash, document) values
  ('a5000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-00000000000a', 1, repeat('a', 64), '{}'),
  ('a5100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-00000000000a', 1, repeat('c', 64), '{}'),
  ('b5000000-0000-4000-8000-00000000000b', 'b2000000-0000-4000-8000-00000000000b', 1, repeat('b', 64), '{}');
insert into public.tasks (id, user_id, kind, clip_id, editor_revision_id, status, request_id, created_at, finished_at)
values
  ('a4000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'render_document',
   'a2000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-00000000000a',
   'done', 'a4900000-0000-4000-8000-00000000000a', now() - interval '2 hours', now() - interval '2 hours'),
  ('a4100000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'render_document',
   'a2100000-0000-4000-8000-00000000000a', 'a5100000-0000-4000-8000-00000000000a',
   'done', 'a4910000-0000-4000-8000-00000000000a', now() - interval '1 hour', now() - interval '1 hour'),
  ('b4000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'render_document',
   'b2000000-0000-4000-8000-00000000000b', 'b5000000-0000-4000-8000-00000000000b',
   'done', 'b4900000-0000-4000-8000-00000000000b', now(), now());

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';

-- ================================================================ retry_job
select is(
  (public.retry_job('a1000000-0000-4000-8000-00000000000a')).status::text,
  'queued', 'retry_job đưa job hỏng về hàng đợi'
);

select is(
  (select error from public.jobs where id = 'a1000000-0000-4000-8000-00000000000a'),
  null, 'lỗi cũ bị xoá để UI không hiện lại'
);

select is(
  (select attempt_id from public.jobs where id = 'a1000000-0000-4000-8000-00000000000a'),
  null, 'attempt_id về null: worker cũ ghi tiếp sẽ bị fence từ chối'
);

-- `job_credits_spent` chỉ service role gọi được, nên đếm thẳng trên sổ cái —
-- RLS cho người dùng đọc dòng của chính mình.
select is(
  (select coalesce(-sum(delta), 0)::int from public.credit_ledger
   where job_id = 'a1000000-0000-4000-8000-00000000000a'),
  10, 'credit được giữ lại đúng một lần cho lần chạy mới'
);

select throws_ok(
  $$ select public.retry_job('a1100000-0000-4000-8000-00000000000a') $$,
  '22023', 'Only a failed project can be run again.', 'project đã xong thì không chạy lại'
);

select throws_ok(
  $$ select public.retry_job('b1000000-0000-4000-8000-00000000000b') $$,
  'P0002', 'Project not found.', 'A không chạy lại project của B'
);

-- Job vừa retry đã giữ đủ credit; lần retry thứ hai không được giữ thêm.
-- Đổi trạng thái bằng vai postgres: người dùng không có policy update trên jobs
-- (mọi thay đổi đi qua RPC), nên dòng này chạy dưới `authenticated` sẽ không
-- sửa được hàng nào và test sau đó đo nhầm.
reset role;
update public.jobs set status = 'failed' where id = 'a1000000-0000-4000-8000-00000000000a';
set local role authenticated;
select lives_ok(
  $$ select public.retry_job('a1000000-0000-4000-8000-00000000000a') $$,
  'retry lần hai vẫn chạy'
);
select is(
  (select coalesce(-sum(delta), 0)::int from public.credit_ledger
   where job_id = 'a1000000-0000-4000-8000-00000000000a'),
  10, 'và KHÔNG tính tiền lần hai'
);

-- ============================================================== request_zip
select is(
  (public.request_zip('a1100000-0000-4000-8000-00000000000a',
     array['a2000000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-00000000000a']::uuid[],
     'a6000000-0000-4000-8000-00000000000a')).kind,
  'zip', 'request_zip tạo task zip'
);

select is(
  jsonb_array_length(
    (select payload -> 'export_task_ids' from public.tasks where request_id = 'a6000000-0000-4000-8000-00000000000a')
  ),
  2, 'ảnh chụp giữ đúng hai export'
);

-- Khoá `export_task_ids` là hợp đồng với `zip_task.py`; đổi tên nó là làm hỏng
-- worker một cách im lặng (task fail với "This export is no longer available").
select is(
  (select payload -> 'export_task_ids' ->> 0 from public.tasks
   where request_id = 'a6000000-0000-4000-8000-00000000000a'),
  'a4000000-0000-4000-8000-00000000000a',
  'ảnh chụp chốt id export, không để worker tự chọn lại lúc chạy'
);

select is(
  (public.request_zip('a1100000-0000-4000-8000-00000000000a',
     array['a2000000-0000-4000-8000-00000000000a']::uuid[],
     'a6000000-0000-4000-8000-00000000000a')).request_id,
  'a6000000-0000-4000-8000-00000000000a'::uuid,
  'cùng request_id trả đúng task cũ, không tạo task thứ hai'
);

select is(
  (select count(*)::int from public.tasks where kind = 'zip'),
  1, 'và bảng chỉ có đúng một task zip'
);

-- Clip của B nằm ngoài project này: bị loại khỏi ảnh chụp, không phải "gói kèm".
select throws_ok(
  $$ select public.request_zip('a1100000-0000-4000-8000-00000000000a',
       array['b2000000-0000-4000-8000-00000000000b']::uuid[], gen_random_uuid()) $$,
  'P0002', 'Export these clips before downloading them together.',
  'clip của người khác không vào được ZIP'
);

select throws_ok(
  $$ select public.request_zip('b1000000-0000-4000-8000-00000000000b',
       array['b2000000-0000-4000-8000-00000000000b']::uuid[], gen_random_uuid()) $$,
  'P0002', 'Project not found.', 'A không gói ZIP từ project của B'
);

select throws_ok(
  $$ select public.request_zip('a1100000-0000-4000-8000-00000000000a', array[]::uuid[], gen_random_uuid()) $$,
  '22023', 'Choose at least one clip.', 'danh sách rỗng bị từ chối'
);

-- =================================================== register_media_asset v2
reset role;
insert into public.upload_reservations(user_id,bucket,object_name,declared_size,content_type,project_id)
values('a0000000-0000-4000-8000-00000000000a','media',
 'a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',100,'video/mp4','a1100000-0000-4000-8000-00000000000a');
insert into storage.objects(bucket_id,name,metadata) values('media',
 'a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4','{"size":100,"mimetype":"video/mp4"}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000000a"}';
select is(
  public.register_media_asset('a1100000-0000-4000-8000-00000000000a',
    'media/a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',
    'broll.mp4', 'a7000000-0000-4000-8000-00000000000a') -> 'asset' ->> 'status',
  'pending', 'asset mới ở pending'
);

select is(
  (select count(*)::int from public.tasks
   where kind = 'probe_media' and job_id = 'a1100000-0000-4000-8000-00000000000a'),
  1, 'và task probe được tạo TRONG CÙNG giao dịch'
);

-- Gọi lại cùng đường dẫn (mạng gửi lại) không được xếp hàng probe lần hai.
select is(
  public.register_media_asset('a1100000-0000-4000-8000-00000000000a',
    'media/a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',
    'broll.mp4', gen_random_uuid()) -> 'asset' ->> 'storage_path',
  'media/a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c1.mp4',
  'replay trả đúng asset cũ'
);

select is(
  (select count(*)::int from public.tasks
   where kind = 'probe_media' and job_id = 'a1100000-0000-4000-8000-00000000000a'),
  1, 'replay không xếp hàng probe lần hai'
);

select throws_ok(
  $$ select public.register_media_asset('a1100000-0000-4000-8000-00000000000a',
       'media/a0000000-0000-4000-8000-00000000000a/a1100000-0000-4000-8000-00000000000a/c0000000-0000-4000-8000-0000000000c2.mp4',
       'x.mp4', null) $$,
  '22023', 'Missing request id.', 'thiếu request id thì từ chối'
);

-- ================================================================ create_job
select is(
  (public.create_clip_job('https://youtu.be/x', 3, 'short', p_ownership_confirmed => true)).clip_length,
  'short', 'create_job giữ lựa chọn độ dài clip'
);

select is(
  (public.create_clip_job('https://youtu.be/y', 3, p_ownership_confirmed => true)).clip_length,
  'auto', 'không chọn thì mặc định auto'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/z', 3, 'tuỳ-tiện', p_ownership_confirmed => true) $$,
  '22023', 'Choose a clip length.', 'giá trị lạ bị từ chối'
);

-- ========================================================= account_summary
select is(
  public.account_summary() ->> 'email', 'a@test.local', 'account_summary trả email của chính mình'
);

select is(
  (public.account_summary() ->> 'plan'), 'free', 'gói mặc định là free'
);

select * from finish();
rollback;
