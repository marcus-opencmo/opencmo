-- Review R3 (20270102010000): a subscription refused three times in a row is dropped, a success resets the count,
-- 404/410 still drops at once, and failing rows come after healthy ones in push_due.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(10);

select ok(not has_function_privilege('authenticated', 'public.push_done(uuid,integer)', 'execute'), 'only the cron records pushes');
select ok(not has_function_privilege('authenticated', 'public.push_due(integer)', 'execute'), 'only the cron lists them');

insert into auth.users (id, email) values ('e2380000-0000-4000-8000-00000000000a', 'r3push@test.local');
insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) values
  ('e2381000-0000-4000-8000-00000000000a', 'e2380000-0000-4000-8000-00000000000a', 'https://fcm.googleapis.com/fcm/send/a', repeat('A', 87), repeat('b', 22), now() - interval '1 day'),
  ('e2381000-0000-4000-8000-00000000000b', 'e2380000-0000-4000-8000-00000000000a', 'https://updates.push.services.mozilla.com/wpush/v2/b', repeat('A', 87), repeat('b', 22), now() - interval '1 day');
insert into public.approvals (user_id, kind, department, ref_kind, ref_id, snapshot, content_hash) values
  ('e2380000-0000-4000-8000-00000000000a', 'goal', 'brain', 'goal', gen_random_uuid(), '{"kind":"goal"}', repeat('a', 64));

-- Two refusals: still kept, counted.
select ok(public.push_done('e2381000-0000-4000-8000-00000000000a', 403), 'a first refusal keeps the browser');
select ok(public.push_done('e2381000-0000-4000-8000-00000000000a', 401), 'a second one too');
select is((select failures::int from public.push_subscriptions where id = 'e2381000-0000-4000-8000-00000000000a'), 2, 'two in a row are counted');
-- Failing rows come after healthy ones.
select is((select subscription_id from public.push_due(1)), 'e2381000-0000-4000-8000-00000000000b'::uuid, 'the healthy browser comes first');
-- The third refusal in a row drops it.
select ok(not public.push_done('e2381000-0000-4000-8000-00000000000a', 400), 'the third refusal drops it');
select is((select count(*)::int from public.push_subscriptions where id = 'e2381000-0000-4000-8000-00000000000a'), 0, 'gone');

-- A success in between resets the count.
select ok(public.push_done('e2381000-0000-4000-8000-00000000000b', 403) and public.push_done('e2381000-0000-4000-8000-00000000000b', 403)
  and public.push_done('e2381000-0000-4000-8000-00000000000b', 201), 'two refusals then a success');
select is((select failures::int from public.push_subscriptions where id = 'e2381000-0000-4000-8000-00000000000b'), 0, 'a success starts the count again');

select * from finish();
rollback;
