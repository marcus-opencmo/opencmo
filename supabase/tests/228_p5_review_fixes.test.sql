-- P5 review fixes (20261231160000): a slideshow edited after its card renders again into a new card, approving only
-- fresh renders, cancelled renders settle, renaming a post image keeps the upload's name, CMO renders keep the
-- founder's daily exports, still exports count toward the export cap, and one
-- slideshow edit per order.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(19);

insert into auth.users (id, email) values ('e2280000-0000-4000-8000-00000000000a', 'p5fixes@test.local');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from t where name = p_name $$;
create function pg_temp.hash(p_clip uuid) returns text language sql as $$
  select public.editor_document_hash(document) from public.editor_projects where clip_id = p_clip $$;
-- A render of the slideshow as it is now, in the state the worker leaves it.
create function pg_temp.render(p_id uuid, p_kind text, p_clip uuid, p_status text) returns void language sql as $$
  insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash)
  select p_id, 'e2280000-0000-4000-8000-00000000000a', p_kind, c.id, c.job_id, p_status, gen_random_uuid(), '{}', pg_temp.hash(c.id)
  from public.clips c where c.id = p_clip $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
insert into t select 'clip', public.create_slideshow('Three cuts', '9:16');
insert into t select 'clip2', public.create_slideshow('Cancelled', '9:16');
reset role;
insert into public.editor_projects (clip_id, document) values
  (pg_temp.id('clip'), '{"version":1,"stage":{"name":"three cuts"}}'),
  (pg_temp.id('clip2'), '{"version":1,"stage":{"name":"cancelled"}}');
create temp table root as select * from public.work_order_week_root('e2280000-0000-4000-8000-00000000000a');
insert into t select 'order', id from public.work_order_create('e2280000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Three cuts');
insert into t select 'order2', id from public.work_order_create('e2280000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Cancelled');
select public.work_order_move(pg_temp.id('order'), 'running');
select public.work_order_move(pg_temp.id('order2'), 'running');
select pg_temp.render('e2283000-0000-4000-8000-00000000000a', 'render_document', pg_temp.id('clip'), 'done');
select pg_temp.render('e2283000-0000-4000-8000-00000000000b', 'render_stills', pg_temp.id('clip'), 'done');
select pg_temp.render('e2283000-0000-4000-8000-00000000000c', 'render_document', pg_temp.id('clip2'), 'queued');
select pg_temp.render('e2283000-0000-4000-8000-00000000000d', 'render_stills', pg_temp.id('clip2'), 'queued');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
insert into t select 'step', public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('clip'), '{}',
  '{"title":"Three cuts","slides":[{"text":"Cut by words","still_path":null,"seconds":3}]}',
  'e2283000-0000-4000-8000-00000000000a', 'e2283000-0000-4000-8000-00000000000b');
insert into t select 'step2', public.studio_slideshow_rendering(pg_temp.id('order2'), pg_temp.id('clip2'), '{}',
  '{"title":"Cancelled","slides":[{"text":"a","still_path":null,"seconds":3}]}',
  'e2283000-0000-4000-8000-00000000000c', 'e2283000-0000-4000-8000-00000000000d');
reset role;
insert into t select 'card', id from public.approvals where ref_id = pg_temp.id('step') and status = 'waiting';
select isnt(pg_temp.id('card'), null, 'both renders done: the slideshow card waits');

-- #3: a cancelled render settles its step and order instead of leaving them running.
update public.tasks set status = 'cancelled' where id = 'e2283000-0000-4000-8000-00000000000c';
select is((select status from public.studio_steps where id = pg_temp.id('step2')), 'failed', 'a cancelled MP4 fails the slideshow step');
select is((select status from public.work_orders where id = pg_temp.id('order2')), 'failed', 'and its order, so it is replanned');

-- #2: after an edit, the old renders cannot be approved, even when a refresh made the card match the document.
update public.editor_projects set document = '{"version":1,"stage":{"name":"three cuts, edited"}}' where clip_id = pg_temp.id('clip');
select throws_ok($$ update public.studio_steps set status = 'done', decision = 'approve' where id = pg_temp.id('step') $$,
  'P0001', 'The slideshow changed since it was rendered. Render it again.', 'renders older than the document are never approved');

-- #1: the founder renders it again: the old card closes, the new renders raise a new card on the same step.
select pg_temp.render('e2283000-0000-4000-8000-00000000000e', 'render_document', pg_temp.id('clip'), 'queued');
select pg_temp.render('e2283000-0000-4000-8000-00000000000f', 'render_stills', pg_temp.id('clip'), 'queued');
insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash)
select 'e2283000-0000-4000-8000-000000000010', 'e2280000-0000-4000-8000-00000000000a', 'render_document', c.id, c.job_id, 'queued',
  gen_random_uuid(), '{}', repeat('0', 64)
from public.clips c where c.id = pg_temp.id('clip');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.studio_slideshow_rerender(pg_temp.id('step'), 'e2283000-0000-4000-8000-000000000010',
  'e2283000-0000-4000-8000-00000000000f', '{"slides":[{"text":"a","still_path":null,"seconds":3}]}') $$,
  '22023', 'Queue the MP4 and the PNG set of the slideshow as it is now first.', 'a render of an older document is refused');
select is(public.studio_slideshow_rerender(pg_temp.id('step'), 'e2283000-0000-4000-8000-00000000000e',
  'e2283000-0000-4000-8000-00000000000f', '{"title":"Three cuts","slides":[{"text":"Cut by deleting words","still_path":null,"seconds":3}]}'),
  pg_temp.id('step'), 'the founder renders the edited slideshow again');
reset role;
select is((select status from public.approvals where id = pg_temp.id('card')), 'cancelled', 'the old card closes');
select is((select status from public.studio_steps where id = pg_temp.id('step')), 'running', 'the step renders again');
select is((select status from public.work_orders where id = pg_temp.id('order')), 'waiting_founder', 'the order keeps waiting on the founder');
update public.tasks set status = 'done' where id in ('e2283000-0000-4000-8000-00000000000e', 'e2283000-0000-4000-8000-00000000000f');
select is((select snapshot->'slides'->0->>'text' from public.approvals where ref_id = pg_temp.id('step') and status = 'waiting'),
  'Cut by deleting words', 'the new renders raise a new card with the new words');
insert into auth.users (id, email) values ('e2280000-0000-4000-8000-00000000000b', 'other@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000b","role":"authenticated"}';
select throws_ok($$ select public.studio_slideshow_rerender(pg_temp.id('step'), 'e2283000-0000-4000-8000-00000000000e',
  'e2283000-0000-4000-8000-00000000000f', '{"slides":[{"text":"a","still_path":null,"seconds":3}]}') $$,
  'P0002', 'Slideshow not found.', 'only the owner renders it again');
reset role;

-- #4: renaming a post image edit (a slideshow clip in the upload's job) keeps the upload's name.
insert into public.jobs (id, user_id, kind, source_url, title, status, duration_seconds)
values ('e2285000-0000-4000-8000-00000000000a', 'e2280000-0000-4000-8000-00000000000a', 'clip', 'https://example.com/v', 'My interview', 'done', 60);
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2285000-0000-4000-8000-00000000000b', 'e2285000-0000-4000-8000-00000000000a', 0, 'Full', 0, 60, 'full'),
  ('e2285000-0000-4000-8000-00000000000c', 'e2285000-0000-4000-8000-00000000000a', -1, 'Image', 0, 0, 'slideshow');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
select public.rename_blank_edit('e2285000-0000-4000-8000-00000000000c', 'Launch card');
select public.rename_blank_edit(pg_temp.id('clip2'), 'Renamed slideshow');
reset role;
select is((select hook from public.clips where id = 'e2285000-0000-4000-8000-00000000000c'), 'Launch card', 'the image edit is renamed');
select is((select title from public.jobs where id = 'e2285000-0000-4000-8000-00000000000a'), 'My interview', 'the upload keeps its name');
select is((select j.title from public.jobs j join public.clips c on c.job_id = j.id where c.id = pg_temp.id('clip2')), 'Renamed slideshow',
  'a slideshow alone in its job still renames the project');

-- #5: renders OpenCMO orders itself leave the founder's daily exports alone; the founder's own count.
create function pg_temp.exports() returns int language sql as $$
  select coalesce(sum(count), 0)::int from public.rate_limits where user_id = 'e2280000-0000-4000-8000-00000000000a' and bucket = 'export' $$;
create temp table rev as select * from public.editor_revisions where false;
grant all on rev to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
insert into rev select * from public.snapshot_editor_revision(pg_temp.id('clip'), pg_temp.hash(pg_temp.id('clip')));
select public.request_stills_export(pg_temp.id('clip'), (select id from rev), gen_random_uuid());
select public.request_document_export(pg_temp.id('clip'), (select id from rev), gen_random_uuid());
reset role;
select is(pg_temp.exports(), 0, 'CMO renders do not spend the daily export limit');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
select public.request_document_export(pg_temp.id('clip'), (select id from rev), gen_random_uuid());
reset role;
select is(pg_temp.exports(), 1, 'the founder''s own export does');

-- #10: still exports count toward the 20-in-progress cap of the document export too.
insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload)
select 'e2280000-0000-4000-8000-00000000000a', 'render_stills', c.id, c.job_id, 'queued', gen_random_uuid(), '{}'
from public.clips c, generate_series(1, 20) where c.id = pg_temp.id('clip');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok(format($$ select public.request_document_export(%L, %L, gen_random_uuid()) $$, pg_temp.id('clip'), (select id from rev)),
  'P0001', 'You already have 20 previews or exports in progress. Please wait for one to finish.', 'queued stills count toward the cap');
reset role;

-- #8: the same Slideshow order gets the same edit on a retry; only Studio's team passes an order.
insert into t select 'order3', id from public.work_order_create('e2280000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Retry');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
insert into t select 'first', public.create_slideshow('Retry', '9:16', pg_temp.id('order3'));
insert into t select 'again', public.create_slideshow('Retry', '9:16', pg_temp.id('order3'));
set local request.jwt.claims = '{"sub":"e2280000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.create_slideshow('Retry', '9:16', pg_temp.id('order3')) $$, '42501', null,
  'the founder does not pass an order');
reset role;
select is(pg_temp.id('again'), pg_temp.id('first'), 'a retry of the same order reuses its slideshow');

select * from finish();
rollback;
