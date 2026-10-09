-- 3D Studio (20261007090000): spec video có `scene` chỉ với model có
-- `limits.scene`; model khác vẫn từ chối field lạ (hash không bao giờ lẫn).
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values ('e1050000-0000-4000-8000-00000000000a', '3d-a@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1051000-0000-4000-8000-00000000000a', 'e1050000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1050000-0000-4000-8000-00000000000a', 10, 'test grant');

select is((select provider from public.ai_models where id = 'studio-3d'), 'opencmo-3d', 'model studio-3d có trong catalog');
select is(public.ai_price((select m from public.ai_models m where id = 'studio-3d'),
  '{"prompt":"x","aspectRatio":"9:16","duration":10,"scene":{"template":"number","value":5}}'), 1, '1 credit mỗi lượt, không theo giây');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1050000-0000-4000-8000-00000000000a"}';

select throws_ok(
  $$ select public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'studio-3d',
       '{"prompt":"x","aspectRatio":"9:16","duration":5}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Describe the 3D scene first.', 'thiếu scene bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'studio-3d',
       '{"prompt":"x","aspectRatio":"9:16","duration":5,"scene":{"value":5}}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Describe the 3D scene first.', 'scene thiếu template bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'studio-3d',
       jsonb_build_object('prompt','x','aspectRatio','9:16','duration',5,'scene',
         jsonb_build_object('template','bars','title', repeat('x', 4100))), repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This 3D scene has too much data.', 'scene quá cỡ bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'studio-3d',
       '{"prompt":"x","aspectRatio":"4:3","duration":5,"scene":{"template":"number","value":5}}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', '3D Studio does not support that aspect ratio.', 'tỉ lệ ngoài danh sách bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'fake-video',
       '{"prompt":"x","aspectRatio":"9:16","duration":4,"scene":{"template":"number","value":5}}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'This request has settings the model does not take.', 'model video thường không nhận scene'
);
select is(
  (select (public.create_generation('e1051000-0000-4000-8000-00000000000a', null, 'studio-3d',
    '{"prompt":"Revenue $2.4M","aspectRatio":"4:5","duration":6,"scene":{"template":"number","value":2400000,"prefix":"$"}}',
    repeat('b', 64), gen_random_uuid())->'generation'->>'credits_reserved')::int),
  1, 'tạo được, giữ 1 credit'
);

select * from finish();
rollback;
