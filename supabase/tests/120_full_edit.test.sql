-- 20261022090000: Edit full video — chỉ upload, idempotent, trần thời lượng, worker công bố một giao dịch.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(13);

insert into auth.users (id, email) values
  ('e1200000-0000-4000-8000-00000000000a', 'full-a@test.local'),
  ('e1200000-0000-4000-8000-00000000000b', 'full-b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status, media_manifest) values
  ('e1201000-0000-4000-8000-00000000000a', 'e1200000-0000-4000-8000-00000000000a', 'storage://e1200000-0000-4000-8000-00000000000a/talk.mp4', 600, 'done', '{"masters":{}}'),
  ('e1201100-0000-4000-8000-00000000000a', 'e1200000-0000-4000-8000-00000000000a', 'https://youtu.be/abc', 600, 'done', '{}'),
  ('e1201200-0000-4000-8000-00000000000a', 'e1200000-0000-4000-8000-00000000000a', 'storage://e1200000-0000-4000-8000-00000000000a/long.mp4', 5400, 'done', '{}'),
  ('e1201300-0000-4000-8000-00000000000a', 'e1200000-0000-4000-8000-00000000000a', 'storage://e1200000-0000-4000-8000-00000000000a/run.mp4', 600, 'running', '{}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1200000-0000-4000-8000-00000000000a"}';

create temp table first as select public.create_full_edit('e1201000-0000-4000-8000-00000000000a') as v;
select is((select (v ->> 'ready')::boolean from first), false, 'lần đầu: chưa sẵn sàng, có task chuẩn bị');
select isnt((select v ->> 'task_id' from first), null, '...mang id task');
select is((select kind || ':' || idx || ':' || end_seconds from public.clips where id = (select (v ->> 'clip_id')::uuid from first)), 'full:-1:600', 'clip full phủ cả video');
select is((select public.create_full_edit('e1201000-0000-4000-8000-00000000000a') ->> 'task_id'), (select v ->> 'task_id' from first), 'gọi lại: cùng clip, cùng task');
select throws_ok($$ select public.create_full_edit('e1201100-0000-4000-8000-00000000000a') $$, '22023', null, 'job link YouTube bị từ chối (luật 3)');
select throws_ok($$ select public.create_full_edit('e1201200-0000-4000-8000-00000000000a') $$, '22023', 'Full-video editing supports videos up to 15 minutes.', 'quá trần thời lượng');
select throws_ok($$ select public.create_full_edit('e1201300-0000-4000-8000-00000000000a') $$, 'P0001', null, 'job chưa xong');

set local request.jwt.claims = '{"sub":"e1200000-0000-4000-8000-00000000000b"}';
select throws_ok($$ select public.create_full_edit('e1201000-0000-4000-8000-00000000000a') $$, 'P0002', 'Project not found.', 'người khác không mở được');
select throws_ok($$ select public.complete_full_edit(gen_random_uuid(), null, '{}', repeat('a', 64), '{"object":"x"}') $$, '42501', null, 'người dùng không gọi được RPC của worker');

-- Worker: claim rồi công bố.
reset role;
update public.tasks set status = 'running', attempt_id = 'e1209000-0000-4000-8000-00000000000a' where id = (select (v ->> 'task_id')::uuid from first);
select ok(public.complete_full_edit((select (v ->> 'task_id')::uuid from first), 'e1209000-0000-4000-8000-00000000000a',
  '{"source_start":0,"source_end":600}', repeat('b', 64),
  '{"bucket":"renders","object":"u/c/master/a.mp4","width":1920,"height":1080,"duration":600,"offset":0}'), 'worker công bố');
select is((select media_manifest -> 'masters' -> (select v ->> 'clip_id' from first) ->> 'object' from public.jobs where id = 'e1201000-0000-4000-8000-00000000000a'), 'u/c/master/a.mp4', 'master ghi vào manifest');
select ok((select settings is not null from public.clips where id = (select (v ->> 'clip_id')::uuid from first)), 'có settings gốc');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1200000-0000-4000-8000-00000000000a"}';
select is((select (public.create_full_edit('e1201000-0000-4000-8000-00000000000a') ->> 'ready')::boolean), true, 'sau khi công bố: sẵn sàng');

select * from finish();
rollback;
