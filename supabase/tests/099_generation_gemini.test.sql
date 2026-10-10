-- Model Gemini trong catalog SQL (20260930090000): giá và giới hạn đi đúng
-- đường kiểm của create_generation như model giả.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values ('e9900000-0000-4000-8000-00000000000a', 'gem-a@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e9910000-0000-4000-8000-00000000000a', 'e9900000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e9900000-0000-4000-8000-00000000000a', 30, 'test grant');

select is((select count(*) from public.ai_models where id in ('gemini-image', 'gemini-video', 'gemini-voice') and enabled), 3::bigint, 'three Gemini models (served through fal since 20261112)');
select is(public.ai_price((select m from public.ai_models m where id = 'gemini-video'), '{"prompt":"x","aspectRatio":"9:16","duration":8}'), 24, 'Veo: 3 credit mỗi giây');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9900000-0000-4000-8000-00000000000a"}';

select throws_ok(
  $$ select public.create_generation('e9910000-0000-4000-8000-00000000000a', null, 'gemini-video',
       '{"prompt":"x","aspectRatio":"1:1","duration":8}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Veo 3.1 Fast does not support that aspect ratio.', 'Veo không nhận 1:1'
);
select throws_ok(
  $$ select public.create_generation('e9910000-0000-4000-8000-00000000000a', null, 'gemini-video',
       '{"prompt":"x","aspectRatio":"9:16","duration":5}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Veo 3.1 Fast does not support that duration.', 'Veo không nhận 5 giây'
);
select throws_ok(
  $$ select public.create_generation('e9910000-0000-4000-8000-00000000000a', null, 'gemini-voice',
       '{"prompt":"x","voice":"Aria"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Choose one of the listed voices.', 'giọng của model khác bị chặn'
);
select is(
  (select (public.create_generation('e9910000-0000-4000-8000-00000000000a', null, 'gemini-video',
    '{"prompt":"waves at dusk","aspectRatio":"9:16","duration":8}', repeat('b', 64), gen_random_uuid())
    ->'generation'->>'credits_reserved')::int),
  24, 'Veo 8 giây đặt trước 24 credit'
);
select is(public.credit_balance('e9900000-0000-4000-8000-00000000000a'), 6, 'số dư trừ phần đặt trước');

select * from finish();
rollback;
