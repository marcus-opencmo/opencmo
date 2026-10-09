-- 20261019090000: model giả có khả năng như model thật (frame, độ phân giải, tham chiếu).
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(5);

select is((select limits->>'maxReferences' from public.ai_models where id = 'fake-image'), '2', 'ảnh giả nhận 2 tham chiếu');
select is((select (limits->>'firstFrame')::boolean and (limits->>'lastFrame')::boolean from public.ai_models where id = 'fake-video'), true, 'video giả nhận frame đầu + cuối');
select is((select limits->'resolutions' from public.ai_models where id = 'fake-video'), '["480p","720p"]'::jsonb, 'video giả có hai độ phân giải');
select is(public.ai_price((select m from public.ai_models m where id = 'fake-video'),
  '{"prompt":"x","aspectRatio":"9:16","duration":5,"resolution":"720p"}'), 10, '720p nhân hệ số 2');
select is(public.ai_price((select m from public.ai_models m where id = 'fake-video'),
  '{"prompt":"x","aspectRatio":"1:1","duration":5}'), 5, 'không chọn độ phân giải: giá cũ');

select * from finish();
rollback;
