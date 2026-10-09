-- Project của editor mới (20260922155056_editor_projects).
--
-- Bốn thứ phải đúng, và mỗi thứ hỏng theo một kiểu khác nhau:
--   ownership     — clip của người khác phải là "không tìm thấy", không phải lỗi quyền
--   khoá lạc quan — hai tab, tab tới sau với version cũ phải bị từ chối
--   trần kích thước — câu tiếng Anh, không phải tên ràng buộc Postgres
--   revision bất biến — export đã xếp hàng trỏ vào nó
--
-- Chạy dưới vai `authenticated` với JWT giả: đó là đường PostgREST đi thật, và
-- cũng là đường một dòng curl đi vòng qua route handler.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('e9000000-0000-4000-8000-00000000000a', 'editor-a@test.local'),
  ('e9000000-0000-4000-8000-00000000000b', 'editor-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9100000-0000-4000-8000-00000000000a', 'e9000000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('e9100000-0000-4000-8000-00000000000b', 'e9000000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9200000-0000-4000-8000-00000000000a', 'e9100000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('e9200000-0000-4000-8000-00000000000b', 'e9100000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

-- `editor_revisions` chỉ có policy SELECT, nên vai `authenticated` không
-- update thẳng được để thử trigger bất biến. Hàm này đi vòng qua RLS đúng như
-- một lượt ghi của service role sẽ làm — trigger vẫn phải chặn.
create function pg_temp.touch_revision(p_id uuid) returns void
language sql security definer set search_path = public as $fn$
  update public.editor_revisions set label = 'tampered' where id = p_id;
$fn$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9000000-0000-4000-8000-00000000000a"}';

-- ================================================================ tạo
select is(
  (public.get_or_create_editor_project('e9200000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"background":"v1","children":[]}}'::jsonb)->>'version'),
  '1', 'project mới bắt đầu ở version 1'
);

-- Gọi lại KHÔNG đè. Hai tab mở cùng lúc đều sinh document từ cùng dữ liệu, nhưng
-- tab thứ hai không được ghi lên bản mà tab thứ nhất có thể đã sửa.
select is(
  (public.get_or_create_editor_project('e9200000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"background":"other","children":[]}}'::jsonb)->'document'->'stage'->>'background'),
  'v1',
  'lượt tạo thứ hai trả bản đang có, không đè lên nó'
);

select throws_ok(
  $$ select public.get_or_create_editor_project('e9200000-0000-4000-8000-00000000000a', '"x"'::jsonb) $$,
  '22023', 'This project could not be read.', 'document sai hình dạng bị chặn'
);

-- ================================================================ ownership
select throws_ok(
  $$ select public.get_or_create_editor_project('e9200000-0000-4000-8000-00000000000b', '{"version":1,"stage":{"children":[]}}'::jsonb) $$,
  'P0002', 'Clip not found.', 'clip của người khác là "không tìm thấy"'
);

select throws_ok(
  $$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000b', 1, '{"version":1,"stage":{"children":[]}}'::jsonb) $$,
  'P0002', 'Clip not found.', 'không ghi được vào project của người khác'
);

select throws_ok(
  $$ select public.snapshot_editor_revision('e9200000-0000-4000-8000-00000000000b', repeat('a', 64)) $$,
  'P0002', 'Clip not found.', 'không chụp được revision của người khác'
);

-- `editor_json` không kiểm chủ: gọi thẳng được là đọc được project của người khác.
select ok(
  not has_function_privilege('authenticated', 'public.editor_json(uuid)', 'execute'),
  'người dùng không gọi thẳng được editor_json'
);

-- RLS: bảng chỉ lộ hàng của chủ clip.
select is(
  (select count(*)::int from public.editor_projects),
  1, 'chỉ đọc được project của clip mình sở hữu'
);

-- ==================================================== khoá lạc quan
select is(
  (public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 1, '{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb)->>'version'),
  '2', 'ghi đúng version thì version tăng'
);

select throws_ok(
  $$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 1, '{"version":1,"stage":{"background":"v3","children":[]}}'::jsonb) $$,
  'P0409', 'This clip was changed in another tab.', 'version cũ bị từ chối'
);

-- NULL không được bỏ qua CAS. Một client quên gửi version phải bị từ chối
-- chứ không được lặng lẽ thắng — cùng cái bẫy `save_draft` đã vá.
select throws_ok(
  $$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000a', null, '{"version":1,"stage":{"background":"v3","children":[]}}'::jsonb) $$,
  'P0409', 'This clip was changed in another tab.', 'version NULL không bỏ qua CAS'
);

-- Ghi lại y nguyên nội dung cũ thì KHÔNG tăng version: autosave bắn lại sau
-- một lượt `visibilitychange` là chuyện thường, và mỗi lượt như thế mà tăng
-- version thì tab kia bị đá ra vì một thay đổi không tồn tại.
select is(
  (public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, '{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb)->>'version'),
  '2', 'ghi lại cùng nội dung không tăng version'
);

-- ==================================================== trần kích thước
select throws_ok(
  format($$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, %L::jsonb) $$,
         jsonb_build_object('version', 1, 'stage', jsonb_build_object('name', repeat('x', 262144)))::text),
  '22023', 'This project could not be read.', 'document quá lớn bị chặn'
);

select throws_ok(
  format($$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, '{"version":1,"stage":{"background":"v9","children":[]}}'::jsonb, %L::jsonb) $$,
         jsonb_build_object('blob', repeat('x', 70000))::text),
  '22023', 'This project has too many assets to save.', 'manifest quá lớn có câu tiếng Anh'
);

select throws_ok(
  $$ select public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, '{"version":1,"stage":{"background":"v9","children":[]}}'::jsonb, '[]'::jsonb) $$,
  '22023', 'The project manifest must be an object.', 'manifest phải là object'
);

-- Không lượt nào ở trên lọt xuống bảng.
select is(
  (select document->'stage'->>'background' from public.editor_projects where clip_id = 'e9200000-0000-4000-8000-00000000000a'),
  'v2', 'lượt ghi bị từ chối không để lại dấu vết'
);

-- ==================================================== revision
-- Hash phải mô tả đúng document đang có. Client gửi hash của bản nó đang thấy
-- trong khi database đã sang bản khác — chụp nhầm ở đây nghĩa là export ra
-- một file không ai từng nhìn thấy.
select is(
  (public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, (select document from public.editor_projects where clip_id = 'e9200000-0000-4000-8000-00000000000a'))->>'document_hash'),
  public.editor_document_hash('{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb), 'editor_json trả vân tay của document đang lưu'
);
select is(
  (select public.document_hash(p) from public.editor_projects p where clip_id = 'e9200000-0000-4000-8000-00000000000a'),
  public.editor_document_hash('{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb), 'trường tính document_hash đọc được dưới RLS'
);
select throws_ok(
  $$ select public.snapshot_editor_revision('e9200000-0000-4000-8000-00000000000a', repeat('a', 64)) $$,
  'P0409', 'This project changed while it was being exported. Try again.',
  'hash không khớp document thì không chụp'
);

select throws_ok(
  $$ select public.snapshot_editor_revision('e9200000-0000-4000-8000-00000000000a', 'not-a-hash') $$,
  '22023', 'Invalid project fingerprint.', 'hash sai hình dạng bị chặn trước'
);

select is(
  (public.snapshot_editor_revision(
     'e9200000-0000-4000-8000-00000000000a',
     public.editor_document_hash('{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb))).number,
  1, 'revision đầu tiên là số 1'
);

-- Bấm Export hai lần không đẻ ra hai revision y hệt.
select is(
  (public.snapshot_editor_revision(
     'e9200000-0000-4000-8000-00000000000a',
     public.editor_document_hash('{"version":1,"stage":{"background":"v2","children":[]}}'::jsonb))).number,
  1, 'cùng hash trả lại chính revision đó'
);

select is(
  (select count(*)::int from public.editor_revisions
   where clip_id = 'e9200000-0000-4000-8000-00000000000a'),
  1, 'không có revision trùng lặp'
);

select is(
  (public.snapshot_editor_revision(
     (public.save_editor_document('e9200000-0000-4000-8000-00000000000a', 2, '{"version":1,"stage":{"background":"v3","children":[]}}'::jsonb)->>'clip_id')::uuid,
     public.editor_document_hash('{"version":1,"stage":{"background":"v3","children":[]}}'::jsonb))).number,
  2, 'document đổi thì revision tiếp theo là số 2'
);

-- Bất biến: export đã xếp hàng trỏ vào một revision, sửa nó là đổi nội dung
-- file mà người dùng tưởng mình đã chốt.
select throws_ok(
  format($$ select pg_temp.touch_revision(%L) $$,
         (select id from public.editor_revisions
          where clip_id = 'e9200000-0000-4000-8000-00000000000a' and number = 1)),
  'P0001', 'Revisions cannot be changed.', 'revision không sửa được'
);

-- ==================================================== bucket rate limit
-- `rate_limit_hit` là một allowlist: bộ tham số nào không có trong đó thì hàm
-- raise. Thiếu dòng này là route handler chết ngay lượt gọi đầu.
select ok(
  public.rate_limit_hit('editor-write', 240, 60),
  'bucket editor-write nằm trong allowlist'
);

select throws_ok(
  $$ select public.rate_limit_hit('editor-write', 100000, 60) $$,
  '22023', 'Invalid rate limit.', 'trần khác với bản đã audit vẫn bị từ chối'
);

select * from finish();
rollback;
