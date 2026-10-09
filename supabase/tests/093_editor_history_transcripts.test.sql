-- Editor đợt 2 (20260924100000_editor_history_transcripts).
--
--   transcript — hash do server tính, cùng nội dung là cùng hàng, sai hình
--                dạng bị chặn bằng câu tiếng Anh, clip người khác là 404
--   bản gốc    — ghi đúng một lần lúc tạo; reset có khoá lạc quan
--   xoá B-roll — chỉ chủ file xoá được, và object đi vào hàng xoá Storage
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('e9300000-0000-4000-8000-00000000000a', 'history-a@test.local'),
  ('e9300000-0000-4000-8000-00000000000b', 'history-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9310000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('e9310000-0000-4000-8000-00000000000b', 'e9300000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9320000-0000-4000-8000-00000000000a', 'e9310000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('e9320000-0000-4000-8000-00000000000b', 'e9310000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

insert into public.media_assets (id, user_id, job_id, storage_path, name, status) values
  ('e9330000-0000-4000-8000-00000000000a', 'e9300000-0000-4000-8000-00000000000a',
   'e9310000-0000-4000-8000-00000000000a',
   'media/e9300000-0000-4000-8000-00000000000a/e9310000-0000-4000-8000-00000000000a/a.mp4', 'a.mp4', 'ready'),
  ('e9330000-0000-4000-8000-00000000000b', 'e9300000-0000-4000-8000-00000000000b',
   'e9310000-0000-4000-8000-00000000000b',
   'media/e9300000-0000-4000-8000-00000000000b/e9310000-0000-4000-8000-00000000000b/b.mp4', 'b.mp4', 'ready');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9300000-0000-4000-8000-00000000000a"}';

-- ========================================================== transcript
select is(
  public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a',
    '[{"text":"hello world","words":[{"text":"hello","start":0,"end":0.4}]}]'),
  encode(sha256(convert_to(
    '[{"text":"hello world","words":[{"text":"hello","start":0,"end":0.4}]}]', 'UTF8')), 'hex'),
  'hash là sha256 của đúng các byte đã gửi, do server tính'
);

select lives_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a',
       '[{"text":"hello world","words":[{"text":"hello","start":0,"end":0.4}]}]') $$,
  'gửi lại cùng nội dung không lỗi'
);

select is(
  (select count(*)::int from public.editor_transcripts
   where clip_id = 'e9320000-0000-4000-8000-00000000000a'),
  1, 'cùng nội dung là cùng một hàng'
);

-- Body trả về y nguyên, không bị chuẩn hoá: hash phải khớp lại ở client.
select is(
  (select body from public.editor_transcripts
   where clip_id = 'e9320000-0000-4000-8000-00000000000a'),
  '[{"text":"hello world","words":[{"text":"hello","start":0,"end":0.4}]}]',
  'body giữ đúng từng byte'
);

select throws_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a', '{nope') $$,
  '22023', 'This transcript is not valid JSON.', 'JSON hỏng bị chặn'
);

select throws_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a', '{"text":"x"}') $$,
  '22023', 'This transcript has an unexpected shape.', 'không phải mảng là sai hình dạng'
);

select throws_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a', '[{"text":"x"}]') $$,
  '22023', 'This transcript has an unexpected shape.', 'đoạn thiếu words là sai hình dạng'
);

select throws_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000a',
       '[' || repeat('{"text":"x","words":[]},', 30000) || '{"text":"x","words":[]}]') $$,
  '22023', 'This transcript is too large to save.', 'trần kích thước'
);

select throws_ok(
  $$ select public.put_editor_transcript('e9320000-0000-4000-8000-00000000000b', '[]') $$,
  'P0002', 'Clip not found.', 'không ghi transcript vào clip của người khác'
);

-- ============================================================ bản gốc
select is(
  (public.get_or_create_editor_project('e9320000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"GENERATED","children":[]}}'::jsonb)->>'version'),
  '1', 'tạo project'
);

select is(
  (select generated_document->'stage'->>'name' from public.editor_projects
   where clip_id = 'e9320000-0000-4000-8000-00000000000a'),
  'GENERATED', 'bản gốc được giữ lúc tạo'
);

select is(
  (public.save_editor_document('e9320000-0000-4000-8000-00000000000a', 1, '{"version":1,"stage":{"name":"EDITED","children":[]}}'::jsonb)->>'version'),
  '2', 'một lượt sửa'
);

select is(
  (select generated_document->'stage'->>'name' from public.editor_projects
   where clip_id = 'e9320000-0000-4000-8000-00000000000a'),
  'GENERATED', 'lượt sửa không đụng bản gốc'
);

select throws_ok(
  $$ select public.reset_editor_project('e9320000-0000-4000-8000-00000000000a', 1) $$,
  'P0409', 'This clip was changed in another tab.', 'reset với version cũ bị từ chối'
);

select is(
  (public.reset_editor_project('e9320000-0000-4000-8000-00000000000a', 2)->'document'->'stage'->>'name'),
  'GENERATED', 'reset đưa document về bản gốc'
);

select is(
  (select version from public.editor_projects
   where clip_id = 'e9320000-0000-4000-8000-00000000000a'),
  3, 'reset là một lượt ghi: version tăng để tab khác biết'
);

select is(
  (public.reset_editor_project('e9320000-0000-4000-8000-00000000000a', 3)->>'version'),
  '3', 'reset khi đã ở bản gốc không tăng version'
);

select throws_ok(
  $$ select public.reset_editor_project('e9320000-0000-4000-8000-00000000000b', 1) $$,
  'P0002', 'Clip not found.', 'không reset được project của người khác'
);

-- ========================================================== xoá B-roll
select throws_ok(
  $$ select public.delete_media_asset('e9330000-0000-4000-8000-00000000000b') $$,
  'P0002', 'That media file was not found.', 'không xoá được file của người khác'
);

select lives_ok(
  $$ select public.delete_media_asset('e9330000-0000-4000-8000-00000000000a') $$,
  'chủ file xoá được'
);

reset role;

select is(
  (select count(*)::int from public.media_assets where id = 'e9330000-0000-4000-8000-00000000000a'),
  0, 'hàng media_assets đã đi'
);

select ok(
  exists (select 1 from public.storage_deletions
          where path like '%e9310000-0000-4000-8000-00000000000a/a.mp4'),
  'object Storage vào hàng xoá'
);

select is(
  (select count(*)::int from public.media_assets where id = 'e9330000-0000-4000-8000-00000000000b'),
  1, 'file của người khác còn nguyên'
);

select * from finish();
rollback;
