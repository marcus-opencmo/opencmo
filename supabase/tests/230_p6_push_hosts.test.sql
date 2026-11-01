-- P6 (20270101093000): a push endpoint is accepted only on a browser push service, so the sender never calls an
-- arbitrary host.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(8);

select ok(public.push_endpoint_allowed('https://fcm.googleapis.com/fcm/send/abc'), 'Chrome''s push service');
select ok(public.push_endpoint_allowed('https://updates.push.services.mozilla.com/wpush/v2/abc'), 'Firefox''s');
select ok(public.push_endpoint_allowed('https://web.push.apple.com/QGx'), 'Safari''s');
select ok(public.push_endpoint_allowed('https://wns2-par02p.notify.windows.com/w/?token=x'), 'Edge''s');
select ok(not public.push_endpoint_allowed('https://169.254.169.254/latest/meta-data'), 'no address');
select ok(not public.push_endpoint_allowed('https://fcm.googleapis.com.evil.example/x'), 'no look-alike host');
select ok(not public.push_endpoint_allowed('https://evil.example/fcm.googleapis.com/x'), 'the host is what counts');

insert into auth.users (id, email) values ('e2300000-0000-4000-8000-00000000000a', 'p6push@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2300000-0000-4000-8000-00000000000a","role":"authenticated"}';
select throws_ok($$ select public.push_subscribe('https://internal.example/hook', repeat('A', 87), repeat('b', 22), null) $$,
  '22023', 'This browser''s push service is not supported.', 'another host is refused');
reset role;

select * from finish();
rollback;
