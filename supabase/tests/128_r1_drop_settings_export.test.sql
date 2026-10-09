-- R1: đường export theo settings đã gỡ; ZIP gói bản xuất từ editor; quota export
-- giờ chỉ còn đường document giữ.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('request_preview', 'request_export', 'save_draft')
  ),
  'không còn RPC nào của đường export theo settings'
);

insert into auth.users (id, email) values
  ('f1280000-0000-4000-8000-00000000000a', 'r1-a@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('f1281000-0000-4000-8000-00000000000a', 'f1280000-0000-4000-8000-00000000000a', 'https://a', 60, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('f1282000-0000-4000-8000-00000000000a', 'f1281000-0000-4000-8000-00000000000a', 0, 0, 20, 0, 20),
  ('f1282000-0000-4000-8000-00000000000b', 'f1281000-0000-4000-8000-00000000000a', 1, 20, 40, 20, 40);

select throws_ok(
  $$ insert into public.tasks (user_id, kind, clip_id, request_id)
     values ('f1280000-0000-4000-8000-00000000000a', 'export', 'f1282000-0000-4000-8000-00000000000a', gen_random_uuid()) $$,
  '23514', null, 'task export không còn hợp lệ'
);
select throws_ok(
  $$ insert into public.tasks (user_id, kind, clip_id, request_id)
     values ('f1280000-0000-4000-8000-00000000000a', 'preview', 'f1282000-0000-4000-8000-00000000000a', gen_random_uuid()) $$,
  '23514', null, 'task preview không còn hợp lệ'
);

-- Clip đầu có hai bản xuất xong: revision 2 xong TRƯỚC revision 1 (worker hoàn
-- tất ngược thứ tự). ZIP phải lấy revision lớn nhất, như trang project.
insert into public.editor_revisions (id, clip_id, number, source_hash, document) values
  ('f1283000-0000-4000-8000-000000000001', 'f1282000-0000-4000-8000-00000000000a', 1, repeat('1', 64), '{}'),
  ('f1283000-0000-4000-8000-000000000002', 'f1282000-0000-4000-8000-00000000000a', 2, repeat('2', 64), '{}'),
  ('f1283000-0000-4000-8000-000000000003', 'f1282000-0000-4000-8000-00000000000b', 1, repeat('3', 64), '{}');
insert into public.tasks (id, user_id, kind, clip_id, editor_revision_id, status, request_id, finished_at) values
  ('f1284000-0000-4000-8000-000000000001', 'f1280000-0000-4000-8000-00000000000a', 'render_document',
   'f1282000-0000-4000-8000-00000000000a', 'f1283000-0000-4000-8000-000000000001', 'done', gen_random_uuid(), now()),
  ('f1284000-0000-4000-8000-000000000002', 'f1280000-0000-4000-8000-00000000000a', 'render_document',
   'f1282000-0000-4000-8000-00000000000a', 'f1283000-0000-4000-8000-000000000002', 'done', gen_random_uuid(), now() - interval '1 hour'),
  -- Clip thứ hai chỉ có bản đang chạy: chưa có gì để gói.
  ('f1284000-0000-4000-8000-000000000003', 'f1280000-0000-4000-8000-00000000000a', 'render_document',
   'f1282000-0000-4000-8000-00000000000b', 'f1283000-0000-4000-8000-000000000003', 'running', gen_random_uuid(), null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1280000-0000-4000-8000-00000000000a"}';

select is(
  (public.request_zip('f1281000-0000-4000-8000-00000000000a',
     array['f1282000-0000-4000-8000-00000000000a', 'f1282000-0000-4000-8000-00000000000b']::uuid[],
     'f1285000-0000-4000-8000-000000000001')).payload -> 'export_task_ids',
  '["f1284000-0000-4000-8000-000000000002"]'::jsonb,
  'ZIP gói bản xuất của revision lớn nhất, bỏ bản chưa xong'
);
select throws_ok(
  $$ select public.request_zip('f1281000-0000-4000-8000-00000000000a',
       array['f1282000-0000-4000-8000-00000000000b']::uuid[], gen_random_uuid()) $$,
  'P0002', 'Export these clips before downloading them together.',
  'clip chưa có bản xuất xong thì không tạo ZIP rỗng'
);

-- Hạn mức export/ngày của gói free (5) chặn đường document.
reset role;
insert into public.rate_limits (user_id, bucket, window_start, count) values
  ('f1280000-0000-4000-8000-00000000000a', 'export',
   to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 5);
insert into public.editor_projects (clip_id, document) values
  ('f1282000-0000-4000-8000-00000000000b', '{"version":1}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1280000-0000-4000-8000-00000000000a"}';
select throws_ok(
  $$ select public.request_document_export(
       'f1282000-0000-4000-8000-00000000000b',
       'f1283000-0000-4000-8000-000000000003',
       gen_random_uuid(), 720) $$,
  'P0001', 'You have reached today''s limit for this plan.',
  'export thứ 6 trong ngày bị quota chặn'
);

select * from finish();
rollback;
