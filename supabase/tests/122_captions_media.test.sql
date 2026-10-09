-- 20261024090000: phụ đề cho media bất kỳ + dịch — trừ/hoàn credit đúng, chỉ chủ, chỉ file của project.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(21);

insert into auth.users (id, email) values
  ('e1220000-0000-4000-8000-00000000000a', 'cap-a@test.local'),
  ('e1220000-0000-4000-8000-00000000000b', 'cap-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1221000-0000-4000-8000-00000000000a', 'e1220000-0000-4000-8000-00000000000a', 'storage://e1220000-0000-4000-8000-00000000000a/talk.mp4', 600, 'done'),
  ('e1221100-0000-4000-8000-00000000000a', 'e1220000-0000-4000-8000-00000000000a', 'storage://e1220000-0000-4000-8000-00000000000a/other.mp4', 600, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, source_start, source_end) values
  ('e1222000-0000-4000-8000-00000000000a', 'e1221000-0000-4000-8000-00000000000a', 0, 'Hook', 0, 30, 0, 30);
insert into public.media_assets (id, user_id, job_id, storage_path, name, duration, status) values
  ('e1223000-0000-4000-8000-00000000000a', 'e1220000-0000-4000-8000-00000000000a', 'e1221000-0000-4000-8000-00000000000a', 'media/a/broll.mp4', 'broll.mp4', 150, 'ready'),
  ('e1223100-0000-4000-8000-00000000000a', 'e1220000-0000-4000-8000-00000000000a', 'e1221100-0000-4000-8000-00000000000a', 'media/a/else.mp4', 'else.mp4', 60, 'ready'),
  ('e1223200-0000-4000-8000-00000000000a', 'e1220000-0000-4000-8000-00000000000a', 'e1221000-0000-4000-8000-00000000000a', 'media/a/pending.mp4', 'pending.mp4', 60, 'pending');
-- Số dư đặt về đúng 5 credit, bất kể quà đăng ký.
insert into public.credit_ledger (user_id, delta, reason)
select 'e1220000-0000-4000-8000-00000000000a', 5 - public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 'test';

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1220000-0000-4000-8000-00000000000a"}';

-- 150 s → 3 credit; đoạn 10…70 s → 1 credit.
create temp table cap as select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223000-0000-4000-8000-00000000000a') as v;
select is((select (v ->> 'credits')::int from cap), 3, 'cả file 150 s: 3 credit (làm tròn lên)');
select is(public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 2, 'trừ ngay lúc tạo task');
select is((select kind || ':' || status from public.tasks where id = (select (v ->> 'task_id')::uuid from cap)), 'transcribe_media:queued', 'task chờ worker');
select is((select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223000-0000-4000-8000-00000000000a') ->> 'task_id'), (select v ->> 'task_id' from cap), 'bấm lại khi đang chạy: cùng task, không trừ lần hai');
select is(public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 2, '...số dư giữ nguyên');
create temp table part as select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223000-0000-4000-8000-00000000000a', 10, 70) as v;
select is((select (v ->> 'credits')::int from part), 1, 'đoạn 60 s: 1 credit');
select throws_ok($$ select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223000-0000-4000-8000-00000000000a', 0, 100) $$,
  'P0001', 'Not enough credits: 2 needed, 1 left. Top up on the Credits page.', 'thiếu credit thì từ chối');
select throws_ok($$ select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223100-0000-4000-8000-00000000000a') $$,
  'P0002', null, 'file của project khác bị từ chối');
select throws_ok($$ select public.request_media_captions('e1222000-0000-4000-8000-00000000000a', 'e1223200-0000-4000-8000-00000000000a') $$,
  'P0001', 'This file is still being processed. Try again in a moment.', 'file đang được đo: báo chờ (client gọi lại)');
select throws_ok($$ select public.complete_media_captions(gen_random_uuid(), null, '[]') $$, '42501', null, 'người dùng không gọi được RPC của worker');

-- Worker: lượt đầu xong, lượt hai hỏng → hoàn 1 credit.
reset role;
update public.tasks set status = 'running', attempt_id = 'e1229000-0000-4000-8000-00000000000a' where id = (select (v ->> 'task_id')::uuid from cap);
select is(public.complete_media_captions((select (v ->> 'task_id')::uuid from cap), 'e1229000-0000-4000-8000-00000000000a',
  '[{"text":"hello there","words":[{"word":"hello","start":0,"end":0.4},{"word":"there","start":0.4,"end":0.9}]}]'),
  encode(sha256(convert_to('[{"text":"hello there","words":[{"word":"hello","start":0,"end":0.4},{"word":"there","start":0.4,"end":0.9}]}]', 'UTF8')), 'hex'),
  'worker chốt: trả hash của nội dung');
select is((select count(*)::int from public.editor_transcripts where clip_id = 'e1222000-0000-4000-8000-00000000000a'), 1, 'transcript vào editor_transcripts của clip');
select is((select output ->> 'src' from public.tasks where id = (select (v ->> 'task_id')::uuid from cap)) like 'assets/transcripts/%.json', true, 'task ghi src cho lớp captions');
update public.tasks set status = 'running', attempt_id = 'e1229100-0000-4000-8000-00000000000a' where id = (select (v ->> 'task_id')::uuid from part);
select ok(public.fail_task((select (v ->> 'task_id')::uuid from part), 'e1229100-0000-4000-8000-00000000000a', 'No speech found in this part of the file.'), 'worker báo hỏng');
select is(public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 2, 'hỏng thì hoàn đúng 1 credit');

-- Dịch: trừ → chốt; trừ → hoàn; hoàn rồi thì không chốt được, chốt rồi thì không hoàn được.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1220000-0000-4000-8000-00000000000a"}';
create temp table tr as select public.charge_caption_translation('e1222000-0000-4000-8000-00000000000a', 30) as v;
select is(public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 1, 'dịch 30 s: trừ 1 credit');
select is(public.complete_caption_translation((select (v ->> 'charge_id')::uuid from tr), '[{"text":"hola","words":[{"word":"hola","start":0,"end":0.5}]}]') ~ '^[0-9a-f]{64}$', true, 'chốt bản dịch: trả hash');
select is(public.refund_caption_translation((select (v ->> 'charge_id')::uuid from tr)), false, 'đã chốt thì không hoàn');
create temp table tr2 as select public.charge_caption_translation('e1222000-0000-4000-8000-00000000000a', 30) as v;
select is(public.refund_caption_translation((select (v ->> 'charge_id')::uuid from tr2)), true, 'lỗi giữa chừng: hoàn lại');
select is(public.credit_balance('e1220000-0000-4000-8000-00000000000a'), 1, '...số dư về như trước lượt dịch');
select throws_ok($$ select public.complete_caption_translation((select (v ->> 'charge_id')::uuid from tr2), '[]') $$, 'P0001', 'This translation was cancelled. Try again.', 'đã hoàn thì không lấy được bản dịch');

select * from finish();
rollback;
