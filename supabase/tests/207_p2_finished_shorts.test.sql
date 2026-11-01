-- P2 A3 (20261228110000): any edit after Mark finished clears it; a finished edit gets one `cut_shorts` order; the
-- Builder's batch makes one short edit per range; renders raise the batch card and card 3; approving a batch makes
-- one `short` deliverable per short and finishes the order; sending it back fails the order with the reason.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(56);

select ok(has_function_privilege('authenticated', 'public.cut_shorts_order(uuid)', 'execute'), 'the founder''s Cut shorts button');
select ok(has_function_privilege('authenticated', 'public.short_batch_create(uuid,text,uuid,jsonb)', 'execute'), 'the Builder under the founder''s session');
select ok(not has_function_privilege('authenticated', 'public.cut_shorts_order_for(uuid,uuid,text)', 'execute'), 'the rule''s own door is closed');
select ok(not has_function_privilege('authenticated', 'public.work_order_week_root(uuid)', 'execute'), 'and so is the root helper');

insert into auth.users (id, email) values
  ('e2070000-0000-4000-8000-00000000000a', 'a3@test.local'),
  ('e2070000-0000-4000-8000-00000000000b', 'a3-other@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e2071000-0000-4000-8000-00000000000a', 'e2070000-0000-4000-8000-00000000000a', 'https://a', 60, 'done'),
  ('e2071000-0000-4000-8000-00000000000c', 'e2070000-0000-4000-8000-00000000000a', 'https://c', 60, 'done');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, kind) values
  ('e2072000-0000-4000-8000-00000000000a', 'e2071000-0000-4000-8000-00000000000a', -1, 'Editor launch', 0, 0, 'blank'),
  ('e2072000-0000-4000-8000-00000000000c', 'e2071000-0000-4000-8000-00000000000c', -1, 'AI video', 0, 0, 'blank');
insert into public.editor_projects (clip_id, document, manifest) values
  ('e2072000-0000-4000-8000-00000000000a', '{"version":1,"stage":{"name":"launch"}}', '{"version":1,"folders":[],"assets":[{"id":"m"}]}'),
  ('e2072000-0000-4000-8000-00000000000c', '{"version":1,"stage":{"name":"ai"}}', default);

create temp table t (name text primary key, id uuid) on commit drop;
grant all on t to authenticated;
create function pg_temp.h(p_doc text) returns text language sql as $$ select public.editor_document_hash(p_doc::jsonb) $$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';

-- Not finished: no shorts.
select throws_ok($$ select public.cut_shorts_order('e2072000-0000-4000-8000-00000000000a') $$, 'P0001',
  'Mark this edit finished first: shorts are cut only from a finished edit.', 'shorts only from a finished edit');

-- Mark finished → the rule orders the shorts, once.
select public.mark_finished('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch"}}'));
insert into t select 'order', id from public.work_orders where kind = 'cut_shorts';
select is((select count(*)::int from public.work_orders where kind = 'cut_shorts'), 1, 'a finished edit gets a cut_shorts order');
select is((select department || ' ' || created_by || ' ' || status from public.work_orders where id = (select id from t where name = 'order')),
  'studio event queued', 'from the rule, under Studio');
select is((select count(*)::int from public.work_orders where parent_id is null), 1, 'under the week''s root, made for it');
select is(public.cut_shorts_order('e2072000-0000-4000-8000-00000000000a'), (select id from t where name = 'order'),
  'the button on the same version finds the same order');

-- Any edit clears the mark and closes nothing it should not.
reset role;
update public.editor_projects set document = '{"version":1,"stage":{"name":"launch v2"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000a';
select is((select finished_at from public.editor_projects where clip_id = 'e2072000-0000-4000-8000-00000000000a'), null, 'an edit clears the finished mark');
select is((select finished_hash from public.editor_projects where clip_id = 'e2072000-0000-4000-8000-00000000000a'), null, 'and its hash');
update public.editor_projects set manifest = '{"version":1,"folders":[],"assets":[{"id":"m"}]}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v2"}}'));
reset role;
update public.editor_projects set manifest = '{"version":1,"folders":[],"assets":[{"id":"m"},{"id":"n"}]}' where clip_id = 'e2072000-0000-4000-8000-00000000000a';
select isnt((select finished_at from public.editor_projects where clip_id = 'e2072000-0000-4000-8000-00000000000a'), null,
  'a library change is not an edit of the video');
select is((select count(*)::int from public.work_orders where kind = 'cut_shorts' and status = 'queued'), 2,
  'the new finished version gets its own order');
update public.work_orders set status = 'cancelled' where id = (select id from t where name = 'order');
delete from t where name = 'order';
insert into t select 'order', id from public.work_orders where kind = 'cut_shorts' and status = 'queued';
insert into public.editor_transcripts (clip_id, hash, body) values
  ('e2072000-0000-4000-8000-00000000000a', repeat('a', 64), '[{"text":"Cut by words."}]'),
  ('e2072000-0000-4000-8000-00000000000a', repeat('b', 64), '[{"text":"Not in any short."}]');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';

-- The Builder's batch.
select throws_ok($$ select public.short_batch_create('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch"}}'),
  null, '[{"source_start":0,"source_end":20,"hook":"h","title":"t","reason":"r","document":{}}]') $$, 'P0001', null,
  'a batch is cut only from the version that is finished');
select throws_ok($$ select public.short_batch_create('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v2"}}'),
  null, '[]') $$, '22023', 'A batch has 1 to 3 shorts.', 'a batch has 1 to 3 shorts');
select throws_ok($$ select public.short_batch_create('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v2"}}'),
  null, '[{"source_start":0,"source_end":20,"hook":"h","title":"t","document":{}}]') $$, '22023', null, 'every short has its reason');
insert into t select 'batch', (public.short_batch_create('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v2"}}'),
  (select id from t where name = 'order'), '[
    {"source_start":0,"source_end":22,"hook":"Cut by words","title":"Cut by words","reason":"Opens on the pain","document":{"version":1,"stage":{"name":"s1","children":[{"kind":"captions","src":"assets/transcripts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"}]}}},
    {"source_start":18,"source_end":41,"hook":"B-roll on the line","title":"B-roll","reason":"Shows the command","document":{"version":1,"stage":{"name":"s2"}}},
    {"source_start":38,"source_end":60,"hook":"Edit by asking","title":"Ask","reason":"Strongest demo","document":{"version":1,"stage":{"name":"s3"}}}
  ]'::jsonb)->>'batch_id')::uuid;
select is((select count(*)::int from public.shorts where batch_id = (select id from t where name = 'batch')), 3, 'one short per range');
select is((select count(*)::int from public.clips where parent_clip_id = 'e2072000-0000-4000-8000-00000000000a' and kind = 'short'), 3,
  'each its own edit under the parent');
select is((select count(distinct idx)::int from public.clips where job_id = 'e2071000-0000-4000-8000-00000000000a'), 4, 'with its own index');
select is((select count(*)::int from public.editor_projects p join public.clips c on c.id = p.clip_id
  where c.parent_clip_id = 'e2072000-0000-4000-8000-00000000000a' and p.manifest = '{"version":1,"folders":[],"assets":[{"id":"m"},{"id":"n"}]}'::jsonb), 3,
  'with the parent''s library');
select is((select document->'stage'->>'name' from public.editor_projects p join public.clips c on c.id = p.clip_id
  where c.parent_clip_id = 'e2072000-0000-4000-8000-00000000000a' order by c.idx desc limit 1), 's1', 'and the Builder''s document');
reset role;
select is((select array_agg(t.hash) from public.editor_transcripts t join public.clips c on c.id = t.clip_id
  where c.parent_clip_id = 'e2072000-0000-4000-8000-00000000000a' and c.idx = (select max(idx) from public.clips
  where parent_clip_id = 'e2072000-0000-4000-8000-00000000000a')), array[repeat('a', 64)], 'the short gets the parent''s transcript its captions read');
select is((select count(*)::int from public.editor_transcripts where hash = repeat('b', 64)), 1, 'and no transcript it does not use');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select throws_ok($$ select public.short_batch_create('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v2"}}'),
  null, '[{"source_start":0,"source_end":20,"hook":"h","title":"t","reason":"r","document":{}}]') $$, 'P0001',
  'Shorts are already being cut from this version.', 'a retry does not double the batch');
select throws_ok($$ select public.cut_shorts_order((select id from public.clips where kind = 'short' limit 1)) $$, 'P0001',
  'A short is not cut into shorts.', 'a short is not cut into shorts');
select is((select count(*)::int from public.approvals where ref_kind = 'short_batch'), 0, 'no card before the renders');

-- Renders: one fails, two finish → the card waits with the two.
reset role;
insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload)
select 'e2070000-0000-4000-8000-00000000000a', 'render_document', s.short_clip_id, 'e2071000-0000-4000-8000-00000000000a', 'running',
  gen_random_uuid(), '{}' from public.shorts s where s.batch_id = (select id from t where name = 'batch');
update public.tasks set status = 'failed', error = 'boom' where clip_id = (select short_clip_id from public.shorts where hook = 'B-roll on the line');
select is((select status from public.shorts where hook = 'B-roll on the line'), 'failed', 'a failed render fails its short');
select is((select status from public.short_batches where id = (select id from t where name = 'batch')), 'rendering', 'the batch waits for the rest');
update public.tasks set status = 'done', output_path = 'u/x.mp4' where kind = 'render_document' and status = 'running';
select is((select status from public.short_batches where id = (select id from t where name = 'batch')), 'waiting_founder', 'all rendered: the batch waits on you');
select is((select jsonb_array_length(snapshot->'shorts') from public.approvals where ref_kind = 'short_batch' and status = 'waiting'), 2,
  'the card shows the shorts you can watch');
select is((select department from public.approvals where ref_kind = 'short_batch' and status = 'waiting'), 'studio', 'a Studio card');
select is((select status from public.work_orders where id = (select id from t where name = 'order')), 'waiting_founder', 'the order waits on you');

-- Approve the batch → one short deliverable each, order done.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select is((select public.approval_decide(id, 'approve', jsonb_build_object('content_hash', content_hash))
  from public.approvals where ref_kind = 'short_batch' and status = 'waiting').status, 'approved', 'the batch is approved at once');
reset role;
select is((select count(*)::int from public.deliverables where order_id = (select id from t where name = 'order') and kind = 'short' and status = 'ready'), 2,
  'one short deliverable each, ready for Schedule');
select is((select status from public.work_orders where id = (select id from t where name = 'order')), 'done', 'the order is done');
select is((select count(*)::int from public.shorts where batch_id = (select id from t where name = 'batch') and status = 'approved'), 2, 'the shorts are approved');

-- A video order: its render raises card 3; approving it delivers the video and finishes the order (and orders shorts).
select public.work_order_create('e2070000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date,
  (select id from public.work_orders where user_id = 'e2070000-0000-4000-8000-00000000000a' and parent_id is null),
  'build_video', 'AI video', '{}', 0);
insert into t select 'video', id from public.work_orders where kind = 'build_video';
select is((select department from public.work_orders where id = (select id from t where name = 'video')), 'studio', 'a video order is Studio''s');
select public.work_order_move((select id from t where name = 'video'), 'running');
insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status, decision)
values ('e2070000-0000-4000-8000-00000000000a', 'e2072000-0000-4000-8000-00000000000c', 'create_video', 'script', '{}', '{"seconds":60}', 7,
  (select id from t where name = 'video'), 'done', 'approve');
-- The founder exports the edit before the order reached its render: no card 3, the order goes on.
insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload)
values ('e2070000-0000-4000-8000-00000000000a', 'render_document', 'e2072000-0000-4000-8000-00000000000c', 'e2071000-0000-4000-8000-00000000000c',
  'running', gen_random_uuid(), '{}');
update public.tasks set status = 'failed', error = 'boom' where kind = 'render_document' and status = 'running' and clip_id = 'e2072000-0000-4000-8000-00000000000c';
select is((select status from public.work_orders where id = (select id from t where name = 'video')), 'running',
  'a failed export of the founder''s own does not fail the video order');
insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status, decision, next)
values ('e2070000-0000-4000-8000-00000000000a', 'e2072000-0000-4000-8000-00000000000c', 'animate_video', 'price', '{}', '{"seconds":60}', 24,
  (select id from t where name = 'video'), 'done', 'approve', '{"tool":"render"}');
insert into public.tasks (id, user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash, duration)
values ('e2075000-0000-4000-8000-00000000000c', 'e2070000-0000-4000-8000-00000000000a', 'render_document', 'e2072000-0000-4000-8000-00000000000c',
  'e2071000-0000-4000-8000-00000000000c', 'running', gen_random_uuid(), '{}', pg_temp.h('{"version":1,"stage":{"name":"ai"}}'), 60);
update public.tasks set status = 'done', output_path = 'u/ai.mp4', finished_at = now() where id = 'e2075000-0000-4000-8000-00000000000c';
-- P6 S4: the look check reads the export first; its pass raises card 3.
select is((select count(*)::int from public.approvals where ref_kind = 'editor_project' and status = 'waiting'), 0,
  'no card 3 while the look check runs');
update public.tasks set status = 'done', output = '{"pass":true,"round":0,"note":"","files":[]}'
where kind = 'look_check' and payload->>'ref_id' = 'e2072000-0000-4000-8000-00000000000c';
select is((select snapshot->>'render_path' from public.approvals where ref_kind = 'editor_project' and status = 'waiting'), 'u/ai.mp4',
  'the render raises card 3 with the video');
select is((select status from public.work_orders where id = (select id from t where name = 'video')), 'waiting_founder', 'the video order waits on you');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select is((select public.approval_decide(id, 'approve', jsonb_build_object('content_hash', content_hash))
  from public.approvals where ref_kind = 'editor_project' and status = 'waiting').status, 'approved', 'card 3 approved');
reset role;
select is((select kind || ' ' || ref_kind from public.deliverables where order_id = (select id from t where name = 'video')), 'video clip',
  'the edit is the order''s video deliverable');
select is((select status from public.work_orders where id = (select id from t where name = 'video')), 'done', 'the video order is done');
select is((select count(*)::int from public.work_orders where kind = 'cut_shorts' and brief->>'clip_id' = 'e2072000-0000-4000-8000-00000000000c'), 1,
  'and the finished video gets its shorts order');

-- Sending a batch back fails its order with the reason, for the replan.
update public.editor_projects set document = '{"version":1,"stage":{"name":"ai v2"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v2"}}'));
insert into t select 'order2', id from public.work_orders where kind = 'cut_shorts' and brief->>'finished_hash' = pg_temp.h('{"version":1,"stage":{"name":"ai v2"}}');
insert into t select 'batch2', (public.short_batch_create('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v2"}}'),
  (select id from t where name = 'order2'),
  '[{"source_start":0,"source_end":20,"hook":"Hook","title":"One","reason":"Why","document":{"version":1}}]'::jsonb)->>'batch_id')::uuid;
reset role;
insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload)
select 'e2070000-0000-4000-8000-00000000000a', 'render_document', short_clip_id, 'e2071000-0000-4000-8000-00000000000c', 'running', gen_random_uuid(), '{}'
from public.shorts where batch_id = (select id from t where name = 'batch2');
update public.tasks set status = 'done' where kind = 'render_document' and status = 'running';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select is((select public.approval_decide(id, 'send_back', jsonb_build_object('content_hash', content_hash, 'reason', 'Hooks are too slow'))
  from public.approvals where ref_kind = 'short_batch' and status = 'waiting').reason, 'Hooks are too slow', 'send back keeps the reason');
reset role;
select is((select error->>'code' || ': ' || (error->>'message') from public.work_orders where id = (select id from t where name = 'order2')),
  'sent_back: Hooks are too slow', 'the order fails with it, for one replan');

-- A short whose render could not be queued fails at once, and its batch settles.
update public.editor_projects set document = '{"version":1,"stage":{"name":"ai v3"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v3"}}'));
insert into t select 'order3', id from public.work_orders where kind = 'cut_shorts' and brief->>'finished_hash' = pg_temp.h('{"version":1,"stage":{"name":"ai v3"}}');
insert into t select 'batch3', (public.short_batch_create('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v3"}}'),
  (select id from t where name = 'order3'),
  '[{"source_start":0,"source_end":20,"hook":"Hook","title":"One","reason":"Why","document":{"version":1}}]'::jsonb)->>'batch_id')::uuid;
select public.short_render_refused((select id from public.shorts where batch_id = (select id from t where name = 'batch3')));
select public.short_render_refused((select id from public.shorts where batch_id = (select id from t where name = 'batch3')));
reset role;
select is((select status from public.short_batches where id = (select id from t where name = 'batch3')), 'failed',
  'a batch whose only short could not render fails instead of waiting forever');
select is((select error->>'code' from public.work_orders where id = (select id from t where name = 'order3')), 'render_failed',
  'and so does its order');

-- Mark finished in the editor finishes a video order waiting on card 3, as approving the card does.
select public.work_order_create('e2070000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date,
  (select id from public.work_orders where user_id = 'e2070000-0000-4000-8000-00000000000a' and parent_id is null),
  'build_video', 'AI video again', '{}', 0);
insert into t select 'video2', id from public.work_orders where kind = 'build_video' and title = 'AI video again';
select public.work_order_move((select id from t where name = 'video2'), 'running');
insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status, decision, next)
values ('e2070000-0000-4000-8000-00000000000a', 'e2072000-0000-4000-8000-00000000000a', 'animate_video', 'price', '{}', '{"seconds":60}', 24,
  (select id from t where name = 'video2'), 'done', 'approve', '{"tool":"render"}');
update public.editor_projects set document = '{"version":1,"stage":{"name":"launch v3"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000a';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000a', pg_temp.h('{"version":1,"stage":{"name":"launch v3"}}'));
reset role;
select is((select status from public.work_orders where id = (select id from t where name = 'video2')), 'done',
  'Mark finished in the editor finishes the video order too');

-- Only the brain's runner creates batches and reports refused renders.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.short_batch_create('e2072000-0000-4000-8000-00000000000c', repeat('a', 64), null,
  '[{"source_start":0,"source_end":20,"hook":"h","title":"t","reason":"r","document":{}}]') $$, '42501', null,
  'a founder cannot create a shorts batch');
select throws_ok($$ select public.short_render_refused(gen_random_uuid()) $$, '42501', null, 'nor report a refused render');
reset role;

-- Mark finished while card 2 still waits: the edit is finished, the order (not yet rendered) goes on.
select public.work_order_create('e2070000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date, (select id from public.work_orders where user_id = 'e2070000-0000-4000-8000-00000000000a' and parent_id is null), 'build_video', 'AI video 3', '{}', 0);
insert into t select 'video3', id from public.work_orders where kind = 'build_video' and title = 'AI video 3';
select public.work_order_move((select id from t where name = 'video3'), 'running');
insert into public.studio_steps (user_id, clip_id, tool, kind, input, card, price_credits, order_id, status)
values ('e2070000-0000-4000-8000-00000000000a', 'e2072000-0000-4000-8000-00000000000c', 'animate_video', 'price', '{}', '{"seconds":60}', 24, (select id from t where name = 'video3'), 'waiting');
update public.editor_projects set document = '{"version":1,"stage":{"name":"ai v5"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v5"}}'));
reset role;
select is((select status from public.work_orders where id = (select id from t where name = 'video3')), 'running',
  'a video order whose card 2 still waits is not finished by Mark finished');

-- Sending card 3 back fails the video order with the reason, for the replan.
update public.studio_steps set status = 'done', decision = 'approve', next = '{"tool":"render"}'
where order_id = (select id from t where name = 'video3');
update public.editor_projects set document = '{"version":1,"stage":{"name":"ai v6"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
insert into public.tasks (user_id, kind, clip_id, job_id, status, request_id, payload, settings_hash, duration)
values ('e2070000-0000-4000-8000-00000000000a', 'render_document', 'e2072000-0000-4000-8000-00000000000c', 'e2071000-0000-4000-8000-00000000000c', 'running', gen_random_uuid(), '{}', pg_temp.h('{"version":1,"stage":{"name":"ai v6"}}'), 60);
update public.tasks set status = 'done', output_path = 'u/ai6.mp4', finished_at = now() where kind = 'render_document' and status = 'running' and clip_id = 'e2072000-0000-4000-8000-00000000000c';
update public.tasks set status = 'done', output = '{"pass":true,"round":0,"note":"","files":[]}'
where kind = 'look_check' and status = 'queued' and payload->>'ref_id' = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select is((select public.approval_decide(id, 'send_back', jsonb_build_object('content_hash', content_hash, 'reason', 'Too slow'))
  from public.approvals where ref_kind = 'editor_project' and status = 'waiting').status, 'skipped', 'card 3 sent back');
reset role;
select is((select status || ' ' || (error->>'code') || ': ' || (error->>'message') from public.work_orders where id = (select id from t where name = 'video3')),
  'failed sent_back: Too slow', 'the video order fails with the reason instead of waiting on nothing');

-- Cut shorts runs the Clip editor: at most 10 orders a day.
select public.work_order_create('e2070000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date, (select id from public.work_orders where user_id = 'e2070000-0000-4000-8000-00000000000a' and parent_id is null), 'cut_shorts', 'filler', '{}', 0)
from generate_series(1, 10);
update public.editor_projects set document = '{"version":1,"stage":{"name":"ai v7"}}' where clip_id = 'e2072000-0000-4000-8000-00000000000c';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2070000-0000-4000-8000-00000000000a","role":"authenticated","opencmo_actor":"brain"}';
select public.mark_finished('e2072000-0000-4000-8000-00000000000c', pg_temp.h('{"version":1,"stage":{"name":"ai v7"}}'));
select throws_ok($$ select public.cut_shorts_order('e2072000-0000-4000-8000-00000000000c') $$, 'P0001', 'You can cut shorts 10 times a day. Try again tomorrow.',
  'the eleventh Cut shorts of the day is refused');
reset role;

select * from finish();
rollback;
