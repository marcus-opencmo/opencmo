-- P5 fix (20261231130000): a slideshow or post image in a job of its own takes the watermark from the founder's plan;
-- a post image in the source video's job keeps that job's flag.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(4);

insert into auth.users (id, email) values
  ('e2250000-0000-4000-8000-00000000000a', 'p5wm-paid@test.local'),
  ('e2250000-0000-4000-8000-00000000000b', 'p5wm-free@test.local');
update public.profiles set plan = 'starter' where id = 'e2250000-0000-4000-8000-00000000000a';
insert into public.jobs (id, user_id, source_url, duration_seconds, status, watermark) values
  ('e2251000-0000-4000-8000-00000000000a', 'e2250000-0000-4000-8000-00000000000a', 'https://a', 60, 'done', true);
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2252000-0000-4000-8000-00000000000a', 'e2251000-0000-4000-8000-00000000000a', 0, 'Old upload', 0, 60, 'full');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.watermark(p text) returns boolean language sql as $$
  select j.watermark from public.clips c join public.jobs j on j.id = c.job_id where c.id = (select id from t where name = p)
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2250000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
insert into t select 'paid_show', public.create_slideshow('Paid', '9:16');
insert into t select 'paid_image', public.create_post_image_edit('Paid image', '1:1', null);
insert into t select 'source_image', public.create_post_image_edit('From the old upload', '1:1', 'e2252000-0000-4000-8000-00000000000a');
set local request.jwt.claims = '{"sub":"e2250000-0000-4000-8000-00000000000b","role":"authenticated"}';
insert into t select 'free_show', public.create_slideshow('Free', '9:16');
reset role;

select is(pg_temp.watermark('paid_show'), false, 'a paid founder''s slideshow has no watermark');
select is(pg_temp.watermark('paid_image'), false, 'nor their post image in a job of its own');
select is(pg_temp.watermark('free_show'), true, 'a free founder''s slideshow has it');
select is(pg_temp.watermark('source_image'), true, 'a post image in the source video''s job keeps that job''s flag');

select * from finish();
rollback;
