-- Generate (20260929090000).
--
--   tạo    — kiểm catalog + spec, đặt trước credit, task `generate` cùng giao dịch
--   trùng  — cùng (project, hash) trả lại lượt cũ, không trừ lần hai; request id lặp
--   chốt   — complete_generation gắn media asset, chốt ≤ đặt trước, hoàn phần dư
--   hoàn   — fail_task / reclaim / huỷ → hoàn TOÀN BỘ, một lần
--   quyền  — người khác không tạo trên project, không huỷ, không đọc
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e9800000-0000-4000-8000-00000000000a', 'gen-a@test.local'),
  ('e9800000-0000-4000-8000-00000000000b', 'gen-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9810000-0000-4000-8000-00000000000a', 'e9800000-0000-4000-8000-00000000000a', 'https://a', 600, 'done'),
  ('e9810000-0000-4000-8000-00000000000c', 'e9800000-0000-4000-8000-00000000000a', 'https://c', 600, 'done'),
  ('e9810000-0000-4000-8000-00000000000b', 'e9800000-0000-4000-8000-00000000000b', 'https://b', 600, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e9820000-0000-4000-8000-00000000000a', 'e9810000-0000-4000-8000-00000000000a', 0, 1, 20, 1, 20),
  ('e9820000-0000-4000-8000-00000000000b', 'e9810000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);
insert into public.credit_ledger(user_id, delta, reason) values
  ('e9800000-0000-4000-8000-00000000000a', 10, 'test grant');

-- ================================================================ giá
select is(public.ai_price((select m from public.ai_models m where id = 'fake-image'), '{"prompt":"x","aspectRatio":"1:1"}'), 1, 'ảnh: theo lượt');
select is(public.ai_price((select m from public.ai_models m where id = 'fake-video'), '{"prompt":"x","aspectRatio":"1:1","duration":5}'), 5, 'video: theo giây');
select is(public.ai_price((select m from public.ai_models m where id = 'fake-voice'), jsonb_build_object('prompt', repeat('a', 1001), 'voice', 'Aria')), 2, 'giọng: theo nghìn ký tự, làm tròn lên');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9800000-0000-4000-8000-00000000000a"}';

-- ================================================================ kiểm spec
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'nope', '{"prompt":"x"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This model is not available.', 'model lạ bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-image', '{"prompt":"x","aspectRatio":"2:1"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Test image does not support that aspect ratio.', 'tỉ lệ ngoài catalog bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-image', '{"prompt":"x","aspectRatio":"1:1","duration":5}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This request has settings the model does not take.', 'field lạ bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-image', '{"prompt":"  ","aspectRatio":"1:1"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Write a prompt first.', 'prompt rỗng bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-video', '{"prompt":"x","aspectRatio":"1:1","duration":4}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Test video does not support that duration.', 'thời lượng ngoài catalog bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-audio', '{"prompt":"x","duration":30}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Sounds are 1 to 22 seconds long.', 'âm thanh quá dài bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-image', '{"prompt":"x","aspectRatio":"1:1"}', 'not-a-hash', gen_random_uuid()) $$,
  '22023', 'Invalid generation request.', 'hash sai định dạng bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000b', null, 'fake-image', '{"prompt":"x","aspectRatio":"1:1"}', repeat('a', 64), gen_random_uuid()) $$,
  'P0002', 'Project not found.', 'project người khác bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', 'e9820000-0000-4000-8000-00000000000b', 'fake-image', '{"prompt":"x","aspectRatio":"1:1"}', repeat('a', 64), gen_random_uuid()) $$,
  'P0002', 'Clip not found.', 'clip ngoài project bị chặn'
);

-- ================================================================ tạo + trùng
create temporary table g1 as
  select public.create_generation('e9810000-0000-4000-8000-00000000000a', 'e9820000-0000-4000-8000-00000000000a',
    'fake-video', '{"prompt":"a cat","aspectRatio":"9:16","duration":3}', repeat('1', 64),
    'e9830000-0000-4000-8000-000000000001') as r;
grant select on g1 to authenticated;
select is((select r->>'reused' from g1), 'false', 'lượt mới');
select is((select (r->'generation'->>'credits_reserved')::int from g1), 3, 'đặt trước 3 credit');
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 7, 'số dư trừ phần đặt trước');
select is(
  (select kind || ':' || status from public.tasks where id = (select (r->'generation'->>'task_id')::uuid from g1)),
  'generate:queued', 'task generate xếp hàng cùng giao dịch'
);
select is(
  (select r->>'reused' from (select public.create_generation('e9810000-0000-4000-8000-00000000000a', null,
    'fake-video', '{"prompt":"a cat","aspectRatio":"9:16","duration":3}', repeat('1', 64), gen_random_uuid()) as r) x),
  'true', 'cùng hash cùng project: trả lượt cũ'
);
select is(
  (select r->'generation'->>'id' from (select public.create_generation('e9810000-0000-4000-8000-00000000000a', null,
    'fake-image', '{"prompt":"other","aspectRatio":"1:1"}', repeat('9', 64), 'e9830000-0000-4000-8000-000000000001') as r) x),
  (select r->'generation'->>'id' from g1), 'gửi lại cùng request id: trả đúng lượt đó'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 7, 'trùng không trừ lần hai');
select is(
  (select r->>'reused' from (select public.create_generation('e9810000-0000-4000-8000-00000000000c', null,
    'fake-video', '{"prompt":"a cat","aspectRatio":"9:16","duration":3}', repeat('1', 64), gen_random_uuid()) as r) x),
  'false', 'cùng hash ở project khác là lượt riêng'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 4, 'lượt ở project khác trả tiền riêng');
select throws_ok(
  $$ select public.create_generation('e9810000-0000-4000-8000-00000000000a', null, 'fake-video',
       '{"prompt":"long","aspectRatio":"1:1","duration":5}', repeat('2', 64), gen_random_uuid()) $$,
  'P0001', 'Not enough credits: 5 needed, 4 left. Top up on the Credits page.', 'thiếu credit bị chặn'
);

-- người khác không đọc, không huỷ
set local request.jwt.claims = '{"sub":"e9800000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.generations), 0::bigint, 'RLS giấu generation người khác');
select throws_ok(
  $$ select public.cancel_generation((select (r->'generation'->>'id')::uuid from g1)) $$,
  'P0002', 'Generation not found.', 'người khác không huỷ được'
);
set local request.jwt.claims = '{"sub":"e9800000-0000-4000-8000-00000000000a"}';
select is((select count(*) from public.generations), 2::bigint, 'chủ đọc được');

-- ================================================================ worker: chốt
reset role;
create temporary table claimed as select * from public.claim_next_task(array['generate'], 300)
  where payload->>'generation_id' = (select r->'generation'->>'id' from g1);
select is((select count(*) from claimed), 1::bigint, 'worker claim được task generate');
select is(
  (select status from public.generations where id = (select (r->'generation'->>'id')::uuid from g1)),
  'running', 'generation chạy theo task'
);
select throws_ok(
  $$ select public.complete_generation((select id from claimed), (select attempt_id from claimed),
       'someone/else/gen-00000000-0000-4000-8000-000000000000.mp4', 'x', 3, 1080, 1920, 3) $$,
  'P0001', 'invalid generated object name', 'đường dẫn ngoài project bị chặn'
);
select ok(
  public.complete_generation((select id from claimed), (select attempt_id from claimed),
    'e9800000-0000-4000-8000-00000000000a/e9810000-0000-4000-8000-00000000000a/gen-' || (select r->'generation'->>'id' from g1) || '.mp4',
    'a cat.mp4', 3, 1080, 1920, 2),
  'chốt thành công'
);
select is(
  (select status || ':' || credits_final || ':' || (media_asset_id is not null)
     from public.generations where id = (select (r->'generation'->>'id')::uuid from g1)),
  'done:2:true', 'done, chốt 2 credit, có media asset'
);
select is(
  (select status from public.media_assets where id = (select media_asset_id from public.generations where id = (select (r->'generation'->>'id')::uuid from g1))),
  'ready', 'media asset sẵn sàng ngay'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 5, 'hoàn phần dư 1 credit');
select ok(
  public.complete_generation((select id from claimed), (select attempt_id from claimed),
    'e9800000-0000-4000-8000-00000000000a/e9810000-0000-4000-8000-00000000000a/gen-' || (select r->'generation'->>'id' from g1) || '.mp4',
    'a cat.mp4', 3, 1080, 1920, 2),
  'chốt lại (response mất) vẫn true'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 5, 'chốt lặp không hoàn thêm');

-- ================================================================ hoàn: fail_task
create temporary table claimed2 as select * from public.claim_next_task(array['generate'], 300);
select ok(public.fail_task((select id from claimed2), (select attempt_id from claimed2), 'Rendering failed. Please try again.'), 'worker báo lỗi');
select is(
  (select status || ':' || error from public.generations where task_id = (select id from claimed2)),
  'failed:Generation failed. Your credits were refunded.', 'lỗi chung của worker được thay bằng câu đúng việc'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 8, 'hoàn toàn bộ 3 credit');
select ok(public.fail_task((select id from claimed2), (select attempt_id from claimed2), 'again'), 'báo lỗi lặp');
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 8, 'không hoàn hai lần');

-- lượt hỏng không chặn lượt sau cùng spec
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9800000-0000-4000-8000-00000000000a"}';
select is(
  (select r->>'reused' from (select public.create_generation('e9810000-0000-4000-8000-00000000000c', null,
    'fake-video', '{"prompt":"a cat","aspectRatio":"9:16","duration":3}', repeat('1', 64), gen_random_uuid()) as r) x),
  'false', 'sau lượt hỏng, cùng spec chạy lại được'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 5, 'lượt mới đặt trước lại');

-- ================================================================ hoàn: huỷ
create temporary table g3 as
  select public.create_generation('e9810000-0000-4000-8000-00000000000a', null,
    'fake-image', '{"prompt":"sunset","aspectRatio":"1:1","seed":7}', repeat('3', 64), gen_random_uuid()) as r;
grant select on g3 to authenticated;
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 4, 'đặt trước ảnh');
select is((select public.cancel_generation((select (r->'generation'->>'id')::uuid from g3))->>'status'), 'cancelled', 'huỷ lượt đang xếp hàng');
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 5, 'huỷ hoàn toàn bộ');
select is((select public.cancel_generation((select (r->'generation'->>'id')::uuid from g3))->>'status'), 'cancelled', 'huỷ lần hai vô hại');
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 5, 'không hoàn hai lần');

-- huỷ khi worker đang chạy: complete thua
reset role;
create temporary table claimed3 as select * from public.claim_next_task(array['generate'], 300);
grant select on claimed3 to authenticated;
set local role authenticated;
select is(
  (select public.cancel_generation((select (payload->>'generation_id')::uuid from claimed3))->>'status'),
  'cancelled', 'huỷ lượt đang chạy'
);
reset role;
select ok(
  not public.complete_generation((select id from claimed3), (select attempt_id from claimed3),
    'e9800000-0000-4000-8000-00000000000a/e9810000-0000-4000-8000-00000000000c/gen-' || (select payload->>'generation_id' from claimed3) || '.mp4',
    'x.mp4', 3, 1, 1, 3),
  'worker chốt sau khi bị huỷ: false (worker xoá file)'
);
select is(public.credit_balance('e9800000-0000-4000-8000-00000000000a'), 8, 'huỷ lúc chạy hoàn toàn bộ');

-- quyền: người dùng không gọi được RPC của worker
set local role authenticated;
select throws_ok(
  $$ select public.complete_generation(gen_random_uuid(), gen_random_uuid(), 'a', 'b', 1, 1, 1, 1) $$,
  '42501', null, 'người dùng không chốt được'
);

select * from finish();
rollback;
