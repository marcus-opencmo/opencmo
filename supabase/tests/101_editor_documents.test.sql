-- B1 + C3: document JSON là thứ duy nhất project editor lưu. Không còn cột TSX,
-- document bắt buộc, vân tay (`document_hash`) do SQL tính.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select ok(
  not exists (select 1 from pg_proc where proname = 'save_editor_project'),
  'không còn đường ghi chỉ-source'
);
select ok(
  has_function_privilege('authenticated', 'public.save_editor_document(uuid,int,jsonb,jsonb)', 'execute'),
  'người dùng gọi được save_editor_document'
);
select ok(
  not has_function_privilege('anon', 'public.save_editor_document(uuid,int,jsonb,jsonb)', 'execute'),
  'anon thì không'
);
select hasnt_column('public', 'editor_projects', 'source', 'editor_projects không còn cột TSX');
select hasnt_column('public', 'editor_projects', 'generated_source', 'không còn TSX gốc');
select hasnt_column('public', 'editor_revisions', 'source', 'editor_revisions không còn cột TSX');
select col_not_null('public', 'editor_projects', 'document', 'document bắt buộc');
select col_not_null('public', 'editor_revisions', 'document', 'revision luôn có document');
select ok(
  not exists (select 1 from pg_proc where proname = 'freeze_editor_revision'),
  'ngoại lệ backfill của trigger đã gỡ'
);

insert into auth.users (id, email) values
  ('fa000000-0000-4000-8000-00000000000a', 'doc-a@test.local'),
  ('fa000000-0000-4000-8000-00000000000b', 'doc-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('fa100000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-00000000000a', 'https://a', 60, 'done'),
  ('fa100000-0000-4000-8000-00000000000b', 'fa000000-0000-4000-8000-00000000000b', 'https://b', 60, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('fa200000-0000-4000-8000-00000000000a', 'fa100000-0000-4000-8000-00000000000a', 0, 0, 20, 0, 20),
  ('fa200000-0000-4000-8000-00000000000c', 'fa100000-0000-4000-8000-00000000000a', 1, 20, 40, 20, 40),
  ('fa200000-0000-4000-8000-00000000000b', 'fa100000-0000-4000-8000-00000000000b', 0, 0, 20, 0, 20);

set local role authenticated;
set local request.jwt.claims = '{"sub":"fa000000-0000-4000-8000-00000000000a"}';

create temporary table doc(name text primary key, body jsonb);
insert into doc values
  ('one', '{"version":1,"stage":{"children":[{"kind":"scene","width":1080,"height":1920}]}}'),
  ('two', '{"version":1,"stage":{"children":[{"kind":"scene","width":1080,"height":1080}]}}');

-- ============================================================ tạo
select is(
  (public.get_or_create_editor_project('fa200000-0000-4000-8000-00000000000a',
     (select body from doc where name = 'one'))->'document'->'stage'->'children'->0->>'height'),
  '1920', 'project mới mang document'
);
select is(
  (select generated_document from public.editor_projects where clip_id = 'fa200000-0000-4000-8000-00000000000a'),
  (select body from doc where name = 'one'), 'document gốc được giữ cho Reset'
);
select throws_ok(
  $$ select public.get_or_create_editor_project('fa200000-0000-4000-8000-00000000000a', '{"stage":{}}'::jsonb) $$,
  '22023', 'This project could not be read.', 'document không có version bị chặn'
);
select throws_ok(
  $$ select public.get_or_create_editor_project('fa200000-0000-4000-8000-00000000000a', null) $$,
  '22023', 'This project could not be read.', 'document là bắt buộc'
);

-- ============================================================ lưu
select is(
  (public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 1,
     (select body from doc where name = 'two'))->>'version'),
  '2', 'lưu document tăng version'
);
select is(
  (select document->'stage'->'children'->0->>'height'
   from public.editor_projects where clip_id = 'fa200000-0000-4000-8000-00000000000a'),
  '1080', 'document đã lưu'
);
select is(
  (public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 2,
     (select body from doc where name = 'two'), '{"version":1,"folders":[],"assets":[]}'::jsonb)->>'document_hash'),
  public.editor_document_hash((select body from doc where name = 'two')),
  'kết quả lưu mang vân tay của document'
);
select is(
  (public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 2,
     (select body from doc where name = 'two'))->>'version'),
  '2', 'lưu lại y nguyên không tăng version'
);
select throws_ok(
  $$ select public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 1,
       (select body from doc where name = 'one')) $$,
  'P0409', 'This clip was changed in another tab.', 'version cũ bị từ chối'
);
select throws_ok(
  $$ select public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 2,
       '{"version":1.5,"stage":{}}'::jsonb) $$,
  '22023', 'This project could not be read.', 'version không nguyên bị chặn'
);
select throws_ok(
  $$ select public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 2, '[]'::jsonb) $$,
  '22023', 'This project could not be read.', 'document phải là object'
);
select throws_ok(
  format($$ select public.save_editor_document('fa200000-0000-4000-8000-00000000000a', 2, %L::jsonb) $$,
         jsonb_build_object('version', 1, 'stage', jsonb_build_object('name', repeat('x', 262144)))::text),
  '22023', 'This project could not be read.', 'document quá cỡ bị chặn'
);
select throws_ok(
  $$ select public.save_editor_document('fa200000-0000-4000-8000-00000000000b', 1,
       (select body from doc where name = 'one')) $$,
  'P0002', 'Clip not found.', 'không ghi được vào project của người khác'
);

-- ============================================================ revision
select is(
  (public.checkpoint_editor_project('fa200000-0000-4000-8000-00000000000a', 'manual', 'Before test')).document,
  (select body from doc where name = 'two'), 'checkpoint chụp document'
);
select is(
  (public.snapshot_editor_revision('fa200000-0000-4000-8000-00000000000a',
     public.editor_document_hash((select body from doc where name = 'two')))).document,
  (select body from doc where name = 'two'), 'revision export chụp document'
);

-- ============================================================ reset
select is(
  (public.reset_editor_project('fa200000-0000-4000-8000-00000000000a', 2)->'document'),
  (select body from doc where name = 'one'), 'reset về document gốc'
);

select * from finish();
rollback;
