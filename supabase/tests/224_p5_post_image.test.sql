-- P5 for B4 (20261231120000): the Post image squad's edit lives in the source video's job; its step waits on the
-- still; a done still for the document as it is becomes the post's `image` deliverable and finishes the order; a
-- failed still fails the order; only the founder's own post and video can be used.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(15);

insert into auth.users (id, email) values
  ('e2240000-0000-4000-8000-00000000000a', 'p5image@test.local'),
  ('e2240000-0000-4000-8000-00000000000b', 'p5image-other@test.local');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from t where name = p_name $$;

-- The founder's uploaded video and a post, and another founder's video.
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e2241000-0000-4000-8000-00000000000a', 'e2240000-0000-4000-8000-00000000000a', 'https://a', 60, 'done'),
  ('e2241000-0000-4000-8000-00000000000b', 'e2240000-0000-4000-8000-00000000000b', 'https://b', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2242000-0000-4000-8000-00000000000a', 'e2241000-0000-4000-8000-00000000000a', 0, 'Launch', 0, 60, 'full'),
  ('e2242000-0000-4000-8000-00000000000b', 'e2241000-0000-4000-8000-00000000000b', 0, 'Theirs', 0, 60, 'full');
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2243000-0000-4000-8000-00000000000a', 'e2240000-0000-4000-8000-00000000000a', 'post', 'x', current_date, 'Launch', 'in_review', '{"text":"We shipped."}'),
  ('e2243000-0000-4000-8000-00000000000b', 'e2240000-0000-4000-8000-00000000000b', 'post', 'x', current_date, 'Theirs', 'in_review', '{"text":"Theirs."}');
create temp table root as select * from public.work_order_week_root('e2240000-0000-4000-8000-00000000000a');
insert into t select 'order', id from public.work_order_create('e2240000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_post_image', 'Image for the launch post');
insert into t select 'order2', id from public.work_order_create('e2240000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_post_image', 'Second image');
select public.work_order_move(pg_temp.id('order'), 'running');
grant select on root to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2240000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.create_post_image_edit('x', '1:1', null) $$, '42501', null, 'only Studio''s team makes the edit');
set local request.jwt.claims = '{"sub":"e2240000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
insert into t select 'edit', public.create_post_image_edit('Launch image', '1:1', 'e2242000-0000-4000-8000-00000000000a');
insert into t select 'edit2', public.create_post_image_edit('Second image', '16:9', 'e2242000-0000-4000-8000-00000000000a');
insert into t select 'fresh', public.create_post_image_edit('From a page', '1:1', null);
select throws_ok($$ select public.create_post_image_edit('x', '1:1', 'e2242000-0000-4000-8000-00000000000b') $$, null, null,
  'never in another founder''s job');
reset role;
select is((select job_id from public.clips where id = pg_temp.id('edit')), 'e2241000-0000-4000-8000-00000000000a'::uuid,
  'the edit lives in the source video''s job, so its frames are usable');
select is((select array_agg(idx order by idx) from public.clips where job_id = 'e2241000-0000-4000-8000-00000000000a'), array[-2, -1, 0],
  'each edit takes its own index');
select isnt((select job_id from public.clips where id = pg_temp.id('fresh')), 'e2241000-0000-4000-8000-00000000000a'::uuid,
  'without a source, a job of its own');

-- The still of each edit, of the document as it is.
insert into public.editor_projects (clip_id, document) values
  (pg_temp.id('edit'), '{"version":1,"stage":{"name":"image"}}'), (pg_temp.id('edit2'), '{"version":1,"stage":{"name":"image2"}}');
insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash)
select v.id, 'e2240000-0000-4000-8000-00000000000a', 'render_stills', c.id, c.job_id, 'queued', gen_random_uuid(), '{}',
  public.editor_document_hash(p.document)
from (values ('e2244000-0000-4000-8000-00000000000a'::uuid, 'edit'), ('e2244000-0000-4000-8000-00000000000b'::uuid, 'edit2')) v(id, clip)
join public.clips c on c.id = pg_temp.id(v.clip) join public.editor_projects p on p.clip_id = c.id;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2240000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select throws_ok($$ select public.studio_post_image_rendering(pg_temp.id('order'), pg_temp.id('edit'), 'e2243000-0000-4000-8000-00000000000b',
  'e2244000-0000-4000-8000-00000000000a') $$, 'P0002', 'Post not found.', 'only the founder''s own post');
select throws_ok($$ select public.studio_post_image_rendering(pg_temp.id('order'), 'e2242000-0000-4000-8000-00000000000a',
  'e2243000-0000-4000-8000-00000000000a', 'e2244000-0000-4000-8000-00000000000a') $$, '22023', 'A post image is made in its own edit.',
  'never on the founder''s video itself');
insert into t select 'step', public.studio_post_image_rendering(pg_temp.id('order'), pg_temp.id('edit'), 'e2243000-0000-4000-8000-00000000000a',
  'e2244000-0000-4000-8000-00000000000a');
insert into t select 'step2', public.studio_post_image_rendering(pg_temp.id('order2'), pg_temp.id('edit2'), 'e2243000-0000-4000-8000-00000000000a',
  'e2244000-0000-4000-8000-00000000000b');
reset role;
select is((select kind || ' ' || status || ' ' || price_credits from public.studio_steps where id = pg_temp.id('step')), 'post_image running 0',
  'the step waits on its still, free');
select is((select count(*)::int from public.approvals where ref_id = pg_temp.id('step')), 0, 'and raises no card of its own');

-- The still is done: the post's image, and the order is done.
update public.tasks set status = 'done', finished_at = now() where id = 'e2244000-0000-4000-8000-00000000000a';
select is((select kind || ' ' || ref_kind || ' ' || status from public.deliverables where post_id = 'e2243000-0000-4000-8000-00000000000a'),
  'image clip ready', 'the image is a deliverable of its post');
select is((select ref_id from public.deliverables where post_id = 'e2243000-0000-4000-8000-00000000000a'), pg_temp.id('edit'), 'pointing at its edit');
select is((select status from public.work_orders where id = pg_temp.id('order')), 'done', 'the order is done');
select throws_ok($$ insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status)
  values ('e2240000-0000-4000-8000-00000000000a', pg_temp.id('order'), 'image', 'clip', pg_temp.id('fresh'), 'ready') $$,
  '23514', null, 'an image always names its post');

-- A failed still fails its order with the reason.
update public.tasks set status = 'failed', error = 'The frame could not be read.' where id = 'e2244000-0000-4000-8000-00000000000b';
select is((select status || ' ' || (error->>'message') from public.work_orders where id = pg_temp.id('order2')),
  'failed The frame could not be read.', 'a failed still fails the order with its reason');
select is((select count(*)::int from public.studio_steps_claim()), 0, 'the runner never takes a post image step');

select * from finish();
rollback;
