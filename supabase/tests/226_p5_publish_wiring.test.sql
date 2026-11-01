-- P5 A3 (20261231140000): a slideshow card orders and shows its captions; approving it approves them and schedules
-- the slideshow like a short; a post's image is part of what goes out for it, and a new image sends an approved
-- schedule card back to the founder.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(11);

insert into auth.users (id, email) values ('e2260000-0000-4000-8000-00000000000a', 'p5a3@test.local');
update public.profiles set credit_balance = 50 where id = 'e2260000-0000-4000-8000-00000000000a';
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated, service_role;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from t where name = p $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2260000-0000-4000-8000-00000000000a","role":"authenticated"}';
insert into t select 'show', public.create_slideshow('Three cuts', '9:16');
insert into t select 'img', public.create_slideshow('Launch image', '1:1');
reset role;
insert into public.editor_projects (clip_id, document) values
  (pg_temp.id('show'), '{"version":1,"stage":{"name":"three cuts"}}'), (pg_temp.id('img'), '{"version":1,"stage":{"name":"image"}}');
create temp table root as select * from public.work_order_week_root('e2260000-0000-4000-8000-00000000000a');
insert into t select 'order', id from public.work_order_create('e2260000-0000-4000-8000-00000000000a', (select week from root),
  (select id from root), 'build_slideshow', 'Three cuts');
select public.work_order_move(pg_temp.id('order'), 'running');

-- The slideshow card: raised, it orders its captions.
insert into public.studio_steps (id, user_id, clip_id, tool, kind, input, card, price_credits, order_id, status)
values ('e2263000-0000-4000-8000-00000000000a', 'e2260000-0000-4000-8000-00000000000a', pg_temp.id('show'), 'make_slideshow',
  'slideshow', '{}', '{"title":"Three cuts","aspect":"9:16","slides":[{"text":"Cut by words","still_path":null,"seconds":3}]}',
  0, pg_temp.id('order'), 'waiting');
select is((select count(*)::int from public.work_orders where kind = 'write_caption'
  and brief->>'ref_id' = 'e2263000-0000-4000-8000-00000000000a'), 1, 'a slideshow card orders its captions');

-- Writer saves a TikTok caption: the same card shows it, with a new hash.
create temp table h (hash text) on commit drop;
insert into h select content_hash from public.approvals where ref_id = 'e2263000-0000-4000-8000-00000000000a' and status = 'waiting';
select public.cmo_save_caption('e2260000-0000-4000-8000-00000000000a', null, pg_temp.id('show'), 'tiktok_caption', 'Three cuts that save a demo.');
select is((select snapshot->'captions'->0->>'text' from public.approvals where ref_id = 'e2263000-0000-4000-8000-00000000000a' and status = 'waiting'),
  'Three cuts that save a demo.', 'the card shows the caption');
select isnt((select content_hash from public.approvals where ref_id = 'e2263000-0000-4000-8000-00000000000a' and status = 'waiting'),
  (select hash from h), 'with a new hash');

-- Approved: its caption is approved and the slideshow gets a TikTok slot and card.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2260000-0000-4000-8000-00000000000a","role":"authenticated"}';
select is((select status from public.approval_decide((select id from public.approvals where ref_id = 'e2263000-0000-4000-8000-00000000000a' and status = 'waiting'),
  'approve', jsonb_build_object('content_hash', (select content_hash from public.approvals where ref_id = 'e2263000-0000-4000-8000-00000000000a' and status = 'waiting')))),
  'approved', 'the founder approves the slideshow');
reset role;
select is((select status from public.content_items where clip_id = pg_temp.id('show') and department = 'video'), 'approved', 'its caption is approved');
select is((select string_agg(s.platform || ' ' || s.status, ',') from public.schedule_slots s join public.deliverables d on d.id = s.deliverable_id
  where d.kind = 'slideshow' and d.ref_id = pg_temp.id('show')), 'tiktok proposed', 'the slideshow is scheduled where it has a caption');
select is((select count(*)::int from public.approvals a join public.schedule_slots s on s.id = a.ref_id join public.deliverables d on d.id = s.deliverable_id
  where a.kind = 'schedule' and a.status = 'waiting' and d.kind = 'slideshow'), 1, 'with its schedule card');

-- A post, approved and scheduled; then its image arrives.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body) values
  ('e2264000-0000-4000-8000-00000000000a', 'e2260000-0000-4000-8000-00000000000a', 'post', 'linkedin', current_date, 'Launch',
   'approved', '{"text":"We shipped the editor."}');
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status) values
  ('e2265000-0000-4000-8000-00000000000a', 'e2260000-0000-4000-8000-00000000000a', pg_temp.id('order'), 'post', 'content_item',
   'e2264000-0000-4000-8000-00000000000a', 'decided');
insert into t select 'slot', id from public.schedule_slots where deliverable_id = 'e2265000-0000-4000-8000-00000000000a';
update public.approvals set status = 'approved', decided_at = now() where ref_id = pg_temp.id('slot') and status = 'waiting';
update public.schedule_slots set status = 'waiting' where id = pg_temp.id('slot');
insert into h select content_hash from public.approvals where ref_id = pg_temp.id('slot');

insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash, output, finished_at)
select 'e2260000-0000-4000-8000-00000000000a', 'render_stills', c.id, c.job_id, 'done', gen_random_uuid(), '{}',
  public.editor_document_hash(p.document),
  jsonb_build_object('cover_index', 0, 'stills', jsonb_build_array(jsonb_build_object('index', 0, 'object', 'u/img/t-01.png', 'bytes', 2048))),
  now()
from public.clips c join public.editor_projects p on p.clip_id = c.id where c.id = pg_temp.id('img');
insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id, status, post_id) values
  ('e2260000-0000-4000-8000-00000000000a', pg_temp.id('order'), 'image', 'clip', pg_temp.id('img'), 'ready', 'e2264000-0000-4000-8000-00000000000a');
select is((select status from public.schedule_slots where id = pg_temp.id('slot')), 'proposed', 'an approved slot goes back to the founder');
select is((select snapshot->'image'->>'object' from public.approvals where ref_id = pg_temp.id('slot') and status = 'waiting'), 'u/img/t-01.png',
  'its new card shows the image');
select ok((select content_hash from public.approvals where ref_id = pg_temp.id('slot') and status = 'waiting') not in (select hash from h),
  'and asks again with a new hash');
select is((public.schedule_content('e2265000-0000-4000-8000-00000000000a', 'linkedin')->'image'->>'bytes')::int, 2048,
  'what goes out carries the still and its size');

select * from finish();
rollback;
