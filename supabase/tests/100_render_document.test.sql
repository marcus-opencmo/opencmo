-- Export trên server: request -> task `render_document` xếp hàng ngay, đếm chung
-- quota và trần với export phía trình duyệt, chụp manifest, dọn object theo job.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select ok(
  has_function_privilege('authenticated', 'public.request_document_export(uuid,uuid,uuid,int)', 'execute'),
  'người dùng đăng nhập gọi được request_document_export'
);
select ok(
  not has_function_privilege('anon', 'public.request_document_export(uuid,uuid,uuid,int)', 'execute'),
  'anon không gọi được'
);

insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-00000000000a', 'render-doc-a@test.local'),
  ('f2000000-0000-4000-8000-00000000000b', 'render-doc-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status, watermark) values
  ('f2100000-0000-4000-8000-00000000000a', 'f2000000-0000-4000-8000-00000000000a', 'https://a', 60, 'done', true),
  ('f2100000-0000-4000-8000-00000000000b', 'f2000000-0000-4000-8000-00000000000b', 'https://b', 60, 'done', false);

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('f2200000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-00000000000a', 0, 0, 20, 0, 20),
  ('f2200000-0000-4000-8000-00000000000c', 'f2100000-0000-4000-8000-00000000000a', 1, 20, 40, 20, 40),
  ('f2200000-0000-4000-8000-00000000000b', 'f2100000-0000-4000-8000-00000000000b', 0, 0, 20, 0, 20);

insert into public.editor_projects(clip_id, document, manifest) values
  ('f2200000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"source-a"}}',
   '{"version":1,"folders":[],"assets":[{"id":"x","path":"broll.mp4","source":"assets/broll.mp4","type":"video","mimeType":"video/mp4","cloud":{"state":"synced","mediaId":"m1"}}]}'),
  ('f2200000-0000-4000-8000-00000000000b', '{"version":1,"stage":{"name":"source-b"}}', default);
insert into public.editor_revisions(id, clip_id, number, document, source_hash) values
  ('f2300000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-00000000000a', 1, '{"version":1,"stage":{"name":"source-a"}}', encode(sha256(convert_to('source-a', 'UTF8')), 'hex')),
  ('f2300000-0000-4000-8000-00000000000b', 'f2200000-0000-4000-8000-00000000000b', 1, '{"version":1,"stage":{"name":"source-b"}}', encode(sha256(convert_to('source-b', 'UTF8')), 'hex')),
  ('f2300000-0000-4000-8000-00000000000c', 'f2200000-0000-4000-8000-00000000000a', 2, '{"version":1,"stage":{"name":"source-a2"}}', encode(sha256(convert_to('source-a2', 'UTF8')), 'hex'));

create temporary table render_doc_result(id uuid, object_name text);
grant select, insert, delete on render_doc_result to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-00000000000a"}';

insert into render_doc_result
select t.id, t.payload->>'object'
from public.request_document_export(
  'f2200000-0000-4000-8000-00000000000a',
  'f2300000-0000-4000-8000-00000000000a',
  'f2400000-0000-4000-8000-00000000000a',
  720) t;

select is(
  (select kind || ':' || status from public.tasks where id = (select id from render_doc_result)),
  'render_document:queued',
  'request xếp hàng cho worker ngay, không chờ upload'
);
select is(
  (select object_name from render_doc_result),
  'f2000000-0000-4000-8000-00000000000a/f2200000-0000-4000-8000-00000000000a/' ||
    (select id::text from render_doc_result) || '.mp4',
  'object canonical trong exports: uid/clip/task'
);
select is(
  (select payload->'resolution' from public.tasks where id = (select id from render_doc_result)),
  '720'::jsonb,
  'payload giữ độ phân giải đã chọn'
);
select is(
  (select payload->'manifest'->'assets'->0->'cloud'->>'mediaId' from public.tasks where id = (select id from render_doc_result)),
  'm1',
  'payload chụp manifest thư viện lúc bấm Export'
);
select is(
  (select editor_revision_id from public.tasks where id = (select id from render_doc_result)),
  'f2300000-0000-4000-8000-00000000000a'::uuid,
  'task trỏ tới revision bất biến'
);

select is(
  (public.request_document_export(
    'f2200000-0000-4000-8000-00000000000a',
    'f2300000-0000-4000-8000-00000000000a',
    'f2400000-0000-4000-8000-00000000000a',
    720)).id,
  (select id from render_doc_result),
  'cùng request id trả lại task cũ'
);
reset role;
select is(
  (select count from public.rate_limits
   where user_id = 'f2000000-0000-4000-8000-00000000000a' and bucket = 'export'),
  1,
  'retry chỉ tiêu một lượt quota export'
);

-- Sửa thư viện sau khi bấm không đổi thứ đang xuất.
update public.editor_projects set manifest = '{"version":1,"folders":[],"assets":[]}'
where clip_id = 'f2200000-0000-4000-8000-00000000000a';
select is(
  (select payload->'manifest'->'assets'->0->>'source' from public.tasks where id = (select id from render_doc_result)),
  'assets/broll.mp4',
  'manifest trong payload không theo bản sửa sau'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-00000000000a"}';

select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000a',
    'f2300000-0000-4000-8000-00000000000a',
    'f2400000-0000-4000-8000-00000000000d',
    480) $$,
  '22023', 'Choose 720p or 1080p.',
  'chỉ nhận 720p hoặc 1080p'
);
select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000c',
    'f2300000-0000-4000-8000-00000000000a',
    'f2400000-0000-4000-8000-00000000000e') $$,
  'P0002', 'Save the project before exporting it.',
  'revision phải thuộc đúng clip'
);
select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000b',
    'f2300000-0000-4000-8000-00000000000b',
    'f2400000-0000-4000-8000-00000000000b') $$,
  'P0002', 'Clip not found.',
  'không export được clip của người khác'
);
select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000a',
    'f2300000-0000-4000-8000-00000000000c',
    'f2400000-0000-4000-8000-00000000000a') $$,
  '22023', 'This export request was already used for another clip or revision.',
  'request id đã dùng không mở được export khác'
);

-- Request id đã thuộc về một task KHÁC loại thì không đổi kind được.
reset role;
insert into public.tasks(id, user_id, kind, clip_id, job_id, status, request_id, payload)
values ('f2500000-0000-4000-8000-00000000000f', 'f2000000-0000-4000-8000-00000000000a', 'zip',
        'f2200000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-00000000000a', 'cancelled',
        'f2400000-0000-4000-8000-00000000000f', '{}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-00000000000a"}';
select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000a',
    'f2300000-0000-4000-8000-00000000000a',
    'f2400000-0000-4000-8000-00000000000f') $$,
  '22023', 'This export request was already used for another clip or revision.',
  'request id của task khác loại không dùng lại cho render_document'
);

-- Trần 20 việc đang chạy đếm cả render_document.
reset role;
insert into public.tasks(user_id, kind, clip_id, job_id, status, payload, request_id)
select 'f2000000-0000-4000-8000-00000000000a', 'render_document',
       'f2200000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-00000000000a',
       'queued', '{"filler":true}'::jsonb, gen_random_uuid()
from generate_series(1, 19);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-00000000000a"}';
select throws_ok(
  $$ select public.request_document_export(
    'f2200000-0000-4000-8000-00000000000a',
    'f2300000-0000-4000-8000-00000000000a',
    'f2400000-0000-4000-8000-000000000010') $$,
  'P0001', 'You already have 20 previews or exports in progress. Please wait for one to finish.',
  'trần 20 việc đếm cả export trên server'
);
reset role;
delete from public.tasks
where user_id = 'f2000000-0000-4000-8000-00000000000a' and payload ? 'filler';

-- Retention: object export được dọn theo job và khi xoá task.
select ok(
  public.enqueue_job_objects('f2100000-0000-4000-8000-00000000000a') > 0,
  'enqueue_job_objects chạy'
);
select ok(
  exists(select 1 from public.storage_deletions
         where bucket = 'exports' and path = (select object_name from render_doc_result)),
  'object của render_document vào hàng dọn theo job'
);
delete from public.storage_deletions where bucket = 'exports';
delete from public.tasks where id = (select id from render_doc_result);
select ok(
  exists(select 1 from public.storage_deletions
         where bucket = 'exports' and path = (select object_name from render_doc_result)),
  'xoá task render_document ghi object vào hàng dọn'
);

select * from finish();
rollback;
