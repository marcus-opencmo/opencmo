-- Voiceover (20261009090000): model ElevenLabs, giọng thử đổi tên, mốc chữ
-- của giọng đọc lưu vào `media_assets.words` qua `complete_generation`.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values ('e1070000-0000-4000-8000-00000000000a', 'vo-a@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1071000-0000-4000-8000-00000000000a', 'e1070000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1070000-0000-4000-8000-00000000000a', 20, 'test grant');

-- ================================================================ catalog
select is((select enabled from public.ai_models where id = 'elevenlabs-voice'), true, 'elevenlabs-voice is in the catalog (served through fal since 20261112)');
select is(public.ai_price((select m from public.ai_models m where id = 'elevenlabs-voice'),
  jsonb_build_object('prompt', repeat('a', 1500), 'voice', 'Aria')), 10, '5 credit mỗi nghìn ký tự, làm tròn lên');
select ok((select limits->'voices' ? 'Test A' from public.ai_models where id = 'fake-voice'), 'giọng thử tên Test A');
select ok((select not limits->'voices' ? 'Aria' from public.ai_models where id = 'fake-voice'), 'giọng thử không còn trùng tên giọng thật');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1070000-0000-4000-8000-00000000000a"}';

select throws_ok(
  $$ select public.create_generation('e1071000-0000-4000-8000-00000000000a', null, 'elevenlabs-voice',
       '{"prompt":"x","voice":"Kore"}', repeat('a', 64), gen_random_uuid()) $$,
  '22023', 'Choose one of the listed voices.', 'giọng của Gemini bị chặn ở ElevenLabs'
);
create temporary table g1 as select public.create_generation('e1071000-0000-4000-8000-00000000000a', null, 'fake-voice',
  '{"prompt":"hello there world","voice":"Test B"}', repeat('c', 64), gen_random_uuid()) as r;
create temporary table g2 as select public.create_generation('e1071000-0000-4000-8000-00000000000a', null, 'fake-image',
  '{"prompt":"a cat","aspectRatio":"1:1"}', repeat('d', 64), gen_random_uuid()) as r;
select is((select r->'generation'->>'status' from g1), 'queued', 'tạo được giọng thử');

-- ================================================================ worker: mốc chữ
reset role;
create temporary table c1 as select * from public.claim_next_task(array['generate'], 300)
  where payload->>'generation_id' = (select r->'generation'->>'id' from g1);
select ok(
  public.complete_generation((select id from c1), (select attempt_id from c1),
    'e1070000-0000-4000-8000-00000000000a/e1071000-0000-4000-8000-00000000000a/gen-' || (select r->'generation'->>'id' from g1) || '.m4a',
    'hello.m4a', 1.2, null, null, 1,
    '[{"text":"hello","start":0,"end":0.4},{"text":"there","start":0.4,"end":0.8},{"text":"world","start":0.8,"end":1.2}]'),
  'chốt giọng kèm mốc chữ'
);
select is(
  (select jsonb_array_length(words) from public.media_assets
     where id = (select media_asset_id from public.generations where id = (select (r->'generation'->>'id')::uuid from g1))),
  3, 'mốc chữ lưu vào media asset'
);

create temporary table c2 as select * from public.claim_next_task(array['generate'], 300)
  where payload->>'generation_id' = (select r->'generation'->>'id' from g2);
select ok(
  public.complete_generation((select id from c2), (select attempt_id from c2),
    'e1070000-0000-4000-8000-00000000000a/e1071000-0000-4000-8000-00000000000a/gen-' || (select r->'generation'->>'id' from g2) || '.png',
    'a cat.png', null, 1024, 1024, 1, '[{"text":"x","start":0,"end":1}]'),
  'chốt ảnh (mốc chữ bị bỏ)'
);
select ok(
  (select words is null from public.media_assets
     where id = (select media_asset_id from public.generations where id = (select (r->'generation'->>'id')::uuid from g2))),
  'ảnh không giữ mốc chữ'
);

-- mốc chữ sai hình dạng: bỏ, lượt sinh vẫn chốt
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1070000-0000-4000-8000-00000000000a"}';
create temporary table g3 as select public.create_generation('e1071000-0000-4000-8000-00000000000a', null, 'fake-voice',
  '{"prompt":"bad words","voice":"Test C"}', repeat('e', 64), gen_random_uuid()) as r;
reset role;
create temporary table c3 as select * from public.claim_next_task(array['generate'], 300)
  where payload->>'generation_id' = (select r->'generation'->>'id' from g3);
select ok(
  public.complete_generation((select id from c3), (select attempt_id from c3),
    'e1070000-0000-4000-8000-00000000000a/e1071000-0000-4000-8000-00000000000a/gen-' || (select r->'generation'->>'id' from g3) || '.m4a',
    'bad.m4a', 1, null, null, 1, '[{"text":"bad","start":2,"end":1}]'),
  'mốc chữ hỏng không làm hỏng lượt sinh'
);
select ok(
  (select words is null from public.media_assets
     where id = (select media_asset_id from public.generations where id = (select (r->'generation'->>'id')::uuid from g3))),
  'mốc chữ hỏng bị bỏ'
);

-- quyền: người dùng không gọi được bản mới của RPC worker
set local role authenticated;
select throws_ok(
  $$ select public.complete_generation(gen_random_uuid(), gen_random_uuid(), 'a', 'b', 1, 1, 1, 1, '[]') $$,
  '42501', null, 'người dùng không chốt được'
);

select * from finish();
rollback;
