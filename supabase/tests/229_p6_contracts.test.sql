-- P6 A0 (20270101090000): the new tables are the founder's to read and nobody's to write directly; push subscriptions,
-- notify settings and unsubscribing go through RPCs that check their input; an email is claimed once (one digest a
-- day, one expiring email per card, only waiting cards of the founder); a card can be held; metrics, best slots and
-- reply outcomes have their columns.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(37);

-- Grants and RLS.
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.push_subscriptions'::regclass,
  'public.notify_settings'::regclass, 'public.email_log'::regclass, 'public.card_budget'::regclass,
  'public.account_metrics'::regclass, 'public.best_slots'::regclass)), 'RLS on every new table');
select ok(has_table_privilege('authenticated', 'public.account_metrics', 'select'), 'a founder reads account metrics');
select ok(not has_table_privilege('authenticated', 'public.push_subscriptions', 'insert'), 'push subscriptions only through the RPC');
select ok(not has_table_privilege('authenticated', 'public.email_log', 'insert'), 'a founder writes no email log');
select ok(not has_table_privilege('authenticated', 'public.best_slots', 'update'), 'a founder writes no best slots');
select ok(not has_table_privilege('anon', 'public.notify_settings', 'select'), 'anon reads no notify settings');
select ok(has_table_privilege('service_role', 'public.card_budget', 'insert'), 'the service role writes the card budget');
select ok(has_function_privilege('authenticated', 'public.push_subscribe(text,text,text,text)', 'execute'), 'a founder subscribes');
select ok(has_function_privilege('anon', 'public.email_unsubscribe(uuid)', 'execute'), 'an unsubscribe link works signed out');
select ok(not has_function_privilege('authenticated', 'public.email_log_claim(uuid,text,uuid[])', 'execute'), 'only the sender claims an email');
select ok(not has_function_privilege('anon', 'public.notify_settings_for(uuid)', 'execute'), 'anon reads no token');

insert into auth.users (id, email) values
  ('e2290000-0000-4000-8000-00000000000a', 'p6a0@test.local'),
  ('e2290000-0000-4000-8000-00000000000b', 'p6a0-other@test.local');

-- Push, as the founder.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2290000-0000-4000-8000-00000000000a","role":"authenticated"}';
create temp table s (id uuid) on commit drop;
grant all on s to authenticated;
insert into s select public.push_subscribe('https://fcm.googleapis.com/fcm/send/abc', repeat('A', 87), repeat('b', 22), 'Firefox');
select is((select count(*)::int from public.push_subscriptions), 1, 'the founder reads their subscription');
select is(public.push_subscribe('https://fcm.googleapis.com/fcm/send/abc', repeat('C', 87), repeat('d', 22), 'Firefox'), (select id from s),
  'subscribing again updates the same row');
select throws_ok($$ select public.push_subscribe('http://push.example/x', repeat('A', 87), repeat('b', 22), null) $$, '22023',
  'This browser''s push service is not supported.', 'an endpoint is https (and a push service, 230)');
select throws_ok($$ select public.push_subscribe('https://fcm.googleapis.com/fcm/send/y', 'short', repeat('b', 22), null) $$, '22023',
  'The push keys are not valid.', 'the keys are checked');
set local request.jwt.claims = '{"sub":"e2290000-0000-4000-8000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.push_subscriptions), 0, 'another founder reads none');
select ok(not public.push_unsubscribe('https://fcm.googleapis.com/fcm/send/abc'), 'and cannot remove it');
set local request.jwt.claims = '{"sub":"e2290000-0000-4000-8000-00000000000a","role":"authenticated"}';
select ok(public.push_unsubscribe('https://fcm.googleapis.com/fcm/send/abc'), 'the founder turns it off');

-- Notify settings.
select is((public.notify_settings_save(false, true)).email_digest, false, 'the founder turns the digest off');
select ok((select unsubscribed_at is not null from public.notify_settings), 'and it is stamped');
select is((public.notify_settings_save(true, true)).unsubscribed_at, null, 'turning it back on clears the stamp');
select throws_ok($$ select public.notify_settings_save(null, true) $$, '22023', 'Choose on or off for email and push.', 'both are given');
reset role;

-- Unsubscribing by token, signed out.
select ok((public.notify_settings_for('e2290000-0000-4000-8000-00000000000b')).unsubscribe_token is not null,
  'every founder gets a token on first use');
set local role anon;
select ok(public.email_unsubscribe(gen_random_uuid()), 'an unknown token answers the same');
reset role;
select is((select email_digest from public.notify_settings where user_id = 'e2290000-0000-4000-8000-00000000000a'), true,
  'an unknown token changes nothing');

-- Claiming an email.
insert into public.approvals (id, user_id, kind, department, ref_kind, ref_id, snapshot, content_hash) values
  ('e2290000-0000-4000-8000-0000000000c1', 'e2290000-0000-4000-8000-00000000000a', 'goal', 'brain', 'goal',
   gen_random_uuid(), '{"kind":"goal"}', repeat('a', 64)),
  ('e2290000-0000-4000-8000-0000000000c2', 'e2290000-0000-4000-8000-00000000000a', 'goal', 'brain', 'goal',
   gen_random_uuid(), '{"kind":"goal"}', repeat('b', 64)),
  ('e2290000-0000-4000-8000-0000000000c3', 'e2290000-0000-4000-8000-00000000000b', 'goal', 'brain', 'goal',
   gen_random_uuid(), '{"kind":"goal"}', repeat('c', 64));
select is((select approval_ids from public.email_log_claim('e2290000-0000-4000-8000-00000000000a', 'digest',
  array['e2290000-0000-4000-8000-0000000000c1', 'e2290000-0000-4000-8000-0000000000c3']::uuid[])),
  array['e2290000-0000-4000-8000-0000000000c1']::uuid[], 'a digest names only the founder''s own waiting cards');
select is((select count(*)::int from public.email_log_claim('e2290000-0000-4000-8000-00000000000a', 'digest',
  array['e2290000-0000-4000-8000-0000000000c2']::uuid[])), 0, 'one digest a day');
create temp table e (log_id uuid, approval_ids uuid[]) on commit drop;
insert into e select * from public.email_log_claim('e2290000-0000-4000-8000-00000000000a', 'expiring',
  array['e2290000-0000-4000-8000-0000000000c1', 'e2290000-0000-4000-8000-0000000000c2']::uuid[]);
select is((select cardinality(approval_ids) from e), 2, 'an expiring email names both cards');
select is((select approval_ids from public.email_log_claim('e2290000-0000-4000-8000-00000000000a', 'expiring',
  array['e2290000-0000-4000-8000-0000000000c1']::uuid[])), null, 'never twice for one card');
select lives_ok($$ select public.email_log_done((select log_id from e), 're_123', null) $$, 'the sender records Resend''s id');
select is((select status from public.email_log where id = (select log_id from e)), 'sent', 'the email is sent');
update public.notify_settings set email_digest = false where user_id = 'e2290000-0000-4000-8000-00000000000b';
select is((select count(*)::int from public.email_log_claim('e2290000-0000-4000-8000-00000000000b', 'expiring',
  array['e2290000-0000-4000-8000-0000000000c3']::uuid[])), 0, 'an unsubscribed founder gets no email');

-- Held cards, metrics, best slots, outcomes.
select throws_ok($$ update public.approvals set status = 'held' where id = 'e2290000-0000-4000-8000-0000000000c2' $$, '23514', null,
  'a held card says until when');
select lives_ok($$ update public.approvals set status = 'held', held_until = now() + interval '1 day'
  where id = 'e2290000-0000-4000-8000-0000000000c2' $$, 'a card can be held');
select throws_ok($$ insert into public.best_slots (user_id, platform, hour, median_views_per_hour, posts)
  values ('e2290000-0000-4000-8000-00000000000a', 'x', 24, 1, 10) $$, '23514', null, 'an hour is 0 to 23');
select has_column('public', 'cmo_draft_outcomes', 'outcome_votes', 'reply outcomes have votes');
select col_default_is('public', 'post_metrics', 'source', 'public', 'existing metrics are public readings');

select * from finish();
rollback;
