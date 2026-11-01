-- P5 for B3 (20261231100000): a slideshow step waits on its MP4 and PNG set, becomes the card once both are done for
-- the document as it is, and approving it finishes the order and makes the slideshow deliverable; a failed render
-- fails the order; Writer's slides reach the slideshow order waiting on them.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(22);

insert into auth.users (id, email) values ('e2220000-0000-4000-8000-00000000000a', 'p5slides@test.local');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from t where name = p_name $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2220000-0000-4000-8000-00000000000a","role":"authenticated"}';
insert into t select 'clip', public.create_slideshow('Three cuts', '9:16');
insert into t select 'clip2', public.create_slideshow('Second', '9:16');
insert into t select 'blank', public.create_blank_edit('Blank', '9:16');
reset role;

insert into public.editor_projects (clip_id, document) values
  (pg_temp.id('clip'), '{"version":1,"stage":{"name":"three cuts"}}'),
  (pg_temp.id('clip2'), '{"version":1,"stage":{"name":"second"}}');
create temp table root as select * from public.work_order_week_root('e2220000-0000-4000-8000-00000000000a');
insert into t select 'order', id from public.work_order_create('e2220000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Three cuts');
insert into t select 'order2', id from public.work_order_create('e2220000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Second');
select public.work_order_move(pg_temp.id('order'), 'running');
select public.work_order_move(pg_temp.id('order2'), 'running');
-- The two renders the squad queued, of the document as it is.
insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash)
select v.id, 'e2220000-0000-4000-8000-00000000000a', v.kind, c.id, c.job_id, 'queued', gen_random_uuid(), '{}',
  public.editor_document_hash(p.document)
from (values ('e2223000-0000-4000-8000-00000000000a'::uuid, 'render_document', 'clip'),
             ('e2223000-0000-4000-8000-00000000000b'::uuid, 'render_stills', 'clip'),
             ('e2223000-0000-4000-8000-00000000000c'::uuid, 'render_document', 'clip2'),
             ('e2223000-0000-4000-8000-00000000000d'::uuid, 'render_stills', 'clip2')) v(id, kind, clip)
join public.clips c on c.id = pg_temp.id(v.clip)
join public.editor_projects p on p.clip_id = c.id;

-- Only Studio's team records the step, for its own slideshow, with both renders queued.
set local role authenticated;
select throws_ok($$ select public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('clip'), '{}',
  '{"slides":[{"text":"a","still_path":null,"seconds":3}]}', 'e2223000-0000-4000-8000-00000000000a', 'e2223000-0000-4000-8000-00000000000b') $$,
  '42501', null, 'the founder does not record squad steps');
set local request.jwt.claims = '{"sub":"e2220000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select throws_ok($$ select public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('blank'), '{}',
  '{"slides":[{"text":"a","still_path":null,"seconds":3}]}', 'e2223000-0000-4000-8000-00000000000a', 'e2223000-0000-4000-8000-00000000000b') $$,
  '22023', 'Only a slideshow gets a slideshow card.', 'only a slideshow');
select throws_ok($$ select public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('clip'), '{}',
  '{"slides":[]}', 'e2223000-0000-4000-8000-00000000000a', 'e2223000-0000-4000-8000-00000000000b') $$,
  '22023', 'This step is malformed.', 'a card has slides');
select throws_ok($$ select public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('clip'), '{}',
  '{"slides":[{"text":"a","still_path":null,"seconds":3}]}', 'e2223000-0000-4000-8000-00000000000c', 'e2223000-0000-4000-8000-00000000000b') $$,
  '22023', 'Queue the MP4 and the PNG set of this slideshow first.', 'the renders are this slideshow''s');
insert into t select 'step', public.studio_slideshow_rendering(pg_temp.id('order'), pg_temp.id('clip'), '{}',
  jsonb_build_object('title', 'Three cuts', 'aspect', '9:16', 'slides', jsonb_build_array(
    jsonb_build_object('text', 'Cut by words', 'still_path', 'p-01.png', 'seconds', 3),
    jsonb_build_object('text', 'Ask for B-roll', 'still_path', 'p-02.png', 'seconds', 3)),
    'mp4_path', 'p.mp4', 'png_set_path', 'p.zip'),
  'e2223000-0000-4000-8000-00000000000a', 'e2223000-0000-4000-8000-00000000000b');
insert into t select 'step2', public.studio_slideshow_rendering(pg_temp.id('order2'), pg_temp.id('clip2'), '{}',
  '{"title":"Second","slides":[{"text":"a","still_path":null,"seconds":3}]}',
  'e2223000-0000-4000-8000-00000000000c', 'e2223000-0000-4000-8000-00000000000d');
reset role;

select is((select tool || ' ' || kind || ' ' || status || ' ' || price_credits from public.studio_steps where id = pg_temp.id('step')),
  'make_slideshow slideshow running 0', 'the step waits on its renders, free');
select is((select count(*)::int from public.approvals where ref_id = pg_temp.id('step')), 0, 'no card while rendering');

-- One render done: still no card. Both done: the card, and the order waits on the founder.
update public.tasks set status = 'done', finished_at = now() where id = 'e2223000-0000-4000-8000-00000000000a';
select is((select count(*)::int from public.approvals where ref_id = pg_temp.id('step')), 0, 'one render is not enough');
update public.tasks set status = 'done', finished_at = now() where id = 'e2223000-0000-4000-8000-00000000000b';
select is((select kind || ' ' || department || ' ' || status from public.approvals where ref_id = pg_temp.id('step')),
  'slideshow studio waiting', 'both renders raise the slideshow card');
select is((select snapshot->'slides'->1->>'text' from public.approvals where ref_id = pg_temp.id('step')), 'Ask for B-roll',
  'with its slides');
select is((select status from public.work_orders where id = pg_temp.id('order')), 'waiting_founder',
  'the order waits on the founder');
select is((select count(*)::int from public.studio_steps_claim()), 0, 'the runner never takes a slideshow step');

-- A failed render fails the other order with its reason.
update public.tasks set status = 'failed', error = 'The PNG set could not be drawn.' where id = 'e2223000-0000-4000-8000-00000000000d';
select is((select status from public.studio_steps where id = pg_temp.id('step2')), 'failed', 'a failed render fails the step');
select is((select status || ' ' || (error->>'message') from public.work_orders where id = pg_temp.id('order2')),
  'failed The PNG set could not be drawn.', 'and the order, with the reason');

-- The founder approves: the order finishes and the slideshow is a deliverable for Schedule.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2220000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok(format($$ select public.approval_decide(%L, 'redo', jsonb_build_object('content_hash', %L)) $$,
  (select id from public.approvals where ref_id = pg_temp.id('step')), (select content_hash from public.approvals where ref_id = pg_temp.id('step'))),
  '22023', 'Choose approve or send back.', 'approve or send back only');
select is((select status from public.approval_decide((select id from public.approvals where ref_id = pg_temp.id('step')), 'approve',
  jsonb_build_object('content_hash', (select content_hash from public.approvals where ref_id = pg_temp.id('step'))))), 'approved',
  'the founder approves the slideshow');
reset role;
select is((select status || ' ' || decision from public.studio_steps where id = pg_temp.id('step')), 'done approve', 'the step is done');
select is((select status from public.work_orders where id = pg_temp.id('order')), 'done', 'the order is done');
select is((select kind || ' ' || ref_kind || ' ' || status from public.deliverables where ref_id = pg_temp.id('clip')),
  'slideshow clip ready', 'the slideshow is a deliverable');

-- Writer's slides go into the slideshow order waiting on them.
insert into public.cmo_runs (id, user_id, kind, status, output) values
  ('e2224000-0000-4000-8000-00000000000a', 'e2220000-0000-4000-8000-00000000000a', 'write_slides', 'done',
   '{"reason":"Launch week","slides":[{"heading":"Cut by words","body":""},{"heading":"Try it","body":"On your demo"}]}');
insert into t select 'slides', id from public.work_order_create('e2220000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'write_slides', 'Slides');
update public.work_orders set run_id = 'e2224000-0000-4000-8000-00000000000a' where id = pg_temp.id('slides');
insert into t select 'show', id from public.work_order_create('e2220000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Launch slides', '{"idea":"Launch"}', 0, null, array[pg_temp.id('slides')]);
select public.work_order_move(pg_temp.id('slides'), 'running');
select public.work_order_move(pg_temp.id('slides'), 'done', 'Slides written', null, 'Writer wrote the slides');
select is((select (brief->'slides'->1->>'heading') || ' · ' || (brief->>'slides_reason') || ' · ' || (brief->>'idea')
  from public.work_orders where id = pg_temp.id('show')), 'Try it · Launch week · Launch',
  'the slideshow order takes Writer''s slides and keeps its idea');
select is((select brief->>'brief_from' from public.work_orders where id = pg_temp.id('show')), 'writer',
  'and says they came from Writer');

-- A deleted still export leaves no PNG or zip behind, even from an attempt that crashed before its output.
insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload)
select 'e2223000-0000-4000-8000-00000000000e', 'e2220000-0000-4000-8000-00000000000a', 'render_stills', c.id, c.job_id, 'failed',
  gen_random_uuid(), jsonb_build_object('bucket', 'exports',
    'object', 'e2220000-0000-4000-8000-00000000000a/' || c.id || '/e2223000-0000-4000-8000-00000000000e.zip',
    'still_prefix', 'e2220000-0000-4000-8000-00000000000a/' || c.id || '/e2223000-0000-4000-8000-00000000000e')
from public.clips c where c.id = pg_temp.id('clip2');
insert into storage.objects (bucket_id, name, metadata)
select 'exports', 'e2220000-0000-4000-8000-00000000000a/' || pg_temp.id('clip2') || '/e2223000-0000-4000-8000-00000000000e-0' || n || '.png',
  '{"size":10,"mimetype":"image/png"}'
from generate_series(1, 2) n;
delete from public.storage_deletions;
delete from public.tasks where id = 'e2223000-0000-4000-8000-00000000000e';
select is((select count(*)::int from public.storage_deletions where bucket = 'exports' and path like '%e2223000-0000-4000-8000-00000000000e-0_.png'), 2,
  'a deleted still task queues its PNGs');
select is((select count(*)::int from public.storage_deletions where bucket = 'exports' and path like '%e2223000-0000-4000-8000-00000000000e.zip'), 1,
  'and its zip');

select * from finish();
rollback;
