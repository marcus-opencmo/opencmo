-- Checkpoint editor (20260925090000_editor_checkpoints).
--
--   checkpoint — chụp document server đang giữ, hash tính ở SQL, gọi lại cùng
--                bản cùng kind thì không nhân bản, clip người khác là 404
--   kind/label — chỉ agent/manual qua RPC, nhãn bắt buộc, vẫn bất biến
--   export     — chỉ tái dùng revision export, không tái dùng checkpoint
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('e9400000-0000-4000-8000-00000000000a', 'checkpoint-a@test.local'),
  ('e9400000-0000-4000-8000-00000000000b', 'checkpoint-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9410000-0000-4000-8000-00000000000a', 'e9400000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('e9410000-0000-4000-8000-00000000000b', 'e9400000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9420000-0000-4000-8000-00000000000a', 'e9410000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('e9420000-0000-4000-8000-00000000000b', 'e9410000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9400000-0000-4000-8000-00000000000a"}';

select lives_ok(
  $$ select public.get_or_create_editor_project('e9420000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"ONE","children":[]}}'::jsonb) $$,
  'tạo project'
);

-- ========================================================== checkpoint
create temporary table cp as
  select * from public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000a', 'agent', 'Before assistant edit');

select is((select kind from cp), 'agent', 'kind đúng như yêu cầu');
select is((select label from cp), 'Before assistant edit', 'nhãn được lưu');
select is((select document->'stage'->>'name' from cp), 'ONE', 'chụp document server đang giữ');
select is((select number from cp), 1, 'revision đầu tiên là số 1');
select is(
  (select source_hash from cp),
  public.editor_document_hash('{"version":1,"stage":{"name":"ONE","children":[]}}'::jsonb),
  'hash (vân tay document) do SQL tính'
);

select is(
  (select id from public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000a', 'agent', 'Again')),
  (select id from cp),
  'cùng bản, cùng kind: trả lại checkpoint cũ'
);

select is(
  (select number from public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000a', 'manual', 'Before applying caption style')),
  2,
  'khác kind thì là một checkpoint mới'
);

select throws_ok(
  $$ select public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000a', 'export', 'x') $$,
  '22023', 'Invalid checkpoint kind.', 'export không đi qua RPC checkpoint'
);

select throws_ok(
  $$ select public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000a', 'agent', '  ') $$,
  '22023', 'A checkpoint needs a short label.', 'nhãn rỗng bị chặn'
);

select throws_ok(
  $$ select public.checkpoint_editor_project('e9420000-0000-4000-8000-00000000000b', 'agent', 'x') $$,
  'P0002', null, 'clip của người khác không tồn tại với mình'
);

-- ================================================== export sau checkpoint
select is(
  (select kind from public.snapshot_editor_revision('e9420000-0000-4000-8000-00000000000a',
     public.editor_document_hash('{"version":1,"stage":{"name":"ONE","children":[]}}'::jsonb))),
  'export',
  'export cùng document với checkpoint vẫn là một revision export riêng'
);

select is(
  (select number from public.snapshot_editor_revision('e9420000-0000-4000-8000-00000000000a',
     public.editor_document_hash('{"version":1,"stage":{"name":"ONE","children":[]}}'::jsonb))),
  3,
  'export lại cùng bản: trả lại export cũ, không đẻ thêm'
);

select is(
  (select array_agg(kind order by number) from public.editor_revisions
   where clip_id = 'e9420000-0000-4000-8000-00000000000a'),
  array['agent', 'manual', 'export'],
  'ba revision, đánh số chung'
);

-- ================================================================ bất biến
reset role;
select throws_ok(
  $$ update public.editor_revisions set label = 'changed'
     where clip_id = 'e9420000-0000-4000-8000-00000000000a' and number = 1 $$,
  null, null, 'checkpoint bất biến như mọi revision'
);

select throws_ok(
  $$ insert into public.editor_revisions (clip_id, number, document, source_hash, kind)
     values ('e9420000-0000-4000-8000-00000000000a', 9, '{"version":1,"stage":{}}', repeat('0', 64), 'draft') $$,
  '23514', null, 'kind lạ bị check chặn'
);

select * from finish();
rollback;
