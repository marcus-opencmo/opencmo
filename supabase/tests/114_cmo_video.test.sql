-- Tầng CMO đợt 3c (20261016090000): W5 gói video — xác nhận chính chủ đi cùng job,
-- một gói đang làm mỗi lúc, hoãn lượt khi clip chưa xong, người dùng tự duyệt/bỏ.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

insert into auth.users (id, email) values
  ('e1140000-0000-4000-8000-00000000000a', 'video-a@test.local'),
  ('e1140000-0000-4000-8000-00000000000b', 'video-b@test.local');
insert into public.credit_ledger(user_id, delta, reason) values
  ('e1140000-0000-4000-8000-00000000000a', 500, 'test grant'),
  ('e1140000-0000-4000-8000-00000000000b', 500, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1140000-0000-4000-8000-00000000000a"}';

-- Link chưa xác nhận: từ chối, KHÔNG tạo job nào.
select throws_ok($$ select public.create_video_pack('https://youtu.be/mine-1', false) $$,
  '22023', 'Confirm that this is your own video.', 'link phải có xác nhận chính chủ');
select is((select count(*) from public.jobs), 0::bigint, 'không có job khi bị từ chối');

create temp table p1 as select public.create_video_pack('https://youtu.be/mine-1', true, 5) as v;
grant select on p1 to authenticated, service_role;
select is((select count(*) from public.jobs), 1::bigint, 'tạo đúng một job');
select is((select source from public.video_ownership), 'link', 'xác nhận ghi cùng job');
select is((select url from public.video_ownership), 'https://youtu.be/mine-1', 'giữ link đã xác nhận');
select is((select job_id::text from public.video_ownership), (select v->'job'->>'id' from p1), 'xác nhận trỏ đúng job');
select is((select kind from public.cmo_runs where id = (select (v->'run'->>'id')::uuid from p1)), 'video_pack', 'W5 vào hàng đợi');
select is((select input->>'job_id' from public.cmo_runs where kind = 'video_pack'), (select v->'job'->>'id' from p1), 'lượt mang job_id');
select is((select credits from public.cmo_runs where kind = 'video_pack'), 1, 'W5 giữ 1 credit');

select throws_ok($$ select public.create_video_pack('https://youtu.be/mine-2', true) $$,
  'P0001', 'Your last video pack is still being made.', 'một gói đang làm mỗi lúc');

select throws_ok($$ insert into public.video_packs (user_id, job_id, clips, captions)
    values ('e1140000-0000-4000-8000-00000000000a', (select (v->'job'->>'id')::uuid from p1), '[{"clip_id":"x"}]', '{}') $$,
  '42501', null, 'không insert thẳng video_packs được');

-- ------------------------------------------------------------ hoãn lượt
reset role;
set local role service_role;
create temp table c1 as select * from public.claim_cmo_run((select (v->'run'->>'id')::uuid from p1));
select is((select attempt from c1), 1, 'nhận lượt W5');
select ok(public.cmo_defer_run((select id from c1), 1, 60, '[{"tool":"wait_clips","label":"Waiting","status":"running"}]'), 'hoãn được');
select is((select status from public.cmo_runs where id = (select id from c1)), 'queued', 'về hàng đợi');
select is((select attempt from public.cmo_runs where id = (select id from c1)), 0, 'lần chờ không tính vào trần');
select ok((select not_before > now() from public.cmo_runs where id = (select id from c1)), 'có mốc hoãn');
select is((public.claim_cmo_run((select id from c1))).id, null, 'chưa tới mốc thì không nhận');
update public.cmo_runs set not_before = now() - interval '1 second' where id = (select id from c1);
select is((public.claim_cmo_run((select id from c1))).attempt, 1, 'tới mốc thì nhận lại');

-- ------------------------------------------------------------ thẻ
create temp table pk as select * from public.cmo_save_video_pack(
  'e1140000-0000-4000-8000-00000000000a', (select id from c1), (select (v->'job'->>'id')::uuid from p1),
  '[{"clip_id":"c1","hook":"Stop chasing invoices","seconds":32,"score":88}]'::jsonb,
  '{"c1":{"tiktok":"Late payments? Do this.","shorts":"Stop chasing invoices"}}'::jsonb);
grant select on pk to authenticated;
select is((select status from pk), 'in_review', 'thẻ chờ duyệt');
select throws_ok($$ select public.cmo_save_video_pack('e1140000-0000-4000-8000-00000000000b', null,
    (select (v->'job'->>'id')::uuid from p1), '[{"clip_id":"c1"}]', '{}') $$,
  'P0002', 'That video is not in this account.', 'không gắn job của người khác');

-- ------------------------------------------------------------ người dùng quyết
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1140000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.video_packs), 0::bigint, 'B không thấy gói của A');
select throws_ok($$ select public.cmo_decide_video_pack((select id from pk), 'approved') $$,
  'P0002', 'Video pack not found.', 'B không duyệt được gói của A');

set local request.jwt.claims = '{"sub":"e1140000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select public.cmo_decide_video_pack((select id from pk), 'post') $$,
  '22023', 'Unknown action.', 'không có hành động đăng');
select is((public.cmo_decide_video_pack((select id from pk), 'approved', '[{"clip_id":"c1","task_id":"t1"}]')).status,
  'approved', 'duyệt');
select is((select exports->0->>'task_id' from public.video_packs where id = (select id from pk)), 't1', 'giữ task export');
select throws_ok($$ select public.cmo_decide_video_pack((select id from pk), 'dismissed') $$,
  'P0001', 'This video pack was already decided.', 'không quyết hai lần');

select * from finish();
rollback;
