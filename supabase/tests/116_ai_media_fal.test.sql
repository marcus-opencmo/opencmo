-- Plan Palmier P1 (20261018090000): khả năng theo model + giá theo độ phân giải.
--
--   giá    — hệ số độ phân giải nhân vào, làm tròn lên; thiếu = 1
--   khả năng — trường model không khai báo bị từ chối; độ phân giải lạ bị từ chối
--   ảnh    — chỉ object của CHÍNH người gọi trong bucket `media`, và phải tồn tại
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1160000-0000-4000-8000-00000000000a', 'fal-a@test.local'),
  ('e1160000-0000-4000-8000-00000000000b', 'fal-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1161000-0000-4000-8000-00000000000a', 'e1160000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1160000-0000-4000-8000-00000000000a', 100, 'test grant');
insert into storage.objects (bucket_id, name, owner) values
  ('media', 'e1160000-0000-4000-8000-00000000000a/e1161000-0000-4000-8000-00000000000a/still.png', 'e1160000-0000-4000-8000-00000000000a'),
  ('media', 'e1160000-0000-4000-8000-00000000000b/x/theirs.png', 'e1160000-0000-4000-8000-00000000000b');

-- ================================================================ giá
select is(public.ai_price((select m from public.ai_models m where id = 'fal-seedance'),
  '{"prompt":"x","aspectRatio":"9:16","duration":5,"resolution":"720p"}'), 10, '720p: 5 giây × 1 × hệ số 2');
select is(public.ai_price((select m from public.ai_models m where id = 'fal-seedance'),
  '{"prompt":"x","aspectRatio":"9:16","duration":10,"resolution":"480p"}'), 10, '480p: hệ số 1');
select is(public.ai_price((select m from public.ai_models m where id = 'fal-seedance'),
  '{"prompt":"x","aspectRatio":"9:16","duration":5}'), 5, 'thiếu độ phân giải: hệ số 1');
select is(public.ai_price((select m from public.ai_models m where id = 'fake-voice'),
  jsonb_build_object('prompt', repeat('a', 1001), 'voice', 'Aria')), 2, 'công thức cũ không đổi');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1160000-0000-4000-8000-00000000000a"}';

-- ================================================================ khả năng
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-kling',
       '{"prompt":"x","aspectRatio":"9:16","duration":5,"endImage":"e1160000-0000-4000-8000-00000000000a/e1161000-0000-4000-8000-00000000000a/still.png"}',
       repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This request has settings the model does not take.', 'Kling không có frame cuối'
);
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-seedance',
       '{"prompt":"x","aspectRatio":"9:16","duration":5,"resolution":"1080p"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Seedance Lite does not support that resolution.', 'độ phân giải lạ bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fake-audio',
       '{"prompt":"x","duration":3,"references":["e1160000-0000-4000-8000-00000000000a/e1161000-0000-4000-8000-00000000000a/still.png"]}',
       repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This request has settings the model does not take.', 'model không nhận tham chiếu'
);

-- ================================================================ ảnh
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-seedance',
       '{"prompt":"x","aspectRatio":"9:16","duration":5,"startImage":"e1160000-0000-4000-8000-00000000000b/x/theirs.png"}',
       repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'That image was not found in your library.', 'ảnh của người khác bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-seedance',
       '{"prompt":"x","aspectRatio":"9:16","duration":5,"startImage":"e1160000-0000-4000-8000-00000000000a/nope.png"}',
       repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'That image was not found in your library.', 'ảnh không tồn tại bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-nano-banana',
       jsonb_build_object('prompt', 'x', 'aspectRatio', '1:1', 'references',
         (select jsonb_agg('e1160000-0000-4000-8000-00000000000a/e1161000-0000-4000-8000-00000000000a/still.png'::text) from generate_series(1, 5))),
       repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Nano Banana takes up to 4 reference images.', 'quá số tham chiếu'
);

create temp table created as select public.create_generation('e1161000-0000-4000-8000-00000000000a', null, 'fal-seedance',
  '{"prompt":"a fox","aspectRatio":"9:16","duration":5,"resolution":"720p","startImage":"e1160000-0000-4000-8000-00000000000a/e1161000-0000-4000-8000-00000000000a/still.png"}',
  repeat('b', 64), gen_random_uuid()) as result;
select is((select (result->'generation'->>'credits_reserved')::int from created), 10, 'ảnh của mình + 720p: đặt trước đúng giá');

select ok(not has_function_privilege('authenticated', 'public.ai_media_ref_ok(jsonb)', 'execute'), 'không gọi thẳng được hàm dò object');

select * from finish();
rollback;
