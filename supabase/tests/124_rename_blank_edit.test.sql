-- 20261026090000: đổi tên bản New edit — chỉ chủ, chỉ bản blank, tên không rỗng.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(5);

insert into auth.users (id, email) values
  ('e1240000-0000-4000-8000-00000000000a', 'rn-a@test.local'),
  ('e1240000-0000-4000-8000-00000000000b', 'rn-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1241000-0000-4000-8000-00000000000a', 'e1240000-0000-4000-8000-00000000000a', 'storage://e1240000-0000-4000-8000-00000000000a/talk.mp4', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, source_start, source_end) values
  ('e1242000-0000-4000-8000-00000000000a', 'e1241000-0000-4000-8000-00000000000a', 0, 'Hook', 0, 30, 0, 30);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1240000-0000-4000-8000-00000000000a"}';
create temp table made as select public.create_blank_edit(null, '9:16') as clip_id;

select is(public.rename_blank_edit((select clip_id from made), '  Launch teaser  '), 'Launch teaser', 'đổi tên, bỏ khoảng trắng hai đầu');
select is((select j.title || '|' || c.hook from public.clips c join public.jobs j on j.id = c.job_id where c.id = (select clip_id from made)), 'Launch teaser|Launch teaser', 'job và clip cùng đổi');
select throws_ok($$ select public.rename_blank_edit((select clip_id from made), '   ') $$, '22023', 'Give the edit a name.', 'tên rỗng bị từ chối');
select throws_ok($$ select public.rename_blank_edit('e1242000-0000-4000-8000-00000000000a', 'x') $$, '22023', null, 'clip cắt từ video không đổi tên ở đây');

set local request.jwt.claims = '{"sub":"e1240000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.rename_blank_edit((select clip_id from made), 'mine') $$, 'P0002', null, 'người khác không đổi được');

select * from finish();
rollback;
