-- 20261104090000 (G2): Veo nhận ảnh đầu, chưa nhận khung cuối.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(3);

select is((select limits->'firstFrame' from public.ai_models where id = 'gemini-video'), 'true'::jsonb, 'Veo nhận ảnh đầu');
select is((select limits->'lastFrame' from public.ai_models where id = 'gemini-video'), null, 'Veo chưa nhận khung cuối (bắt buộc 8 s)');
select is((select limits->'durations' from public.ai_models where id = 'gemini-video'), '[4,6,8]'::jsonb, 'độ dài giữ nguyên');

select * from finish();
rollback;
