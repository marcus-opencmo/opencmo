-- Security regressions that must stay closed before D4 starts.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(5);

insert into auth.users (id, email) values
  ('d5000000-0000-4000-8000-00000000000a', 'security-a@test.local'),
  ('d5000000-0000-4000-8000-00000000000b', 'security-b@test.local');

insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('d5100000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-00000000000a', 'https://a', 60, 'done'),
  ('d5100000-0000-4000-8000-00000000000b', 'd5000000-0000-4000-8000-00000000000b', 'https://b', 60, 'done');

insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('d5200000-0000-4000-8000-00000000000a', 'd5100000-0000-4000-8000-00000000000a', 0, 0, 10, 0, 10);

update public.clips set settings = '{}', settings_hash = repeat('a', 64)
where id = 'd5200000-0000-4000-8000-00000000000a';

insert into public.upload_reservations(user_id,bucket,object_name,declared_size,content_type,project_id) values
  ('d5000000-0000-4000-8000-00000000000a','media',
   'd5000000-0000-4000-8000-00000000000a/d5100000-0000-4000-8000-00000000000a/d5400000-0000-4000-8000-00000000000a.mp4',100,'video/mp4','d5100000-0000-4000-8000-00000000000a'),
  ('d5000000-0000-4000-8000-00000000000b','media',
   'd5000000-0000-4000-8000-00000000000b/d5100000-0000-4000-8000-00000000000b/d5400000-0000-4000-8000-00000000000b.mp4',100,'video/mp4','d5100000-0000-4000-8000-00000000000b');
insert into storage.objects(bucket_id,name,metadata) values
  ('media','d5000000-0000-4000-8000-00000000000a/d5100000-0000-4000-8000-00000000000a/d5400000-0000-4000-8000-00000000000a.mp4','{"size":100,"mimetype":"video/mp4"}'),
  ('media','d5000000-0000-4000-8000-00000000000b/d5100000-0000-4000-8000-00000000000b/d5400000-0000-4000-8000-00000000000b.mp4','{"size":100,"mimetype":"video/mp4"}');

create temporary table security_results (name text primary key, value uuid);
grant select, insert on security_results to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-00000000000a"}';
insert into security_results values (
  'task_a',
  (public.register_media_asset(
    'd5100000-0000-4000-8000-00000000000a',
    'media/d5000000-0000-4000-8000-00000000000a/d5100000-0000-4000-8000-00000000000a/d5400000-0000-4000-8000-00000000000a.mp4',
    'a.mp4',
    'd5500000-0000-4000-8000-000000000000'
  )->>'task_id')::uuid
);

set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-00000000000b"}';
select throws_ok(
  $$ select public.register_media_asset(
    'd5100000-0000-4000-8000-00000000000b',
    'media/d5000000-0000-4000-8000-00000000000b/d5100000-0000-4000-8000-00000000000b/d5400000-0000-4000-8000-00000000000b.mp4',
    'b.mp4',
    'd5500000-0000-4000-8000-000000000000'
  ) $$,
  '22023', 'That request id was already used for a different media file.',
  'register_media_asset rejects a cross-tenant request id'
);

reset role;
select is(
  (select user_id from public.tasks where id = (select value from security_results where name = 'task_a')),
  'd5000000-0000-4000-8000-00000000000a'::uuid,
  'the original task remains owned by its creator'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"d5000000-0000-4000-8000-00000000000a"}';
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, metadata) values
    ('sources', 'd5000000-0000-4000-8000-00000000000a/unreserved.mp4',
     '{"size":100,"mimetype":"video/mp4"}') $$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'source uploads require a database reservation'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, metadata) values
    ('media', 'd5000000-0000-4000-8000-00000000000a/d5100000-0000-4000-8000-00000000000a/unreserved.mp4',
     '{"size":100,"mimetype":"video/mp4"}') $$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'media uploads require a database reservation'
);

reset role;
select ok(
  to_regprocedure('public.set_project_pinned(uuid,boolean)') is not null,
  'favorite has an ownership-checked RPC'
);

select * from finish();
rollback;
