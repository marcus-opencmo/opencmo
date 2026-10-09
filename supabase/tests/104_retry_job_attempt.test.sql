-- retry_job đặt lại attempt (20261005090000): job đã bị reclaim nhiều lần, sau
-- Retry phải được đủ số lần thử của một lượt chạy mới.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(3);

insert into auth.users (id, email) values
  ('e1040000-0000-4000-8000-00000000000a', 'retry-attempt@test.local');
insert into public.credit_ledger (user_id, delta, reason) values
  ('e1040000-0000-4000-8000-00000000000a', 100, 'Test top-up');
insert into public.jobs (id, user_id, source_url, duration_seconds, status, attempt, error) values
  ('e1041000-0000-4000-8000-00000000000a', 'e1040000-0000-4000-8000-00000000000a',
   'https://a', 600, 'failed', 3, 'Processing was interrupted too many times.');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1040000-0000-4000-8000-00000000000a"}';

select is(
  (public.retry_job('e1041000-0000-4000-8000-00000000000a')).attempt,
  0, 'Retry đặt attempt về 0'
);

reset role;
select is(
  (select status::text from public.jobs where id = 'e1041000-0000-4000-8000-00000000000a'),
  'queued', 'job về hàng đợi'
);

select ok(
  (select attempt_started_at > now() - interval '1 minute'
   from public.jobs where id = 'e1041000-0000-4000-8000-00000000000a'),
  'Retry đếm giờ lại từ lúc bấm, không từ lúc tạo job gốc (20261006090000)'
);

select * from finish();
rollback;
