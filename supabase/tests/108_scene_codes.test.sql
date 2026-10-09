-- Code Scenes (20261010090000): code cảnh lưu theo sha256, chỉ chủ đọc được,
-- và spec `template: "code"` chỉ nhận code_ref của chính người gọi.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1080000-0000-4000-8000-00000000000a', 'code-a@test.local'),
  ('e1080000-0000-4000-8000-00000000000b', 'code-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1081000-0000-4000-8000-00000000000a', 'e1080000-0000-4000-8000-00000000000a', 'https://a', 600, 'done');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1080000-0000-4000-8000-00000000000a', 10, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1080000-0000-4000-8000-00000000000a"}';

select is(
  public.save_scene_code('return (t) => {};'),
  encode(sha256(convert_to('return (t) => {};', 'UTF8')), 'hex'),
  'trả sha256 hex của code'
);
select is(public.save_scene_code('return (t) => {};'), public.save_scene_code('return (t) => {};'), 'cùng code cùng hash');
select is((select count(*) from public.scene_codes)::int, 1, 'không ghi lần hai');
select throws_ok($$ select public.save_scene_code('   ') $$, '22023', 'Write the scene code first.', 'code rỗng bị chặn');
select throws_ok($$ select public.save_scene_code(repeat('x', 32001)) $$, '22023',
  'The scene code is longer than 32000 characters.', 'code quá dài bị chặn');
select throws_ok($$ insert into public.scene_codes (user_id, hash, code)
  values ('e1080000-0000-4000-8000-00000000000a', repeat('c', 64), 'x') $$,
  '42501', null, 'không ghi thẳng vào bảng');

select is(
  (select (public.create_generation('e1081000-0000-4000-8000-00000000000a', null, 'studio-3d',
    jsonb_build_object('prompt', 'Staircase', 'aspectRatio', '1:1', 'duration', 6, 'scene',
      jsonb_build_object('template', 'code', 'code_ref', encode(sha256(convert_to('return (t) => {};', 'UTF8')), 'hex'))),
    repeat('d', 64), gen_random_uuid())->'generation'->>'credits_reserved')::int),
  1, 'cảnh code với code_ref của mình: tạo được, giữ 1 credit'
);
select throws_ok(
  $$ select public.create_generation('e1081000-0000-4000-8000-00000000000a', null, 'studio-3d',
       jsonb_build_object('prompt', 'x', 'aspectRatio', '1:1', 'duration', 6, 'scene',
         jsonb_build_object('template', 'code', 'code_ref', repeat('e', 64))),
       repeat('e', 64), gen_random_uuid()) $$,
  '22023', 'This 3D scene code was not found. Preview it again.', 'code_ref không tồn tại bị chặn'
);
select throws_ok(
  $$ select public.create_generation('e1081000-0000-4000-8000-00000000000a', null, 'studio-3d',
       '{"prompt":"x","aspectRatio":"1:1","duration":6,"scene":{"template":"code"}}', repeat('f', 64), gen_random_uuid()) $$,
  '22023', 'This 3D scene code was not found. Preview it again.', 'thiếu code_ref bị chặn'
);

-- Người B: không đọc được code của A, không render được bằng hash của A.
set local request.jwt.claims = '{"sub":"e1080000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.scene_codes)::int, 0, 'B không thấy code của A');

select * from finish();
rollback;
