-- 20261103090000 (R7): settings gốc của clip nằm ở `clips.settings`, ghi đúng một lần,
-- qua đúng ba RPC worker cũ (tên + tham số không đổi để worker đang chạy không gãy).
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(8);

insert into auth.users (id, email) values ('e1320000-0000-4000-8000-00000000000a', 'r7-settings@test.local');
insert into public.jobs (id, user_id, source_url, status, attempt_id, duration_seconds) values
  ('e1320000-0000-4000-8000-0000000000b1', 'e1320000-0000-4000-8000-00000000000a', 'https://youtu.be/r7', 'running',
   'e1320000-0000-4000-8000-0000000000a1', 600);
insert into public.clips (id, job_id, idx, start_seconds, end_seconds) values
  ('e1320000-0000-4000-8000-0000000000c1', 'e1320000-0000-4000-8000-0000000000b1', 0, 1, 20);

select ok(to_regprocedure('public.draft_json(uuid)') is null, 'draft_json đã gỡ');
select ok(to_regprocedure('public.save_preset(text, jsonb)') is null, 'save_preset đã gỡ');

select throws_ok(
  $$ select public.create_clip_drafts('e1320000-0000-4000-8000-0000000000b1', 'e1320000-0000-4000-8000-0000000000a1',
       jsonb_build_array(jsonb_build_object('clip_id', 'e1320000-0000-4000-8000-0000000000c1',
         'settings', '{}'::jsonb, 'settings_hash', 'khong-phai-hex'))) $$,
  '22023', 'Clip settings are invalid.', 'hash sai: câu lỗi đọc được, không phải lỗi constraint'
);

select is(
  public.create_clip_drafts('e1320000-0000-4000-8000-0000000000b1', 'e1320000-0000-4000-8000-0000000000a1',
    jsonb_build_array(jsonb_build_object('clip_id', 'e1320000-0000-4000-8000-0000000000c1',
      'settings', '{"source_start": 1, "source_end": 20}'::jsonb, 'settings_hash', repeat('1', 64)))),
  1, 'ghi settings gốc cho clip chưa có'
);
select is((select settings ->> 'source_end' from public.clips where id = 'e1320000-0000-4000-8000-0000000000c1'),
  '20', 'settings nằm trên hàng clip');

-- Attempt mới (job chạy lại) gửi settings khác: bản đã có giữ nguyên.
update public.jobs set attempt_id = 'e1320000-0000-4000-8000-0000000000a2' where id = 'e1320000-0000-4000-8000-0000000000b1';
select is(
  public.create_clip_drafts('e1320000-0000-4000-8000-0000000000b1', 'e1320000-0000-4000-8000-0000000000a2',
    jsonb_build_array(jsonb_build_object('clip_id', 'e1320000-0000-4000-8000-0000000000c1',
      'settings', '{"source_start": 2, "source_end": 9}'::jsonb, 'settings_hash', repeat('2', 64)))),
  0, 'attempt sau không ghi đè'
);
select is((select settings_hash from public.clips where id = 'e1320000-0000-4000-8000-0000000000c1'),
  repeat('1', 64), 'hash giữ bản đầu');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1320000-0000-4000-8000-00000000000a"}';
select is((select settings_hash from public.clips where id = 'e1320000-0000-4000-8000-0000000000c1'),
  repeat('1', 64), 'chủ clip đọc được settings qua RLS của clips');

select * from finish();
rollback;
