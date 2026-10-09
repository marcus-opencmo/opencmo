-- 20261105090000 (G3): model SFX + nhạc ElevenLabs, kiểm độ dài theo từng model.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(6);

create temporary table m as select x from public.ai_models x where id in ('elevenlabs-sfx', 'elevenlabs-music');

select is((select count(*)::int from m), 2, 'hai model âm thanh có trong catalog');
select is(public.ai_price((select x from m where (x).id = 'elevenlabs-music'), '{"prompt":"calm lo-fi","duration":45}'), 3, 'nhạc: giá một lượt');
select lives_ok($$ select public.ai_check_spec((select x from m where (x).id = 'elevenlabs-sfx'), '{"prompt":"a whoosh","duration":2}') $$, 'SFX 2 s hợp lệ');
select throws_ok($$ select public.ai_check_spec((select x from m where (x).id = 'elevenlabs-sfx'), '{"prompt":"a whoosh","duration":30}') $$, '22023', 'Sounds are 1 to 22 seconds long.', 'SFX quá 22 s');
select lives_ok($$ select public.ai_check_spec((select x from m where (x).id = 'elevenlabs-music'), '{"prompt":"calm lo-fi","duration":60}') $$, 'nhạc 60 s hợp lệ');
select throws_ok($$ select public.ai_check_spec((select x from m where (x).id = 'elevenlabs-music'), '{"prompt":"calm lo-fi","duration":5}') $$, '22023', 'Sounds are 10 to 60 seconds long.', 'nhạc ngắn hơn 10 s');

select * from finish();
rollback;
