-- 20261025090000: New edit — project trống không cần video, chỉ chủ thấy, worker không nhặt.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(8);

insert into auth.users (id, email) values
  ('e1230000-0000-4000-8000-00000000000a', 'blank-a@test.local'),
  ('e1230000-0000-4000-8000-00000000000b', 'blank-b@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1230000-0000-4000-8000-00000000000a"}';

create temp table made as select public.create_blank_edit('Launch teaser', '1:1') as clip_id;
select is((select kind from public.clips where id = (select clip_id from made)), 'blank', 'clip blank');
select is(
  (select j.kind || ':' || j.status || ':' || j.aspect || ':' || j.title from public.jobs j join public.clips c on c.job_id = j.id where c.id = (select clip_id from made)),
  'edit:done:1:1:Launch teaser', 'job edit, xong ngay, đúng khung và tên');
create temp table unnamed as select public.create_blank_edit(null, '9:16') as clip_id;
select is((select hook from public.clips where id = (select clip_id from unnamed)), 'Untitled edit', 'không đặt tên thì "Untitled edit"');
select throws_ok($$ select public.create_blank_edit('x', '4:3') $$, '22023', 'Choose a frame: 9:16, 1:1 or 16:9.', 'khung lạ bị từ chối');
select is((select count(*)::int from public.clips where id = (select clip_id from made)), 1, 'chủ đọc được clip (RLS)');
select is((select count(*)::int from public.list_projects() where kind = 'edit'), 0, 'My projects không liệt kê bản New edit');

set local request.jwt.claims = '{"sub":"e1230000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.clips where id = (select clip_id from made)), 0, 'người khác không thấy (RLS)');

reset role;
select throws_ok($$ insert into public.jobs (user_id, kind, source_url) values ('e1230000-0000-4000-8000-00000000000a', 'edit', 'https://youtu.be/x') $$,
  '23514', null, 'job edit không mang nguồn mạng');

select * from finish();
rollback;
