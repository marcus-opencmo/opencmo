-- 20261104100000 (G2): model sửa video — video nguồn bắt buộc, của chính người gọi.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('e1340000-0000-4000-8000-00000000000a', 'edit-a@test.local'),
  ('e1340000-0000-4000-8000-00000000000b', 'edit-b@test.local');
insert into storage.objects (bucket_id, name) values
  ('media', 'e1340000-0000-4000-8000-00000000000a/j/clip.mp4'),
  ('media', 'e1340000-0000-4000-8000-00000000000b/j/clip.mp4');

select is((select (limits->>'sourceVideo')::boolean from public.ai_models where id = 'fal-kling-edit'), true, 'Kling O1 Edit nhận video nguồn');
select is(public.ai_price((select m from public.ai_models m where id = 'fal-kling-edit'),
  '{"prompt":"x","aspectRatio":"9:16","duration":6}'), 24, 'giá 4 credit/giây cắt');

set local request.jwt.claims = '{"sub":"e1340000-0000-4000-8000-00000000000a"}';

create temporary table edit_model as select m from public.ai_models m where id = 'fake-edit';

select lives_ok(
  $$ select public.ai_check_spec((select m from edit_model), '{"prompt":"make it night","aspectRatio":"9:16","duration":5,"sourceVideo":"e1340000-0000-4000-8000-00000000000a/j/clip.mp4","sourceStart":2.5}') $$,
  'video của mình: hợp lệ'
);
select throws_ok(
  $$ select public.ai_check_spec((select m from edit_model), '{"prompt":"x","aspectRatio":"9:16","duration":5,"sourceStart":0}') $$,
  '22023', 'Choose a video from your library to edit.', 'thiếu video nguồn'
);
select throws_ok(
  $$ select public.ai_check_spec((select m from edit_model), '{"prompt":"x","aspectRatio":"9:16","duration":5,"sourceVideo":"e1340000-0000-4000-8000-00000000000b/j/clip.mp4","sourceStart":0}') $$,
  '22023', 'Choose a video from your library to edit.', 'video của người khác'
);
select throws_ok(
  $$ select public.ai_check_spec((select m from edit_model), '{"prompt":"x","aspectRatio":"9:16","duration":5,"sourceVideo":"e1340000-0000-4000-8000-00000000000a/j/clip.mp4","sourceStart":-1}') $$,
  '22023', 'Invalid generation request.', 'giây bắt đầu âm'
);
select throws_ok(
  $$ select public.ai_check_spec((select m from edit_model), '{"prompt":"x","aspectRatio":"9:16","duration":11,"sourceVideo":"e1340000-0000-4000-8000-00000000000a/j/clip.mp4","sourceStart":0}') $$,
  '22023', null, 'quá 10 giây'
);
select throws_ok(
  $$ select public.ai_check_spec((select m from public.ai_models m where id = 'fake-video'), '{"prompt":"x","aspectRatio":"9:16","duration":5,"sourceVideo":"e1340000-0000-4000-8000-00000000000a/j/clip.mp4"}') $$,
  '22023', 'This request has settings the model does not take.', 'model sinh thường không nhận video nguồn'
);

select * from finish();
rollback;
