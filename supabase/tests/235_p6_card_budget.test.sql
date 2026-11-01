-- P6 A4 (20270101130000): ten new cards a local day; the eleventh is held until tomorrow and is not in the queue; a
-- replacement keeps its place and is not counted; a held card whose content changes is replaced, never doubled;
-- held cards come back oldest first within the next day's budget.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(17);

select ok(not has_function_privilege('authenticated', 'public.approval_release_held(integer)', 'execute'), 'only the cron releases held cards');
select ok(not has_function_privilege('authenticated', 'public.card_budget_take(uuid,boolean)', 'execute'), 'the budget is internal');

insert into auth.users (id, email) values ('e2350000-0000-4000-8000-00000000000a', 'p6budget@test.local');
update public.profiles set timezone = 'UTC' where id = 'e2350000-0000-4000-8000-00000000000a';

-- Twelve posts in review, each raising its card.
insert into public.content_items (id, user_id, department, platform, day, idea, status, body)
select ('e2352000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'e2350000-0000-4000-8000-00000000000a', 'post', 'X',
  current_date, 'Post ' || g, 'in_review', jsonb_build_object('text', 'Post number ' || g || '.')
from generate_series(1, 12) g;
delete from public.approvals where user_id = 'e2350000-0000-4000-8000-00000000000a';
delete from public.card_budget where user_id = 'e2350000-0000-4000-8000-00000000000a';
select public.approval_raise('e2350000-0000-4000-8000-00000000000a', 'content_item', id)
from public.content_items where user_id = 'e2350000-0000-4000-8000-00000000000a' order by id;

select is((select count(*)::int from public.approvals where user_id = 'e2350000-0000-4000-8000-00000000000a' and status = 'waiting'), 10,
  'ten cards wait');
select is((select count(*)::int from public.approvals where user_id = 'e2350000-0000-4000-8000-00000000000a' and status = 'held'), 2,
  'the rest are held');
select ok((select bool_and(held_until = (current_date + 1)::timestamptz) from public.approvals
  where user_id = 'e2350000-0000-4000-8000-00000000000a' and status = 'held'), 'until the start of tomorrow, local time');
select is((select raised || ':' || held from public.card_budget where user_id = 'e2350000-0000-4000-8000-00000000000a'), '10:2',
  'the day''s counter');

-- An edit of a waiting post replaces its card and is not counted; an edit of a held post stays held, once.
update public.content_items set body = '{"text":"Post number 1, edited."}' where id = 'e2352000-0000-4000-8000-000000000001';
select public.approval_raise('e2350000-0000-4000-8000-00000000000a', 'content_item', 'e2352000-0000-4000-8000-000000000001');
update public.content_items set body = '{"text":"Post number 12, edited."}' where id = 'e2352000-0000-4000-8000-000000000012';
select public.approval_raise('e2350000-0000-4000-8000-00000000000a', 'content_item', 'e2352000-0000-4000-8000-000000000012');
select is((select status from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000001' and status in ('waiting', 'held')), 'waiting',
  'a replaced waiting card waits');
select is((select count(*)::int from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000012' and status in ('waiting', 'held')), 1,
  'a held card whose content changed is replaced, not doubled');
select is((select status from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000012' and status in ('waiting', 'held')), 'held',
  'and the replacement is still held');
select is((select raised from public.card_budget where user_id = 'e2350000-0000-4000-8000-00000000000a'), 10, 'replacements are not counted');

-- Nothing is released before its day; tomorrow both come back, oldest first.
select is(public.approval_release_held(), 0, 'held cards wait for their day');
update public.approvals set held_until = now() - interval '1 minute' where user_id = 'e2350000-0000-4000-8000-00000000000a' and status = 'held';
-- Today's budget is spent, so releasing now only moves them to tomorrow.
select is(public.approval_release_held(), 0, 'no room today: they try tomorrow');
update public.approvals set held_until = now() - interval '1 minute' where user_id = 'e2350000-0000-4000-8000-00000000000a' and status = 'held';
update public.card_budget set raised = 9 where user_id = 'e2350000-0000-4000-8000-00000000000a';
select is(public.approval_release_held(), 1, 'one place left: the oldest comes back');

select ok((select released_at is not null and held_until is null from public.approvals
  where ref_id = 'e2352000-0000-4000-8000-000000000011' and status = 'waiting'), 'the released card says when it entered the queue');

-- Review fix 2: a held card closes with its row, so it never comes back for a deleted or decided post.
select is((select status from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000012' and status in ('waiting', 'held')), 'held',
  'post 12 is still held');
delete from public.content_items where id = 'e2352000-0000-4000-8000-000000000012';
select is((select count(*)::int from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000012' and status in ('waiting', 'held')), 0,
  'deleting its post closes the held card');
select is((select status from public.approvals where ref_id = 'e2352000-0000-4000-8000-000000000012' order by created_at desc limit 1), 'cancelled',
  'as cancelled');

select * from finish();
rollback;
