-- Đợt 3d-2 (20261017090000): revision export từ bản sao document (khung theo nền tảng),
-- skill riêng của người dùng.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select ok(not has_function_privilege('anon', 'public.snapshot_editor_variant(uuid,text,jsonb,text)', 'execute'), 'anon không chụp được');
select ok(has_function_privilege('authenticated', 'public.save_editor_skill(text,text,text)', 'execute'), 'người dùng lưu skill được');

insert into auth.users (id, email) values
  ('e1150000-0000-4000-8000-00000000000a', 'v3d-a@test.local'),
  ('e1150000-0000-4000-8000-00000000000b', 'v3d-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status, watermark) values
  ('e1151000-0000-4000-8000-00000000000a', 'e1150000-0000-4000-8000-00000000000a', 'https://a', 60, 'done', false);
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1152000-0000-4000-8000-00000000000a', 'e1151000-0000-4000-8000-00000000000a', 0, 0, 20, 0, 20);
insert into public.editor_projects(clip_id, document) values
  ('e1152000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"tall"}}');

create temp table h as select public.editor_document_hash(document) as hash from public.editor_projects;
grant select on h to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1150000-0000-4000-8000-00000000000a"}';

-- ------------------------------------------------------------ variant
create temp table v as select * from public.snapshot_editor_variant(
  'e1152000-0000-4000-8000-00000000000a', (select hash from h), '{"version":1,"stage":{"name":"square"}}', '1:1');
select is((select document->'stage'->>'name' from v), 'square', 'revision mang bản sao');
select is((select kind from v), 'export', 'là revision export');
select is((select label from v), '1:1', 'nhãn khung');
select is((select document->'stage'->>'name' from public.editor_projects), 'tall', 'project gốc không đổi');
select is((select source_hash from v), public.editor_document_hash('{"version":1,"stage":{"name":"square"}}'), 'vân tay là của bản sao');

select throws_ok($$ select public.snapshot_editor_variant('e1152000-0000-4000-8000-00000000000a', repeat('0', 64), '{"version":1,"stage":{}}', '1:1') $$,
  'P0409', null, 'bản đang lưu đã khác thì từ chối');
select throws_ok($$ select public.snapshot_editor_variant('e1152000-0000-4000-8000-00000000000a', (select hash from h), '{"stage":{}}', '1:1') $$,
  '22023', 'This version of the project could not be read.', 'document sai hình dạng');
select throws_ok($$ select public.snapshot_editor_variant('e1152000-0000-4000-8000-00000000000a', (select hash from h), '{"version":1,"stage":{}}', '') $$,
  '22023', 'An export version needs a short label.', 'cần nhãn');

set local request.jwt.claims = '{"sub":"e1150000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.snapshot_editor_variant('e1152000-0000-4000-8000-00000000000a', (select hash from h), '{"version":1,"stage":{}}', '1:1') $$,
  null, null, 'không chụp clip của người khác');

-- ------------------------------------------------------------ skills
set local request.jwt.claims = '{"sub":"e1150000-0000-4000-8000-00000000000a"}';
select is((public.save_editor_skill('Hook-Style', 'My hook: big yellow words in the first 2 seconds.', 'Steps…')).name, 'hook-style', 'tên chuẩn hoá thường');
select is((public.save_editor_skill('hook-style', 'Updated.', 'New body')).body, 'New body', 'lưu lại cùng tên là cập nhật');
select is((select count(*) from public.editor_skills), 1::bigint, 'vẫn một skill');
select throws_ok($$ select public.save_editor_skill('bad name!', 'x', 'y') $$, '22023', null, 'tên sai bị từ chối');
select throws_ok($$ select public.save_editor_skill('ok', '', 'y') $$, '22023', null, 'cần mô tả');
select throws_ok($$ insert into public.editor_skills (user_id, name, description, body) values ('e1150000-0000-4000-8000-00000000000a', 'x', 'y', 'z') $$,
  '42501', null, 'không insert thẳng');

set local request.jwt.claims = '{"sub":"e1150000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.editor_skills), 0::bigint, 'B không thấy skill của A');
select is(public.delete_editor_skill('hook-style'), false, 'B không xoá được skill của A');

set local request.jwt.claims = '{"sub":"e1150000-0000-4000-8000-00000000000a"}';
select is(public.delete_editor_skill('hook-style'), true, 'A xoá skill của mình');

select * from finish();
rollback;
