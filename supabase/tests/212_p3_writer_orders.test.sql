-- P3 A2 (20261229110000): Writer's orders. A video waits on its brief and takes it (or goes on without it); a Writer
-- order gets its own run; a finished-video card orders its captions; Writer saves captions onto the card, the founder
-- edits one there (same card, new hash, Writer never overwrites it); approving the video delivers them; a draft
-- without an item takes its platform.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(54);

select is(public.cmo_job_price('write_caption'), 1, 'a caption run costs 1 credit');
select is(public.cmo_job_price('write_video_brief'), 1, 'so does a brief');
select is(public.cmo_job_daily_limit('write_slides'), 10, 'slides are registered for S3');
select is(public.work_order_department('write_caption'), 'writer', 'Writer''s orders are Writer''s');
select ok(not has_function_privilege('authenticated', 'public.cmo_save_caption(uuid,uuid,uuid,text,text,text,jsonb)', 'execute'),
  'only Writer saves captions');
select ok(has_function_privilege('service_role', 'public.cmo_save_caption(uuid,uuid,uuid,text,text,text,jsonb)', 'execute'), 'as the service role');

insert into auth.users (id, email) values
  ('e2120000-0000-4000-8000-00000000000a', 'orders@test.local'),
  ('e2120000-0000-4000-8000-00000000000b', 'orders-broke@test.local');
update public.profiles set credit_balance = 50 where id = 'e2120000-0000-4000-8000-00000000000a';
-- P5 A2: fresh niche research, so the week plan orders none and the briefs start at once, as this test expects.
insert into public.cmo_insights (user_id, kind, body) values
  ('e2120000-0000-4000-8000-00000000000a', 'niche_video', '{}'),
  ('e2120000-0000-4000-8000-00000000000b', 'niche_video', '{}');
create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from t where name = p $$;

-- The plan's video item: a brief order, and a video order that waits on it.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2121000-0000-4000-8000-00000000000a', 'e2120000-0000-4000-8000-00000000000a', 'plan_week', 'running');
select public.cmo_plan_week('e2120000-0000-4000-8000-00000000000a', 'e2121000-0000-4000-8000-00000000000a',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'TikTok',
    'idea', 'Cut a demo by words', 'reason', 'Launch week')));
insert into t select 'brief', id from public.work_orders where kind = 'write_video_brief' and user_id = 'e2120000-0000-4000-8000-00000000000a';
insert into t select 'video', id from public.work_orders where kind = 'build_video' and user_id = 'e2120000-0000-4000-8000-00000000000a';
select is((select department || ' ' || status from public.work_orders where id = pg_temp.id('brief')), 'writer queued', 'a brief order under Writer');
select is((select depends_on from public.work_orders where id = pg_temp.id('video')), array[pg_temp.id('brief')], 'the video waits on it');
select is((select input->>'idea' from public.cmo_runs where kind = 'write_video_brief' and input->>'order_id' = pg_temp.id('brief')::text),
  'Cut a demo by words', 'the brief''s run starts with the plan''s idea');
select is((select run_id from public.work_orders where id = pg_temp.id('brief')),
  (select id from public.cmo_runs where kind = 'write_video_brief' and input->>'order_id' = pg_temp.id('brief')::text),
  'and is the brief order''s run');
select is((select count(*)::int from public.studio_orders_claim()), 0, 'Studio does not take a video before its brief');
select is(public.studio_work_count(), 0, 'nor counts it as work');

-- The brief is written: the video takes it.
update public.cmo_runs set status = 'done', finished_at = now(), output = jsonb_build_object('reason', 'Brief written',
  'brief', jsonb_build_object('objective', 'Show a demo cut by words', 'angle', 'Founder''s own screen',
    'hooks', jsonb_build_array('Cut by words.', 'No timeline.', 'One take.'), 'keyPoints', jsonb_build_array('Delete words to cut'),
    'cta', 'Try it on your demo', 'seconds', 40, 'aspect', '9:16'))
where input->>'order_id' = pg_temp.id('brief')::text;
select is((select status from public.work_orders where id = pg_temp.id('brief')), 'done', 'the brief order is done');
select is((select brief->>'objective' || ' · ' || (brief->'hooks'->>2) || ' · ' || (brief->'key_points'->>0) || ' · ' || (brief->>'cta')
  || ' · ' || (brief->>'seconds') || ' · ' || (brief->>'brief_from') from public.work_orders where id = pg_temp.id('video')),
  'Show a demo cut by words · One take. · Delete words to cut · Try it on your demo · 40 · writer', 'the video takes Writer''s brief');
select is((select brief->>'platform' from public.work_orders where id = pg_temp.id('video')), 'TikTok', 'and keeps what the plan said');
select is(public.studio_work_count(), 1, 'now Studio has work');
select is((select id from public.studio_orders_claim()), pg_temp.id('video'), 'and takes the video');

-- A founder with no credits: the brief cannot start, so the video goes on with the plan's own brief.
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2121000-0000-4000-8000-00000000000b', 'e2120000-0000-4000-8000-00000000000b', 'plan_week', 'running');
select public.cmo_plan_week('e2120000-0000-4000-8000-00000000000b', 'e2121000-0000-4000-8000-00000000000b',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'Shorts', 'idea', 'A short', 'reason', 'r')));
select is((select status || ' ' || (error->>'code') from public.work_orders where kind = 'write_video_brief' and user_id = 'e2120000-0000-4000-8000-00000000000b'),
  'failed not_started', 'a brief that cannot start fails with the reason');
select is((select depends_on from public.work_orders where kind = 'build_video' and user_id = 'e2120000-0000-4000-8000-00000000000b'),
  '{}'::uuid[], 'and its video stops waiting');

-- A brief that fails after it started: the same.
update public.profiles set credit_balance = 10 where id = 'e2120000-0000-4000-8000-00000000000b';
insert into t select 'video_b', id from public.work_orders where kind = 'build_video' and user_id = 'e2120000-0000-4000-8000-00000000000b';
update public.work_orders set status = 'cancelled' where id = pg_temp.id('video_b');
insert into public.cmo_runs (id, user_id, kind, status) values
  ('e2121000-0000-4000-8000-00000000000c', 'e2120000-0000-4000-8000-00000000000b', 'plan_week', 'running');
select public.cmo_plan_week('e2120000-0000-4000-8000-00000000000b', 'e2121000-0000-4000-8000-00000000000c',
  jsonb_build_array(jsonb_build_object('day', current_date, 'department', 'video', 'platform', 'Shorts', 'idea', 'Another short', 'reason', 'r')));
insert into t select 'brief_b', id from public.work_orders where kind = 'write_video_brief' and status = 'queued'
  and user_id = 'e2120000-0000-4000-8000-00000000000b';
update public.cmo_runs set status = 'failed', error = 'The model was busy.', finished_at = now()
where input->>'order_id' = pg_temp.id('brief_b')::text;
select is((select status from public.work_orders where id = pg_temp.id('brief_b')), 'failed', 'a failed run fails its brief');
select is((select depends_on from public.work_orders where kind = 'build_video' and status = 'queued' and user_id = 'e2120000-0000-4000-8000-00000000000b'),
  '{}'::uuid[], 'and the video goes on without it');
select is((select brief->>'objective' from public.work_orders where kind = 'build_video' and status = 'queued' and user_id = 'e2120000-0000-4000-8000-00000000000b'),
  'Another short', 'with the plan''s own brief');

-- Runs per order and per item.
select isnt((public.enqueue_cmo_run_for('e2120000-0000-4000-8000-00000000000a', 'post_draft', '{"item_id":"e2129999-0000-4000-8000-000000000001"}')).id,
  (public.enqueue_cmo_run_for('e2120000-0000-4000-8000-00000000000a', 'post_draft', '{"item_id":"e2129999-0000-4000-8000-000000000002"}')).id,
  'two posts due today each get a run');
select is((public.enqueue_cmo_run_for('e2120000-0000-4000-8000-00000000000a', 'post_draft', '{"item_id":"e2129999-0000-4000-8000-000000000001"}')).id,
  (select id from public.cmo_runs where input->>'item_id' = 'e2129999-0000-4000-8000-000000000001'), 'the same item waits behind its own run');
select is((public.enqueue_cmo_run_for('e2120000-0000-4000-8000-00000000000a', 'post_draft', '{}')).id,
  (public.enqueue_cmo_run_for('e2120000-0000-4000-8000-00000000000a', 'post_draft', '{"brief":"now"}')).id,
  'a post without an item still waits behind the queued one');

-- Captions: a finished-video card orders them for the platforms this week's plan targets.
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e2122000-0000-4000-8000-00000000000a', 'e2120000-0000-4000-8000-00000000000a', 'https://a', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2123000-0000-4000-8000-00000000000a', 'e2122000-0000-4000-8000-00000000000a', -1, 'Cut by words', 0, 0, 'blank');
insert into public.editor_projects (clip_id, document, manifest) values
  ('e2123000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"demo"}}', '{"version":1,"folders":[],"assets":[]}');
select public.approval_raise('e2120000-0000-4000-8000-00000000000a', 'editor_project', 'e2123000-0000-4000-8000-00000000000a');
insert into t select 'card', id from public.approvals where ref_kind = 'editor_project' and status = 'waiting';
insert into t select 'captions', id from public.work_orders where kind = 'write_caption';
select is((select (brief->'clip_ids') || (brief->'profiles') from public.work_orders where id = pg_temp.id('captions')),
  '["e2123000-0000-4000-8000-00000000000a", "tiktok_caption"]'::jsonb, 'one caption order: the edit, for TikTok, as the plan targets');
select is((select status from public.cmo_runs where kind = 'write_caption' and input->>'order_id' = pg_temp.id('captions')::text), 'queued',
  'its run is queued');
select ok(not (select snapshot ? 'captions' from public.approvals where id = pg_temp.id('card')), 'a card without captions keeps its shape');
select public.approval_raise('e2120000-0000-4000-8000-00000000000a', 'editor_project', 'e2123000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.work_orders where kind = 'write_caption'), 1, 'the same card asks once');

-- Writer saves captions; the card shows them, same card, new hash.
create temp table h (hash text) on commit drop;
grant all on h to authenticated;
insert into h select content_hash from public.approvals where id = pg_temp.id('card');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Watch it at https://opencmo.io') $$, '22023', 'Captions carry no links.', 'no links');
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Cut #a1 #b #c #d #e #f') $$, '22023', 'A TikTok caption carries at most 5 hashtags.', 'at most the profile''s hashtags');
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Cut by words.', 'A title') $$, '22023', 'Only YouTube has a title.', 'a title only on YouTube');
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'youtube', 'A description.') $$, '22023', 'A YouTube title is 1 to 100 characters.', 'and always there');
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'x', 'A post.') $$, '22023', 'Captions are for Instagram, TikTok and YouTube.', 'captions are for video platforms');
select throws_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000b', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Not mine.') $$, 'P0002', 'Video not found.', 'only the founder''s own edit');
select lives_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Cut your demo by deleting words. #buildinpublic #saas', null, '{"model":"fake"}') $$, 'Writer saves a TikTok caption');
select lives_ok($$ select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'youtube', 'Delete words in the transcript and the video cuts itself.', 'Cut a demo by deleting words') $$, 'and the YouTube text');
reset role;
insert into t select 'tiktok', id from public.content_items where clip_id = 'e2123000-0000-4000-8000-00000000000a' and platform = 'tiktok_caption';
insert into t select 'youtube', id from public.content_items where clip_id = 'e2123000-0000-4000-8000-00000000000a' and platform = 'youtube';
select is((select department || ' ' || status || ' ' || (body->>'drafted_text') from public.content_items where id = pg_temp.id('tiktok')),
  'video in_review Cut your demo by deleting words. #buildinpublic #saas', 'a caption is the edit''s video words, kept as drafted');
select is((select count(*)::int from public.approvals where ref_kind = 'editor_project' and status = 'waiting'), 1, 'still one card');
select is((select id from public.approvals where ref_kind = 'editor_project' and status = 'waiting'), pg_temp.id('card'), 'the same card');
select isnt((select content_hash from public.approvals where id = pg_temp.id('card')), (select hash from h), 'under a new hash');
select is((select jsonb_agg(c->>'profile') from public.approvals a, jsonb_array_elements(a.snapshot->'captions') c where a.id = pg_temp.id('card')),
  '["tiktok_caption", "youtube"]'::jsonb, 'the card shows both, in the profiles'' order');

-- The founder edits a caption on the card.
delete from h;
insert into h select content_hash from public.approvals where id = pg_temp.id('card');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2120000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.approval_decide(pg_temp.id('card'), 'edit_caption',
  jsonb_build_object('content_hash', repeat('0', 64), 'caption', pg_temp.id('tiktok'), 'text', 'Mine.')) $$,
  'P0001', 'This card changed. Look at it again before deciding.', 'an old screen cannot edit');
select throws_ok($$ select public.approval_decide(pg_temp.id('card'), 'edit_caption',
  jsonb_build_object('content_hash', (select hash from h), 'caption', gen_random_uuid(), 'text', 'Mine.')) $$,
  '22023', 'That caption is not on this card.', 'only a caption on the card');
select throws_ok($$ select public.approval_decide(pg_temp.id('card'), 'edit_caption',
  jsonb_build_object('content_hash', (select hash from h), 'caption', pg_temp.id('tiktok'), 'text', 'See www.opencmo.io')) $$,
  '22023', 'Captions carry no links.', 'the founder''s words keep the same rules');
select is((public.approval_decide(pg_temp.id('card'), 'edit_caption',
  jsonb_build_object('content_hash', (select hash from h), 'caption', pg_temp.id('tiktok'), 'text', 'I cut my demo by deleting words.'))).status,
  'waiting', 'an edit decides nothing');
reset role;
select is((select body->>'text' from public.content_items where id = pg_temp.id('tiktok')), 'I cut my demo by deleting words.', 'the caption changed');
select is((select snapshot->'captions'->0->>'text' from public.approvals where id = pg_temp.id('card')), 'I cut my demo by deleting words.',
  'so did the card, same id');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.cmo_save_caption('e2120000-0000-4000-8000-00000000000a', null, 'e2123000-0000-4000-8000-00000000000a',
  'tiktok_caption', 'Writer again.');
reset role;
select is((select body->>'text' from public.content_items where id = pg_temp.id('tiktok')), 'I cut my demo by deleting words.',
  'Writer never overwrites the founder''s words');

-- Approving the video delivers its captions.
insert into t select 'vorder', id from public.work_orders where kind = 'build_video' and user_id = 'e2120000-0000-4000-8000-00000000000a';
insert into public.deliverables (user_id, order_id, kind, ref_kind, ref_id)
values ('e2120000-0000-4000-8000-00000000000a', pg_temp.id('vorder'), 'video', 'clip', 'e2123000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.deliverables d join public.deliverables p on p.id = d.parent_id
  where d.kind = 'caption' and p.ref_id = 'e2123000-0000-4000-8000-00000000000a'), 2, 'each caption is a deliverable under its video');
select is((select status from public.content_items where id = pg_temp.id('youtube')), 'approved', 'and approved with it');

-- A draft without an item takes its platform.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is((public.cmo_save_draft('e2120000-0000-4000-8000-00000000000a', null, null, 'Week one', '{"text":"Week one."}', 'low', 'linkedin')).platform,
  'LinkedIn', 'a LinkedIn draft is LinkedIn''s');
select is((public.cmo_save_draft('e2120000-0000-4000-8000-00000000000a', null, null, '', '{"text":"Hi."}')).platform, 'x', 'none is X, as before');
select is((public.cmo_save_draft('e2120000-0000-4000-8000-00000000000a', null, null, '', '{"text":"Hi."}', 'low', 'tiktok')).idea,
  'Post for X', 'a video platform is not a post platform');
reset role;

select * from finish();
rollback;
