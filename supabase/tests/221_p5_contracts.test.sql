-- P5 A0 (20261231090000): the subreddit rules cache is shared and written only by the scan; Sales settings are the
-- founder's own and checked; the new kinds exist; a slideshow is its own edit; a slideshow step raises one Studio card
-- whose hash follows the document; a reply card carries its rule and a skipped thread raises none.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(42);

-- Grants and RLS.
select ok(not has_table_privilege('authenticated', 'public.subreddit_rules', 'insert'), 'a founder does not write subreddit rules');
select ok(has_table_privilege('authenticated', 'public.subreddit_rules', 'select'), 'a founder reads them');
select ok(not has_table_privilege('anon', 'public.sales_settings', 'select'), 'anon reads no Sales settings');
select ok(not has_table_privilege('authenticated', 'public.sales_settings', 'update'), 'settings change only through the RPC');
select ok(has_function_privilege('authenticated', 'public.sales_settings_save(text[],jsonb)', 'execute'), 'a founder saves settings');
select ok(not has_function_privilege('anon', 'public.create_slideshow(text,text,uuid)', 'execute'), 'anon creates no slideshow');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.subreddit_rules'::regclass,
  'public.sales_settings'::regclass)), 'RLS on both');

-- The rules cache.
insert into public.subreddit_rules (subreddit, verdict, summary) values ('saas', 'help_only', 'r/SaaS forbids self-promotion');
select throws_ok($$ insert into public.subreddit_rules (subreddit, verdict) values ('SaaS', 'skip') $$, '23514', null,
  'subreddit names are stored lowercase');
select throws_ok($$ insert into public.subreddit_rules (subreddit, verdict) values ('other', 'maybe') $$, '23514', null,
  'three verdicts only');

insert into auth.users (id, email) values
  ('e2210000-0000-4000-8000-00000000000a', 'p5a0@test.local'),
  ('e2210000-0000-4000-8000-00000000000b', 'p5a0-other@test.local');

-- Sales settings, as the founder.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2210000-0000-4000-8000-00000000000a","role":"authenticated"}';
select is((public.sales_settings_save(array['r/SaaS', ' Entrepreneur ', 'saas'], '[["Video", " editor "]]')).excluded_subreddits,
  array['entrepreneur', 'saas'], 'names are trimmed, lowercased, without r/ and deduplicated');
select is((select co_occurrence from public.sales_settings), '[["video", "editor"]]'::jsonb, 'pairs are trimmed and lowercased');
select is((select count(*)::int from public.subreddit_rules), 1, 'a founder reads the shared rules');
select throws_ok($$ select public.sales_settings_save(array['no spaces here'], '[]') $$, '22023',
  'A subreddit name has 2 to 21 letters, digits or underscores.', 'a bad subreddit name is refused');
select throws_ok($$ select public.sales_settings_save('{}', '[["one"]]') $$, '22023', 'Each pair has exactly two terms.',
  'a pair has two terms');
select throws_ok($$ select public.sales_settings_save('{}', '[["same", "Same"]]') $$, '22023', null, 'the two terms differ');
select throws_ok($$ select public.sales_settings_save('{}', '{"a":1}') $$, '22023', 'Term pairs must be a list.', 'pairs are a list');
select throws_ok($$ select public.sales_settings_save(array(select 'sub' || g from generate_series(1, 51) g), '[]') $$, '22023',
  'Exclude at most 50 subreddits.', 'at most 50 excluded subreddits');
select lives_ok($$ select public.sales_settings_save('{}', '[]') $$, 'saving again replaces the settings');
set local request.jwt.claims = '{"sub":"e2210000-0000-4000-8000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.sales_settings), 0, 'another founder reads none of them');

-- A slideshow is its own kind of edit.
set local request.jwt.claims = '{"sub":"e2210000-0000-4000-8000-00000000000a","role":"authenticated"}';
create temp table s (id uuid) on commit drop;
grant all on s to authenticated;
insert into s select public.create_slideshow('Launch slides', '9:16');
select is((select kind from public.clips where id = (select id from s)), 'slideshow', 'create_slideshow makes a slideshow clip');
select throws_ok($$ select public.create_slideshow('x', '4:3') $$, '22023', null, 'the frame is checked');
select is(public.rename_blank_edit((select id from s), 'Launch v2'), 'Launch v2', 'a slideshow can be renamed');
reset role;

-- New kinds.
select lives_ok($$ insert into public.cmo_insights (user_id, kind, body)
  values ('e2210000-0000-4000-8000-00000000000a', 'niche_video', '{"hook":"x","url":"https://www.tiktok.com/@a/video/1"}') $$,
  'cmo_insights takes niche_video');
select throws_ok($$ insert into public.cmo_insights (user_id, kind, body) values ('e2210000-0000-4000-8000-00000000000a', 'reels', '{}') $$,
  '23514', null, 'and nothing else new');
select ok(exists (select 1 from pg_constraint where conname = 'deliverables_kind_check' and pg_get_constraintdef(oid) like '%image%'),
  'deliverables take image');
select ok(exists (select 1 from pg_constraint where conname = 'tasks_kind_check' and pg_get_constraintdef(oid) like '%render_stills%'),
  'tasks take render_stills');

-- A slideshow step raises one Studio card; editing the document supersedes it.
insert into public.editor_projects (clip_id, document) values ((select id from s), '{"version":1,"stage":{"name":"slides"}}');
insert into public.studio_steps (id, user_id, clip_id, tool, kind, input, card, price_credits, status)
values ('e2213000-0000-4000-8000-00000000000a', 'e2210000-0000-4000-8000-00000000000a', (select id from s), 'build_slideshow',
  'slideshow', '{}', '{"title":"Launch","aspect":"9:16","slides":[{"text":"Cut by words","still_path":null,"seconds":3}],"mp4_path":null,"png_set_path":null}',
  0, 'waiting');
select is((select kind || '/' || department from public.approvals where ref_id = 'e2213000-0000-4000-8000-00000000000a' and status = 'waiting'),
  'slideshow/studio', 'a slideshow card in Studio');
select is((select snapshot->'slides'->0->>'text' from public.approvals where ref_id = 'e2213000-0000-4000-8000-00000000000a'),
  'Cut by words', 'the card carries the slides');
select ok((select snapshot->>'document_hash' from public.approvals where ref_id = 'e2213000-0000-4000-8000-00000000000a') ~ '^[0-9a-f]{64}$',
  'and the hash of the document');
update public.editor_projects set document = '{"version":1,"stage":{"name":"slides v2"}}' where clip_id = (select id from s);
select public.approval_raise('e2210000-0000-4000-8000-00000000000a', 'studio_step', 'e2213000-0000-4000-8000-00000000000a');
select is((select count(*)::int from public.approvals where ref_id = 'e2213000-0000-4000-8000-00000000000a' and status = 'cancelled'), 1,
  'an edited slideshow supersedes its card');

-- Sales rule on a reply; a skipped thread has no draft and no card.
insert into public.opportunities (id, user_id, url, title, score, reply, rule, rule_why) values
  ('e2214000-0000-4000-8000-00000000000a', 'e2210000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/saas/comments/a1/', 'Editing?', 80,
   'Cut the silences first.', 'help_only', 'r/SaaS forbids self-promotion'),
  ('e2214000-0000-4000-8000-00000000000b', 'e2210000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/memes/comments/a2/', 'Lol', 70,
   null, 'skip', 'r/memes allows no business talk');
select is(public.approval_snapshot('opportunity', 'e2214000-0000-4000-8000-00000000000a')->>'rule', 'help_only', 'a reply card carries its rule');
select is(public.approval_snapshot('opportunity', 'e2214000-0000-4000-8000-00000000000b'), null, 'a skipped thread has no card');
select throws_ok($$ insert into public.opportunities (user_id, url, title, score, reply, rule)
  values ('e2210000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/saas/comments/a3/', 'x', 70, null, 'help_only') $$,
  '23514', null, 'only a skipped thread goes without a draft');

-- Still export (B2's queue): the owner's saved revision only, one task per request id, three-level paths.
select ok((select 'image/png' = any(allowed_mime_types) and 'application/zip' = any(allowed_mime_types)
  from storage.buckets where id = 'exports'), 'exports takes PNG and zip');
insert into public.editor_revisions (id, clip_id, number, source_hash, document)
values ('e2215000-0000-4000-8000-00000000000a', (select id from s), 1, repeat('a', 64), '{"version":1}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2210000-0000-4000-8000-00000000000a","role":"authenticated"}';
create temp table st as select * from public.request_stills_export((select id from s), 'e2215000-0000-4000-8000-00000000000a',
  'e2216000-0000-4000-8000-00000000000a');
select is((select kind || ' ' || status from st), 'render_stills queued', 'a still export is queued');
select is((select payload->>'object' from st),
  'e2210000-0000-4000-8000-00000000000a/' || (select id from s) || '/' || (select id from st) || '.zip', 'the zip sits at <user>/<clip>/<task>.zip');
select is((select id from public.request_stills_export((select id from s), 'e2215000-0000-4000-8000-00000000000a',
  'e2216000-0000-4000-8000-00000000000a')), (select id from st), 'the same request id returns the same task');
select throws_ok($$ select public.request_stills_export((select id from s), gen_random_uuid(), gen_random_uuid()) $$,
  'P0002', 'Save the project before exporting it.', 'only a saved revision');
set local request.jwt.claims = '{"sub":"e2210000-0000-4000-8000-00000000000b","role":"authenticated"}';
select throws_ok($$ select public.request_stills_export((select id from s), 'e2215000-0000-4000-8000-00000000000a', gen_random_uuid()) $$,
  null, null, 'another founder cannot export it');
reset role;

-- New order kinds.
select is(public.work_order_department('build_slideshow'), 'studio', 'build_slideshow is Studio''s');
select is(public.work_order_department('build_post_image'), 'studio', 'build_post_image is Studio''s');
select is(public.work_order_department('niche_video_research'), 'research', 'niche_video_research is Research''s');

select * from finish();
rollback;
