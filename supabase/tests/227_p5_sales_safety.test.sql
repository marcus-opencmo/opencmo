-- P5 A1 (20261231150000): a thread keeps the rule its draft was written under and a skipped one has no draft; the
-- reply that counts is the one the founder posted, and naming the product is read from it, so a help-only draft the
-- founder edited to name the product counts as a mention.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(12);

insert into auth.users (id, email) values ('e2270000-0000-4000-8000-00000000000a', 'p5a1@test.local');
insert into public.marketing_documents (user_id, kind, version, body, created_by) values
  ('e2270000-0000-4000-8000-00000000000a', 'product', 1, '{"name":"Paylane"}', 'agent');

select ok(public.product_mentioned('e2270000-0000-4000-8000-00000000000a', 'I built PAYLANE for this.'), 'the name in any case counts');
select ok(not public.product_mentioned('e2270000-0000-4000-8000-00000000000a', 'Use paylanes of reminders.'), 'part of another word does not');
select ok(not has_function_privilege('authenticated', 'public.sales_mention_count_for(uuid)', 'execute'), 'only the scan reads another founder''s count');

-- The scan saves a help-only draft, a mention-allowed draft and a skipped thread.
select is(public.cmo_save_opportunities('e2270000-0000-4000-8000-00000000000a', null, jsonb_build_array(
  jsonb_build_object('url', 'https://www.reddit.com/r/freelance/comments/a1/', 'community', 'r/freelance', 'title', 'Late invoices', 'score', 80,
    'reply', 'Send the same reminder on day 3, 7 and 14.', 'rule', 'help_only', 'rule_why', 'r/freelance forbids self-promotion'),
  jsonb_build_object('url', 'https://www.reddit.com/r/SaaS/comments/a2/', 'community', 'r/SaaS', 'title', 'Tools?', 'score', 75,
    'reply', 'A due date on the invoice helps.', 'rule', 'mention_ok', 'rule_why', 'r/SaaS allows it'),
  jsonb_build_object('url', 'https://www.reddit.com/r/memes/comments/a3/', 'community', 'r/memes', 'title', 'Lol', 'score', 70,
    'reply', 'ignored', 'rule', 'skip', 'rule_why', 'r/memes allows no business talk'),
  jsonb_build_object('url', 'https://www.reddit.com/r/SaaS/comments/a4/', 'community', 'r/SaaS', 'title', 'No draft', 'score', 70, 'reply', ''))), 3,
  'drafted and skipped threads are saved; one without a draft and not skipped is not');
select is((select rule || ' ' || coalesce(reply, 'no draft') from public.opportunities where url like '%/a3/'), 'skip no draft', 'a skipped thread has no draft');
select is((select count(*)::int from public.approvals where ref_kind = 'opportunity' and status = 'waiting'), 2, 'and no card');
select is((select rule_why from public.opportunities where url like '%/a1/'), 'r/freelance forbids self-promotion', 'the rule says why');

-- The founder posts the help-only draft after editing it to name the product: it counts.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2270000-0000-4000-8000-00000000000a","role":"authenticated"}';
select lives_ok($$ select public.cmo_decide_opportunity((select id from public.opportunities where url like '%/a1/'), 'replied', null,
  'Send the same reminder on day 3, 7 and 14. I made Paylane for this.') $$, 'the founder marks it replied with what they posted');
select is(public.sales_mention_count(), 1, 'a help-only draft edited to name the product counts as a mention');
select is((select reply from public.opportunities where url like '%/a1/'), 'Send the same reminder on day 3, 7 and 14. I made Paylane for this.',
  'and the posted text is kept');
select lives_ok($$ select public.cmo_decide_opportunity((select id from public.opportunities where url like '%/a2/'), 'replied') $$,
  'posting the draft as it is');
select throws_ok($$ select public.cmo_decide_opportunity((select id from public.opportunities where url like '%/a3/'), 'dismissed', null, 'text') $$,
  '22023', null, 'a dismissed thread carries no posted text');
reset role;

select * from finish();
rollback;
