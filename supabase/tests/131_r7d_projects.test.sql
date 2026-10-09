-- 20261102090000 (R7d): bảng projects — mỗi đường tạo project ghi đúng một hàng,
-- thư viện đọc từ đó, người khác không thấy, người dùng không tự ghi được.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(11);

insert into auth.users (id, email) values
  ('e1310000-0000-4000-8000-00000000000a', 'r7d-a@test.local'),
  ('e1310000-0000-4000-8000-00000000000b', 'r7d-b@test.local');
insert into public.credit_ledger (user_id, delta, reason) values ('e1310000-0000-4000-8000-00000000000a', 50, 'test grant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1310000-0000-4000-8000-00000000000a"}';

create temporary table made as
  select (public.create_clip_job('https://youtube.com/watch?v=r7dclip0001', 3, 'auto', null, 'clip', '9:16', 'auto', true, 'bold', true)).id as clip_job;
alter table made add column blank_clip uuid, add column pack jsonb;
update made set blank_clip = public.create_blank_edit('Launch teaser', '9:16');
update made set pack = public.create_video_pack('https://youtube.com/watch?v=r7dpack0001', true, 3);

select is((select kind from public.projects where job_id = (select clip_job from made)), 'clip', 'create_clip_job → project clip');
select is((select p.kind from public.projects p join public.clips c on c.job_id = p.job_id where c.id = (select blank_clip from made)),
  'edit', 'create_blank_edit → project edit');
select is((select kind from public.projects where job_id = ((select pack from made) -> 'job' ->> 'id')::uuid),
  'video_pack', 'create_video_pack → project video_pack');
select is((select count(*)::int from public.projects), 3, 'mỗi lượt tạo đúng một hàng (người dùng chỉ thấy hàng của mình)');

select is(
  (select array_agg(id order by id) from public.list_projects()),
  (select array_agg(job_id order by job_id) from public.projects where kind in ('clip', 'video_pack')),
  'thư viện = clip + gói video, không có New edit trống'
);
select is((select count(*)::int from public.list_projects(null, null, 'nothing-matches', 24)), 0, 'tìm theo tên vẫn chạy');

select throws_ok(
  $$ insert into public.projects (user_id, job_id, kind) values ('e1310000-0000-4000-8000-00000000000a', (select clip_job from made), 'clip') $$,
  '42501', null, 'người dùng không tự ghi project'
);
select throws_ok(
  $$ update public.projects set kind = 'edit' $$,
  '42501', null, 'người dùng không tự đổi project'
);

set local request.jwt.claims = '{"sub":"e1310000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.projects), 0, 'người khác không thấy project của A');
select is((select count(*)::int from public.list_projects()), 0, 'thư viện của B rỗng');

reset role;
delete from public.jobs where id = (select clip_job from made);
select is((select count(*)::int from public.projects where job_id = (select clip_job from made)), 0, 'xoá job thì xoá project');

select * from finish();
rollback;
