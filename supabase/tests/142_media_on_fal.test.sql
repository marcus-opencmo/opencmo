-- 20261112090000: generated media routes through fal; ids, prices and limits stay the same.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(5);

select is(
  (select count(*)::int from public.ai_models
   where id in ('gemini-image', 'gemini-video', 'gemini-voice', 'elevenlabs-voice', 'elevenlabs-sfx', 'elevenlabs-music')
     and provider = 'fal'),
  6, 'the six Gemini and ElevenLabs models route to fal'
);
select is(
  (select count(*)::int from public.ai_models where provider in ('gemini', 'elevenlabs')),
  0, 'no model calls Gemini or ElevenLabs directly'
);
select is(
  public.ai_price((select x from public.ai_models x where id = 'elevenlabs-voice'), '{"prompt":"Hello there","voice":"Aria"}'),
  5, 'voice keeps its price'
);
select lives_ok(
  $$ select public.ai_check_spec((select x from public.ai_models x where id = 'gemini-video'), '{"prompt":"waves","aspectRatio":"9:16","duration":8}') $$,
  'Veo keeps its limits'
);
select throws_ok(
  $$ select public.ai_check_spec((select x from public.ai_models x where id = 'elevenlabs-sfx'), '{"prompt":"a whoosh","duration":30}') $$,
  '22023', 'Sounds are 1 to 22 seconds long.', 'sound effects keep their limits'
);

select * from finish();
rollback;
