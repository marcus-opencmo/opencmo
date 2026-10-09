-- 20261106090000 (G4): upscale = sửa video không prompt; giá theo giây × độ phân giải.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(3);

select is((select (limits->>'upscale')::boolean and (limits->>'sourceVideo')::boolean from public.ai_models where id = 'fal-seedvr-upscale'), true, 'upscale nhận video nguồn');
select is(public.ai_price((select m from public.ai_models m where id = 'fal-seedvr-upscale'), '{"prompt":"Upscale","aspectRatio":"9:16","duration":5,"resolution":"2160p"}'), 30, '4K: 2 credit/giây × 3');
select is(public.ai_price((select m from public.ai_models m where id = 'fal-seedvr-upscale'), '{"prompt":"Upscale","aspectRatio":"9:16","duration":5,"resolution":"1080p"}'), 10, '1080p: 2 credit/giây');

select * from finish();
rollback;
