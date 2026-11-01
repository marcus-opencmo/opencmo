-- Review R4 (20270102020000): the new route buckets are allowlisted, the chat's research counts in SQL with a daily
-- ceiling shared with MCP, and cmo_enqueue merges only identical requests when there is no item or order.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(11);

insert into auth.users (id, email) values ('e2390000-0000-4000-8000-00000000000a', 'r4limits@test.local');
insert into public.credit_ledger(user_id, delta, reason) values ('e2390000-0000-4000-8000-00000000000a', 100, 'test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2390000-0000-4000-8000-00000000000a"}';

-- Route buckets.
select ok(public.rate_limit_hit('agent-turn', 120, 3600), 'Assistant turns have a route bucket');
select ok(public.rate_limit_hit('agent-continue', 300, 3600) and public.rate_limit_hit('agent-session', 60, 3600)
  and public.rate_limit_hit('captures', 60, 3600) and public.rate_limit_hit('cmo-runs', 60, 3600)
  and public.rate_limit_hit('onboarding', 20, 3600), 'continues, sessions, captures, runs and onboarding too');
select throws_ok($$ select public.rate_limit_hit('agent-turn', 9999, 3600) $$, '22023', 'Invalid rate limit.', 'only the allowlisted limit');

-- The chat's reads.
select is(public.cmo_read_limit('chat_social'), 120, 'chat social reads: 120 an hour');
select is(public.cmo_read_limit('chat_site'), 30, 'chat website reads: 30 an hour');
select ok(public.cmo_read_hit('chat_social'), 'a chat read is counted');
select ok(public.cmo_read_hit('mcp_social'), 'an MCP read is counted');
reset role;
select is((select count from public.rate_limits where user_id = 'e2390000-0000-4000-8000-00000000000a' and bucket = 'social_day'), 2,
  'chat and MCP share one daily count');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2390000-0000-4000-8000-00000000000a"}';
select throws_ok($$ select public.cmo_read_hit('social_day') $$, '22023', 'Invalid rate limit.', 'the daily bucket is not called directly');

-- Two briefs are two runs; the same request twice is one.
create temp table a1 as select * from public.enqueue_cmo_run('post_draft', '{"idea":"Pricing","brief":"Pricing"}');
select isnt((public.enqueue_cmo_run('post_draft', '{"idea":"Launch","brief":"Launch"}')).id, (select id from a1), 'another brief, another run');
select is((public.enqueue_cmo_run('post_draft', '{"idea":"Pricing","brief":"Pricing"}')).id, (select id from a1), 'the same request is the same run');

select * from finish();
rollback;
