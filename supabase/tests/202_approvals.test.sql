-- Approval A0 (20261227100000): cards mirror posts, replies, goals and rules; a changed snapshot supersedes its
-- card and refuses an old hash; a card is decided once, by its owner, through the existing RPCs.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(43);

-- JCS is the same as canonicalJson() in apps/web/lib/settings-schema.ts (string computed there).
select is(public.jcs('{"b":1,"a":[true,null,"x\ny \"q\" \\ \u0001"],"é":"é ✓","A":{"z":[],"y":{}},"n":-12}'::jsonb),
  '{"A":{"y":{},"z":[]},"a":[true,null,"x\ny \"q\" \\ \u0001"],"b":1,"n":-12,"é":"é ✓"}', 'jcs sorts keys and keeps JSON escapes');
select is(public.approval_hash('{"b":1,"a":[true,null,"x\ny \"q\" \\ \u0001"],"é":"é ✓","A":{"z":[],"y":{}},"n":-12}'::jsonb),
  '160eb0b51cbda83fc6bd29d0e038b05c65041a66baaef43f4d39e42603888c6a', 'the hash is sha256 of the JCS text');

-- Grants, RLS, Realtime.
select ok(has_table_privilege('authenticated', 'public.approvals', 'select'), 'founders read cards');
select ok(not has_table_privilege('authenticated', 'public.approvals', 'insert'), 'founders cannot insert cards');
select ok(not has_table_privilege('authenticated', 'public.approvals', 'update'), 'founders cannot update cards');
select ok(not has_table_privilege('anon', 'public.approvals', 'select'), 'anon reads nothing');
select ok(not has_function_privilege('authenticated', 'public.approval_raise(uuid,text,uuid)', 'execute'), 'only triggers raise cards');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'approvals'), 'cards stream over Realtime');

insert into auth.users (id, email) values
  ('e2020000-0000-4000-8000-00000000000a', 'a0@test.local'),
  ('e2020000-0000-4000-8000-00000000000b', 'a0-other@test.local');

create temp table t_ref (name text primary key, id uuid) on commit drop;
grant all on t_ref to authenticated;
create function pg_temp.post(p_name text, p_text text) returns uuid language sql as $$
  insert into public.content_items (user_id, department, platform, day, idea, status, body)
  values ('e2020000-0000-4000-8000-00000000000a', 'post', 'x', current_date, p_name, 'in_review',
          jsonb_build_object('text', p_text, 'alternates', jsonb_build_array(p_text || ' (v2)')))
  returning id
$$;
create function pg_temp.card(p_ref uuid) returns public.approvals language sql as $$
  select * from public.approvals where ref_id = p_ref and status = 'waiting'
$$;
create function pg_temp.hash(p_ref uuid) returns text language sql as $$ select (pg_temp.card(p_ref)).content_hash $$;

-- A post in review raises a card; a redraft supersedes it.
insert into t_ref values ('p1', pg_temp.post('p1', 'Most AI video tools stop at the first draft.'));
select is((pg_temp.card((select id from t_ref where name = 'p1'))).kind, 'post', 'a post in review raises a post card');
select is((pg_temp.card((select id from t_ref where name = 'p1'))).department, 'writer', 'raised by Writer');
create temp table t_old (hash text) on commit drop;
grant all on t_old to authenticated;
insert into t_old select pg_temp.hash((select id from t_ref where name = 'p1'));
update public.content_items set body = jsonb_set(body, '{text}', '"We built the editor first."') where id = (select id from t_ref where name = 'p1');
select is((select count(*)::int from public.approvals where ref_id = (select id from t_ref where name = 'p1')), 2, 'a redraft raises a new card');
select is((select status from public.approvals where content_hash = (select hash from t_old)), 'cancelled', 'and supersedes the old one');
update public.content_items set priority = 'high' where id = (select id from t_ref where name = 'p1');
select is((select count(*)::int from public.approvals where ref_id = (select id from t_ref where name = 'p1')), 2, 'a change the card does not show raises nothing');

insert into t_ref values ('p2', pg_temp.post('p2', 'Cut by words.'));
insert into t_ref values ('p3', pg_temp.post('p3', 'Ask for B-roll.'));
insert into t_ref values ('p4', pg_temp.post('p4', 'Edit by asking.'));
insert into t_ref values ('p5', pg_temp.post('p5', 'Through MCP.'));
insert into t_ref values ('p6', pg_temp.post('p6', 'Old path.'));
insert into t_ref values ('p7', pg_temp.post('p7', 'Deleted.'));
with x as (insert into public.opportunities (user_id, url, title, score, reply)
  values ('e2020000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/SaaS/comments/a0/', 'What do you use to edit demos?', 78, 'Same problem here.') returning id)
insert into t_ref select 'o1', id from x;
with x as (insert into public.opportunities (user_id, url, title, score, reply)
  values ('e2020000-0000-4000-8000-00000000000a', 'https://www.reddit.com/r/SaaS/comments/a1/', 'Agencies only?', 40, 'Not for us.') returning id)
insert into t_ref select 'o2', id from x;
-- Eleven cards in one day here: start the day's budget again (P6 A4; the budget has its own test, 235).
delete from public.card_budget where user_id = 'e2020000-0000-4000-8000-00000000000a';
insert into t_ref select 'g1', (public.cmo_put_goal('e2020000-0000-4000-8000-00000000000a', null,
  date_trunc('week', current_date)::date, 'Publish 3 posts on X', 'posts', 3)).id;
insert into t_ref select 'c1', (public.cmo_propose_correction('e2020000-0000-4000-8000-00000000000a', 'No question openers.')).id;
select is((pg_temp.card((select id from t_ref where name = 'o1'))).kind, 'reply', 'a Reddit thread raises a reply card');
select is((pg_temp.card((select id from t_ref where name = 'g1'))).kind, 'goal', 'a proposed goal raises a goal card');
select is((pg_temp.card((select id from t_ref where name = 'c1'))).kind, 'correction', 'a proposed rule raises a correction card');
select is(public.approvals_backfill(), 0, 'the backfill raises nothing twice');

-- Deciding as the owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2020000-0000-4000-8000-00000000000a"}';
create temp table t_card (name text primary key, id uuid, hash text) on commit drop;
insert into t_card select r.name, a.id, a.content_hash from t_ref r join public.approvals a on a.ref_id = r.id and a.status = 'waiting';
select is((select count(*)::int from public.approvals where status = 'waiting'), 11, 'the owner reads their waiting cards');

select throws_ok(format($$ select public.approval_decide(%L, 'approve', '{"content_hash":"%s"}') $$,
  (select id from t_card where name = 'p1'), (select hash from t_old)), 'P0001',
  'This card changed. Look at it again before deciding.', 'an old hash is refused');
select throws_ok(format($$ select public.approval_decide(%L, 'approve', '{}') $$, (select id from t_card where name = 'p1')), 'P0001',
  'This card changed. Look at it again before deciding.', 'no hash is refused');
select throws_ok(format($$ select public.approval_decide(%L, 'approve', jsonb_build_object('content_hash', %L, 'via', 'email')) $$,
  (select id from t_card where name = 'p1'), (select hash from t_card where name = 'p1')), '22023',
  'Cards are decided in the app or through MCP.', 'an email never decides');

create function pg_temp.decide(p_name text, p_action text, p_extra jsonb default '{}') returns public.approvals language sql as $$
  select public.approval_decide((select id from t_card where name = p_name), p_action,
    jsonb_build_object('content_hash', (select hash from t_card where name = p_name)) || p_extra)
$$;

select is((pg_temp.decide('p1', 'approve')).status, 'approved', 'approve as written');
select is((select status from public.content_items where id = (select id from t_ref where name = 'p1')), 'approved', 'the post is approved');
select is((select decided_via from public.approvals where id = (select id from t_card where name = 'p1')), 'app', 'decided in the app');
select throws_ok($$ select pg_temp.decide('p1', 'approve') $$, 'P0001', 'This card was already decided.', 'a card is decided once');
select is((pg_temp.decide('p2', 'approve', '{"text":"Cut a video by deleting words."}')).status, 'edited', 'changed words are an edit');
select is((pg_temp.decide('p3', 'approve', '{"text":"Ask for B-roll. (v2)"}')).status, 'approved', 'an alternate as written is not an edit');
select is((pg_temp.decide('p4', 'skip', '{"reason":"too salesy"}')).status, 'skipped', 'skip');
select is((pg_temp.decide('p5', 'approve', '{"via":"mcp"}')).decided_via, 'mcp', 'decided through MCP');
select throws_ok($$ select pg_temp.decide('o1', 'approve') $$, '22023', 'Choose replied or dismissed.', 'a reply has its own actions');
select is((pg_temp.decide('o1', 'replied')).status, 'approved', 'replied');
select is((pg_temp.decide('o2', 'dismissed', '{"reason":"agencies"}')).status, 'skipped', 'dismissed');
select throws_ok($$ select pg_temp.decide('g1', 'approve', '{"target":2.5}') $$, '22023', 'The target must be a whole number.',
  'a fraction is refused, not rounded');
select is((pg_temp.decide('g1', 'approve', '{"target":5}')).status, 'edited', 'a new target is an edit');
select is((select target from public.cmo_goals where id = (select id from t_ref where name = 'g1')), 5, 'the goal has the new target');
select is((pg_temp.decide('c1', 'approve')).status, 'approved', 'keep the rule');
select is((select status from public.cmo_corrections where id = (select id from t_ref where name = 'c1')), 'active', 'the rule is active');

-- The old RPC still works and closes the card.
select public.cmo_decide_post((select id from t_ref where name = 'p6'), 'skip');
select is((select status from public.approvals where id = (select id from t_card where name = 'p6')), 'skipped', 'the old decide RPC closes the card');

-- Someone else.
set local request.jwt.claims = '{"sub":"e2020000-0000-4000-8000-00000000000b"}';
select is((select count(*)::int from public.approvals), 0, 'another founder reads no cards');
select throws_ok($$ select pg_temp.decide('p7', 'approve') $$, 'P0002', 'Card not found.', 'another founder cannot decide');

-- A deleted row cancels its card; a kind without a decision path refuses.
reset role;
delete from public.content_items where id = (select id from t_ref where name = 'p7');
select is((select status from public.approvals where id = (select id from t_card where name = 'p7')), 'cancelled', 'a deleted post cancels its card');
insert into t_ref values ('p8', pg_temp.post('p8', 'Priced.'));
update public.approvals set kind = 'slideshow', department = 'studio' where ref_id = (select id from t_ref where name = 'p8') and status = 'waiting';
insert into t_card select 'p8', id, content_hash from public.approvals where ref_id = (select id from t_ref where name = 'p8') and status = 'waiting';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2020000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select pg_temp.decide('p8', 'approve') $$, 'P0001', 'This card was already decided.',
  'a slideshow card decides only its own slideshow step (P5)');
select is((select count(*)::int from public.approvals where status = 'waiting'), 1, 'only the slideshow card still waits');

select * from finish();
rollback;
