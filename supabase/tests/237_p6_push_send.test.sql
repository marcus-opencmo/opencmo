-- P6 C1 (20270101160000): a browser is due a push only for cards newer than its last push, never with push off; a
-- 404/410 drops it, a success stamps it, another failure only marks it.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(10);

select ok(not has_function_privilege('authenticated', 'public.push_due(integer)', 'execute'), 'only the cron lists pushes');
select ok(not has_function_privilege('authenticated', 'public.push_done(uuid,integer)', 'execute'), 'only the cron records them');

insert into auth.users (id, email) values ('e2370000-0000-4000-8000-00000000000a', 'p6push@test.local');
insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) values
  ('e2371000-0000-4000-8000-00000000000a', 'e2370000-0000-4000-8000-00000000000a', 'https://fcm.googleapis.com/fcm/send/a', repeat('A', 87), repeat('b', 22), now() - interval '1 day'),
  ('e2371000-0000-4000-8000-00000000000b', 'e2370000-0000-4000-8000-00000000000a', 'https://updates.push.services.mozilla.com/wpush/v2/b', repeat('A', 87), repeat('b', 22), now() - interval '1 day');
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 0, 'no waiting card, no push');

insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash) values
  ('e2370000-0000-4000-8000-00000000000a', 'goal', 'brain', 'goal', gen_random_uuid(), '{"kind":"goal"}', repeat('a', 64));
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 2, 'a new card: each browser once');

select ok(public.push_done('e2371000-0000-4000-8000-00000000000a', 201), 'a success is stamped');
select ok(not public.push_done('e2371000-0000-4000-8000-00000000000b', 410), 'a gone browser is dropped');
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 0,
  'nothing again until the next new card');

update public.push_subscriptions set last_pushed_at = now() - interval '1 hour' where user_id = 'e2370000-0000-4000-8000-00000000000a';
-- Review fix 5: a card held yesterday and released now is new to the browser, though it was raised before the push.
update public.approvals set created_at = now() - interval '2 hours' where user_id = 'e2370000-0000-4000-8000-00000000000a';
insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash, status, held_until, created_at) values
  ('e2370000-0000-4000-8000-00000000000a', 'goal', 'brain', 'goal', gen_random_uuid(), '{"kind":"goal"}', repeat('c', 64), 'held',
   now() - interval '1 minute', now() - interval '1 day');
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 0, 'a held card is not pushed');
select public.approval_release_held();
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 1,
  'once released, it is pushed');
insert into public.notify_settings (user_id, push) values ('e2370000-0000-4000-8000-00000000000a', false);
select is((select count(*)::int from public.push_due(100) where user_id = 'e2370000-0000-4000-8000-00000000000a'), 0, 'push turned off: none');

select * from finish();
rollback;
