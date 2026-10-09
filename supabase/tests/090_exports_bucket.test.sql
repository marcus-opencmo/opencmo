-- Bucket exports: từ A4b chỉ worker ghi (service role); trình duyệt chỉ đọc
-- thư mục của mình, và retention vẫn nhặt được object của task cũ.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-00000000000a', 'export-a@test.local'),
  ('f0000000-0000-4000-8000-00000000000b', 'export-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('f0100000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'https://a', 60, 'done'),
  ('f0100000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-00000000000b', 'https://b', 60, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('f0200000-0000-4000-8000-00000000000a', 'f0100000-0000-4000-8000-00000000000a', 0, 0, 20, 0, 20),
  ('f0200000-0000-4000-8000-00000000000b', 'f0100000-0000-4000-8000-00000000000b', 0, 0, 20, 0, 20);

select is(
  (select public from storage.buckets where id = 'exports'),
  false,
  'exports là bucket private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'exports'),
  2147483648::bigint,
  'exports cho phép file tới 2 GiB'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';

select lives_ok(
  $$ select public.reserve_upload(
    'exports',
    'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/f0300000-0000-4000-8000-00000000000a.mp4',
    100, 'video/mp4', 'f0100000-0000-4000-8000-00000000000a') $$,
  'chủ clip reserve được path export ba segment'
);

select throws_ok(
  $$ select public.reserve_upload(
    'exports',
    'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000b/f0300000-0000-4000-8000-00000000000b.mp4',
    100, 'video/mp4', 'f0100000-0000-4000-8000-00000000000b') $$,
  'P0002', 'Clip not found.',
  'không reserve được export cho clip của người khác'
);

select throws_ok(
  $$ insert into storage.objects(bucket_id, name, metadata) values (
    'exports',
    'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/f0300000-0000-4000-8000-00000000000a.mp4',
    '{"size":100,"mimetype":"video/mp4"}') $$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'có reservation cũng không upload được vào exports (A4b: chỉ worker ghi)'
);

select throws_ok(
  $$ insert into storage.objects(bucket_id, name, metadata) values (
    'exports',
    'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/unreserved.mp4',
    '{"size":100,"mimetype":"video/mp4"}') $$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'object export không reservation bị chặn'
);

reset role;

-- Worker (service role) ghi bản xuất của hai user; RLS chỉ cho mỗi người thấy của mình.
insert into storage.objects(bucket_id, name, metadata) values
  ('exports',
   'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/f0300000-0000-4000-8000-00000000000a.mp4',
   '{"size":100,"mimetype":"video/mp4"}'),
  ('exports',
   'f0000000-0000-4000-8000-00000000000b/f0200000-0000-4000-8000-00000000000b/f0300000-0000-4000-8000-00000000000b.mp4',
   '{"size":100,"mimetype":"video/mp4"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000000a"}';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'exports'),
  1,
  'chỉ đọc được export trong thư mục uid của mình'
);
reset role;

-- Retention nhặt object bản xuất từ payload task (đích do RPC đặt).
insert into public.tasks(
  id, user_id, kind, clip_id, job_id, status, request_id, payload
) values (
  'f0300000-0000-4000-8000-00000000000a',
  'f0000000-0000-4000-8000-00000000000a',
  'render_document',
  'f0200000-0000-4000-8000-00000000000a',
  'f0100000-0000-4000-8000-00000000000a',
  'failed',
  'f0400000-0000-4000-8000-00000000000a',
  '{"bucket":"exports","object":"f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/f0300000-0000-4000-8000-00000000000a.mp4"}'
);

select lives_ok(
  $$ select public.enqueue_job_objects('f0100000-0000-4000-8000-00000000000a') $$,
  'retention chấp nhận bucket exports'
);
select is(
  (select count(*)::int from public.storage_deletions
   where bucket = 'exports'
     and path = 'f0000000-0000-4000-8000-00000000000a/f0200000-0000-4000-8000-00000000000a/f0300000-0000-4000-8000-00000000000a.mp4'),
  1,
  'retention nhặt object export từ payload task'
);

select * from finish();
rollback;
