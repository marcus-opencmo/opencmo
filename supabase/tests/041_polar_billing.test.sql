-- Giao dịch thật: replay, lifecycle đảo thứ tự, liên kết ổn định và rollback.
--
-- Số dư kỳ vọng KHÔNG còn cộng quà đăng ký: 20260921150000 bỏ hẳn nó, nên một
-- tài khoản mới bắt đầu từ 0 và mọi con số dưới đây là tiền đã trả.
begin;
set search_path = public, extensions;
select no_plan();
select has_function('public', 'process_polar_event', array['text','text','timestamp with time zone','jsonb','text','integer','text']);

insert into auth.users(id,email) values
 ('d4210000-0000-4000-8000-000000000001','polar-one@test.local'),
 ('d4210000-0000-4000-8000-000000000002','polar-two@test.local'),
 ('d4210000-0000-4000-8000-000000000003','polar-fail@test.local');

create function pg_temp.event(e text, t text, d jsonb, at_time timestamptz default '2026-09-20 10:00Z', p text default 'starter', c int default 150, entitlement text default 'starter')
returns jsonb language sql as $$
 select public.process_polar_event(e,t,at_time,
   '{"id":"sql-order","customer_id":"sql-customer","customer":{"id":"sql-customer","email":"polar-one@test.local"},"product_id":"sql-product","total_amount":1500,"currency":"usd"}'::jsonb || d,p,c,case when t like 'subscription.%' then p else entitlement end)
$$;

select lives_ok($$select pg_temp.event('paid-1','order.paid','{}')$$,'thanh toán thành công');
select lives_ok($$select pg_temp.event('paid-1','order.paid','{}')$$,'receipt replay thành công');
select lives_ok($$select pg_temp.event('paid-2','order.paid','{}')$$,'order replay với event ID mới');
select is((select credit_balance from profiles where email='polar-one@test.local'),150,'một purchase chỉ cộng một lần');
select is((select count(*) from credit_ledger where external_id='polar:sql-order'),1::bigint,'một ledger entry theo order');
select is((select count(*) from polar_webhook_receipts where event_id in ('paid-1','paid-2')),2::bigint,'receipt riêng mỗi event');

select lives_ok($$select pg_temp.event('active-1','subscription.active','{"id":"sql-sub","current_period_end":"2026-10-20T10:00:00Z"}')$$,'active chỉ đổi entitlement');
select is((select credit_balance from profiles where email='polar-one@test.local'),150,'active không cộng credit');
select is((select plan from profiles where email='polar-one@test.local'),'starter','active bật entitlement');
select lives_ok($$select pg_temp.event('cancel-1','subscription.canceled','{"id":"sql-sub","current_period_end":"2026-10-20T10:00:00Z"}','2026-09-20 11:00Z')$$,'cancel có paid-through');
select is((select plan from profiles where email='polar-one@test.local'),'starter','cancel giữ entitlement');
select is((select status from polar_subscriptions where subscription_id='sql-sub'),'canceled','lưu trạng thái cancel');
select is((select current_period_end from polar_subscriptions where subscription_id='sql-sub'),'2026-10-20 10:00Z'::timestamptz,'lưu paid-through');
select lives_ok($$select pg_temp.event('revoke-1','subscription.revoked','{"id":"sql-sub"}','2026-09-20 12:00Z')$$,'revoked tắt quyền ngay');
select lives_ok($$select pg_temp.event('old-active','subscription.active','{"id":"sql-sub"}','2026-09-20 10:30Z')$$,'active cũ bị bỏ qua');
select lives_ok($$select pg_temp.event('old-cancel','subscription.canceled','{"id":"sql-sub"}','2026-09-20 11:30Z')$$,'cancel cũ bị bỏ qua');
select is((select plan from profiles where email='polar-one@test.local'),'free','event cũ không khôi phục quyền');
select lives_ok($$select pg_temp.event('tied-active','subscription.active','{"id":"sql-sub"}','2026-09-20 12:00Z')$$,'cùng timestamp ưu tiên revoked');
select is((select status from polar_subscriptions where subscription_id='sql-sub'),'revoked','tie không phục hồi active');
select lives_ok($$select pg_temp.event('late-order-snapshot','order.paid','{"subscription":{"id":"sql-sub","status":"active","modified_at":"2026-09-20T09:00:00Z"}}','2026-09-20 13:00Z')$$,'order mới mang snapshot subscription cũ');
select is((select plan from profiles where email='polar-one@test.local'),'free','timestamp order không khôi phục snapshot đã revoked');

select lives_ok($$select pg_temp.event('partial','order.refunded','{"refunded_amount":500,"refunded_tax_amount":50}')$$,'partial refund');
select lives_ok($$select pg_temp.event('full','order.refunded','{"refunded_amount":1500,"refunded_tax_amount":150}')$$,'full refund');
select lives_ok($$select pg_temp.event('partial-late','order.refunded','{"refunded_amount":500,"refunded_tax_amount":50}')$$,'partial cũ không giảm refund');
select is((select refunded_amount from polar_purchases where order_id='sql-order'),1500::bigint,'refund tổng không cộng lặp');
select is((select refunded_tax_amount from polar_purchases where order_id='sql-order'),150::bigint,'refund thuế không cộng lặp');
select is((select credit_balance from profiles where email='polar-one@test.local'),150,'refund không trừ credit fungible');
select lives_ok($$select pg_temp.event('refund-before-paid','order.refunded','{"id":"sql-late-order","refunded_amount":1500}')$$,'refund đến trước paid');
select lives_ok($$select pg_temp.event('paid-after-refund','order.paid','{"id":"sql-late-order"}')$$,'paid đến sau refund vẫn xử lý một lần');
select is((select refunded_amount from polar_purchases where order_id='sql-late-order'),1500::bigint,'paid giữ dấu vết refund');

select lives_ok($$select pg_temp.event('no-email','order.paid','{"id":"sql-no-email","customer":null}')$$,'customer mapping đủ khi không email');
select lives_ok($$select pg_temp.event('wrong-email','order.paid','{"id":"sql-wrong-email","customer":{"id":"sql-customer","email":"polar-two@test.local"}}')$$,'email mới không rebind customer');
select is((select polar_customer_id from profiles where email='polar-two@test.local'),null::text,'không chiếm tài khoản khác');
select is((select credit_balance from profiles where email='polar-two@test.local'),0,'email khác không nhận credit');
select is((select credit_balance from profiles where email='polar-one@test.local'),600,'mapped customer vẫn nhận purchase');
select ok((pg_temp.event('unknown','order.paid','{"customer_id":"unknown","customer":null}')->>'skipped') is not null,'không email/mapping thì skip');

-- Hai subscription độc lập: revoke một gói không tắt subscription còn active.
select lives_ok($$select pg_temp.event('other-active','subscription.active','{"id":"sql-other-sub"}')$$,'subscription thứ hai');
select lives_ok($$select pg_temp.event('old-sub-revoke','subscription.revoked','{"id":"sql-sub"}','2026-09-20 13:00Z')$$,'revoke cũ không tắt gói khác');
select is((select plan from profiles where email='polar-one@test.local'),'starter','gói khác vẫn hiệu lực');
select lives_ok($$select pg_temp.event('past-due','subscription.past_due','{"id":"sql-other-sub"}','2026-09-20 14:00Z')$$,'past_due lưu riêng');
select is((select status from polar_subscriptions where subscription_id='sql-other-sub'),'past_due','không coi past_due là revoked');
select lives_ok($$select pg_temp.event('recovered','subscription.active','{"id":"sql-other-sub"}','2026-09-20 15:00Z')$$,'active khôi phục past_due');
select is((select credit_balance from profiles where email='polar-one@test.local'),600,'recovery không cấp credit');
-- Ledger trước migration dùng cùng business key, không grant lại khi lần đầu có receipt.
insert into credit_ledger(user_id,delta,reason,external_id) values('d4210000-0000-4000-8000-000000000001',150,'Legacy purchase','polar:sql-legacy');
select lives_ok($$select pg_temp.event('legacy-replay','order.paid','{"id":"sql-legacy"}')$$,'purchase trước migration replay');
select is((select credit_balance from profiles where email='polar-one@test.local'),750,'không cấp lại credit lịch sử');
select is((select count(*) from credit_ledger where external_id='polar:sql-legacy'),1::bigint,'giữ business key lịch sử');

-- Lỗi ở bước cuối: ledger, purchase, customer và receipt đều rollback.
create function pg_temp.fail_entitlement() returns trigger language plpgsql as $$
begin
 if new.email='polar-fail@test.local' and new.plan='creator' then raise exception 'Injected entitlement failure'; end if;
 return new;
end $$;
create trigger polar_test_failure before update on profiles for each row execute function pg_temp.fail_entitlement();
select throws_ok($$select pg_temp.event('fail-event','order.paid','{"id":"sql-fail-order","customer_id":"sql-fail-customer","customer":{"id":"sql-fail-customer","email":"polar-fail@test.local"},"subscription":{"id":"sql-fail-sub","status":"active"}}','2026-09-20 10:00Z','creator',400,'creator')$$,
 'P0001','Injected entitlement failure','lỗi cuối giao dịch được truyền ra');
select is((select count(*) from polar_webhook_receipts where event_id='fail-event'),0::bigint,'rollback receipt');
select is((select count(*) from polar_purchases where order_id='sql-fail-order'),0::bigint,'rollback purchase');
select is((select count(*) from credit_ledger where external_id='polar:sql-fail-order'),0::bigint,'rollback ledger');
select is((select count(*) from polar_subscriptions where subscription_id='sql-fail-sub'),0::bigint,'rollback entitlement');
select is((select polar_customer_id from profiles where email='polar-fail@test.local'),null::text,'rollback mapping');
select is((select credit_balance from profiles where email='polar-fail@test.local'),0,'rollback materialized balance');
drop trigger polar_test_failure on profiles;
select lives_ok($$select pg_temp.event('fail-event','order.paid','{"id":"sql-fail-order","customer_id":"sql-fail-customer","customer":{"id":"sql-fail-customer","email":"polar-fail@test.local"},"subscription":{"id":"sql-fail-sub","status":"active"}}','2026-09-20 10:00Z','creator',400,'creator')$$,'retry sau rollback thành công');
select is((select credit_balance from profiles where email='polar-fail@test.local'),400,'retry cộng đúng một lần');
select ok(not has_function_privilege('anon','public.process_polar_event(text,text,timestamptz,jsonb,text,integer,text)','execute'),'anon không gọi billing');
select ok(not has_function_privilege('authenticated','public.process_polar_event(text,text,timestamptz,jsonb,text,integer,text)','execute'),'authenticated không gọi billing');
select ok(has_function_privilege('service_role','public.process_polar_event(text,text,timestamptz,jsonb,text,integer,text)','execute'),'service_role được gọi billing');
-- Customer đã xoá không được chiếm lại qua email của tài khoản mới.
delete from auth.users where id='d4210000-0000-4000-8000-000000000003';
select ok((pg_temp.event('deleted-customer','order.paid','{"id":"sql-deleted-order","customer_id":"sql-fail-customer","customer":{"id":"sql-fail-customer","email":"polar-two@test.local"}}')->>'skipped') is not null,'customer tombstone không rebind sau xoá tài khoản');
select is((select credit_balance from profiles where email='polar-two@test.local'),0,'tài khoản mới không nhận tiền customer đã xoá');
-- Order có product cũ nhưng snapshot subscription là gói mới, cùng provider version.
select lives_ok($$select pg_temp.event('upgrade-paid-first','order.paid','{"id":"upgrade-order-1","subscription":{"id":"upgrade-sub-1","product_id":"creator-product","status":"active","modified_at":"2026-09-21T10:00:00Z"}}','2026-09-22 10:00Z','starter',150,'creator')$$,'paid trước active gói khác');
select is((select plan from polar_subscriptions where subscription_id='upgrade-sub-1'),'creator','snapshot dùng gói subscription, không dùng gói order');
select lives_ok($$select pg_temp.event('upgrade-active-second','subscription.active','{"id":"upgrade-sub-1","product_id":"creator-product"}','2026-09-21 10:00Z','creator',400)$$,'active cùng version sau paid');
select is((select plan from polar_subscriptions where subscription_id='upgrade-sub-1'),'creator','equal version vẫn creator');
select is((select plan from polar_purchases where order_id='upgrade-order-1'),'starter','purchase giữ plan starter');
select is((select delta from credit_ledger where external_id='polar:upgrade-order-1'),150,'purchase chỉ cấp credit starter');
select lives_ok($$select pg_temp.event('upgrade-active-first','subscription.active','{"id":"upgrade-sub-2","product_id":"creator-product"}','2026-09-21 10:00Z','creator',400)$$,'active trước paid');
select lives_ok($$select pg_temp.event('upgrade-paid-second','order.paid','{"id":"upgrade-order-2","subscription":{"id":"upgrade-sub-2","product_id":"creator-product","status":"active","modified_at":"2026-09-21T10:00:00Z"}}','2026-09-22 10:00Z','starter',150,'creator')$$,'late starter paid cùng creator version');
select is((select plan from polar_subscriptions where subscription_id='upgrade-sub-2'),'creator','late order không hạ subscription');
select is((select plan from profiles where email='polar-one@test.local'),'creator','profile nhận entitlement creator');
select is((select delta from credit_ledger where external_id='polar:upgrade-order-2'),150,'late order vẫn cấp đúng starter');
select lives_ok($$select pg_temp.event('unknown-snapshot','order.paid','{"id":"unknown-snapshot-order","subscription":{"id":"upgrade-sub-2","product_id":"unknown","status":"active","modified_at":"2026-09-23T10:00:00Z"}}','2026-09-23 11:00Z','starter',150,null)$$,'snapshot product chưa map vẫn nhận payment');
select is((select plan from polar_subscriptions where subscription_id='upgrade-sub-2'),'creator','product chưa biết không lấy plan order');
select is((select provider_updated_at from polar_subscriptions where subscription_id='upgrade-sub-2'),'2026-09-21 10:00Z'::timestamptz,'không chiếm provider version bằng plan chưa biết');
select is((select delta from credit_ledger where external_id='polar:unknown-snapshot-order'),150,'unknown snapshot không làm mất purchase grant');
-- Lifecycle của product chưa map và chưa có bản ghi: skip, không raise. Raise ở
-- đây là 500 với Polar, tức retry vĩnh viễn một event không thể xử lý.
select ok((pg_temp.event('unmapped-revoke','subscription.revoked','{"id":"sql-unmapped-sub"}','2026-09-24 10:00Z',null,null,null)->>'skipped') is not null,'revoke product chưa map thì skip');
select is((select count(*) from polar_subscriptions where subscription_id='sql-unmapped-sub'),0::bigint,'không tạo entitlement cho product chưa map');
select is((select plan from profiles where email='polar-one@test.local'),'creator','skip không đụng entitlement đang có');
select is((select count(*) from polar_webhook_receipts where event_id='unmapped-revoke'),0::bigint,'skip không ghi receipt, event sau vẫn xử lý được');
select * from finish();
rollback;
