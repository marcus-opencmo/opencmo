-- P6 (20270101103000): a Hacker News thread saves with its own URL shape and its card says so; Reddit cards keep
-- their snapshot; an X thread is 5 to 8 posts of at most 280 starting with the post, only on X; its card and its
-- schedule content carry the posts, and the hash follows them; email claims take a per-founder lock.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(16);

insert into auth.users (id, email) values ('e2320000-0000-4000-8000-00000000000a', 'p6thread@test.local');

-- Hacker News.
select is(public.cmo_save_opportunities('e2320000-0000-4000-8000-00000000000a', null, '[
  {"platform":"hn","url":"https://news.ycombinator.com/item?id=4242","title":"Ask HN: editing demos?","score":80,"reply":"Cut the silences first."},
  {"url":"https://www.reddit.com/r/saas/comments/b1/","community":"r/SaaS","title":"Editing?","score":75,"reply":"Captions help."}
]'), 2, 'an HN thread and a Reddit thread save');
select is((select platform from public.opportunities where url like 'https://news.%'), 'hn', 'the HN row says hn');
select throws_ok($$ insert into public.opportunities (user_id, platform, url, title, score, reply)
  values ('e2320000-0000-4000-8000-00000000000a', 'reddit', 'https://news.ycombinator.com/item?id=1', 'x', 1, 'y') $$,
  '23514', null, 'an HN URL on a Reddit row is refused');
select throws_ok($$ insert into public.opportunities (user_id, platform, url, title, score, reply)
  values ('e2320000-0000-4000-8000-00000000000a', 'hn', 'https://www.reddit.com/r/a/comments/1/', 'x', 1, 'y') $$,
  '23514', null, 'a Reddit URL on an HN row is refused');
select throws_ok($$ insert into public.opportunities (user_id, platform, url, title, score, reply)
  values ('e2320000-0000-4000-8000-00000000000a', 'hn', 'https://news.ycombinator.com/item?id=1&x=https://evil', 'x', 1, 'y') $$,
  '23514', null, 'only a bare HN item link');
select is(public.approval_snapshot('opportunity', (select id from public.opportunities where platform = 'hn'))->>'platform', 'hn',
  'an HN reply card says hn');
select ok(not (public.approval_snapshot('opportunity', (select id from public.opportunities where platform = 'reddit')) ? 'platform'),
  'a Reddit card keeps the snapshot it had');

-- X threads.
create temp table d (n text, id uuid) on commit drop;
insert into d select 'thread', (public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'Thread',
  '{"text":"Hook: 5 ways to cut a demo.","thread":["Hook: 5 ways to cut a demo.","1. Cut the silences.","2. Captions.","3. B-roll.","4. A hook."],"rationale":"r"}',
  'medium', 'x')).id;
select is((public.approval_snapshot('content_item', (select id from d where n = 'thread'))->'thread'->>4), '4. A hook.',
  'the post card carries the thread');
select throws_ok($$ select public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'T',
  '{"text":"a","thread":["a","b","c","d"]}', 'medium', 'x') $$, '22023',
  'A thread has 5 to 8 posts of at most 280 characters, the first being the post.', 'at least 5 posts');
select throws_ok(format($$ select public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'T',
  '{"text":"a","thread":["a","b","c","d","%s"]}', 'medium', 'x') $$, repeat('é', 281)), '22023', null, 'each post at most 280');
select lives_ok(format($$ select public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'T',
  '{"text":"a","thread":["a","b","c","d","%s"]}', 'medium', 'x') $$, repeat('é', 280)), '280 characters count as code points');
select throws_ok($$ select public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'T',
  '{"text":"other","thread":["a","b","c","d","e"]}', 'medium', 'x') $$, '22023', null, 'the first post is the text');
select throws_ok($$ select public.cmo_save_draft('e2320000-0000-4000-8000-00000000000a', null, null, 'T',
  '{"text":"a","thread":["a","b","c","d","e"]}', 'medium', 'linkedin') $$, '22023', 'Only an X post can be a thread.',
  'only on X');

-- Publishing carries the thread, and the hash follows it.
insert into public.work_orders (id, user_id, week, kind, title, brief, department, status) values
  ('e2322000-0000-4000-8000-00000000000a', 'e2320000-0000-4000-8000-00000000000a', date_trunc('week', current_date)::date,
   'post_draft', 'Posts', '{}', 'writer', 'done');
insert into public.deliverables (id, user_id, order_id, kind, ref_kind, ref_id, status)
values ('e2321000-0000-4000-8000-00000000000a', 'e2320000-0000-4000-8000-00000000000a', 'e2322000-0000-4000-8000-00000000000a',
  'post', 'content_item', (select id from d where n = 'thread'), 'decided');
create temp table h as select public.schedule_content('e2321000-0000-4000-8000-00000000000a', 'x') as c;
select is(jsonb_array_length((select c->'thread' from h)), 5, 'the schedule content carries the thread');
update public.content_items set body = jsonb_set(body, '{thread,2}', '"2. Captions, big."') where id = (select id from d where n = 'thread');
select isnt(public.schedule_content('e2321000-0000-4000-8000-00000000000a', 'x')->>'content_hash', (select c->>'content_hash' from h),
  'changing a post of the thread changes the hash');

select lives_ok($$ select * from public.email_log_claim('e2320000-0000-4000-8000-00000000000a', 'digest', '{}') $$,
  'a claim takes the lock and returns nothing to send');

select * from finish();
rollback;
