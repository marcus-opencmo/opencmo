-- D4 billing: số dư O(1), ledger bất biến, quota theo gói và watermark worker.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(33);

-- =========================================================== schema + quota
select has_column('public', 'profiles', 'credit_balance', 'profiles có số dư materialized');
select col_type_is('public', 'profiles', 'credit_balance', 'integer', 'số dư dùng integer');
select col_not_null('public', 'profiles', 'credit_balance', 'số dư không được null');
select ok(
  to_regprocedure('public.plan_quota(text)') is not null,
  'plan_quota(text) có mặt'
);
select is(
  (select row(previews_per_day, exports_per_day)::text from public.plan_quota('free')),
  '(20,5)', 'quota free khớp bảng giá'
);
select is(
  (select row(previews_per_day, exports_per_day)::text from public.plan_quota('starter')),
  '(100,30)', 'quota starter khớp bảng giá'
);
select is(
  (select row(previews_per_day, exports_per_day)::text from public.plan_quota('creator')),
  '(300,100)', 'quota creator khớp bảng giá'
);
select ok(
  not has_function_privilege('anon', 'public.plan_quota(text)', 'execute'),
  'anon không đọc bảng quota nội bộ'
);
select ok(
  not has_function_privilege('authenticated', 'public.plan_quota(text)', 'execute'),
  'authenticated không gọi trực tiếp bảng quota nội bộ'
);
select ok(
  has_function_privilege('service_role', 'public.plan_quota(text)', 'execute'),
  'service role đọc được quota để đối chiếu pricing'
);
select ok(
  exists(
    select 1 from pg_trigger
    where tgrelid = 'public.credit_ledger'::regclass
      and tgname = 'apply_credit_ledger_insert'
      and not tgisinternal
      and (tgtype & 4) = 4
      and (tgtype & 2) = 0
  ),
  'trigger materialized balance là AFTER INSERT'
);

-- =============================================================== fixtures
insert into auth.users(id, email) values
  ('d4100000-0000-4000-8000-000000000001', 'billing-1@test.local'),
  ('d4100000-0000-4000-8000-000000000002', 'billing-2@test.local'),
  ('d4100000-0000-4000-8000-000000000003', 'billing-3@test.local'),
  ('d4200000-0000-4000-8000-000000000001', 'quota@test.local'),
  ('d4300000-0000-4000-8000-000000000001', 'empty@test.local'),
  ('d4800000-0000-4000-8000-000000000001', 'delete@test.local'),
  ('d4900000-0000-4000-8000-000000000001', 'rate-limit@test.local'),
  ('d4a00000-0000-4000-8000-000000000001', 'legacy-quota@test.local'),
  ('d4b00000-0000-4000-8000-000000000001', 'account-delete@test.local');

-- Ba user stress có đủ credit để chuỗi ngẫu nhiên kiểm mọi nhánh, không dừng
-- sớm vì thiếu tiền. Các dòng này cũng phải đi qua trigger materialized balance.
insert into public.credit_ledger(user_id, delta, reason) values
  ('d4100000-0000-4000-8000-000000000001', 2000, 'Stress-test top-up'),
  ('d4100000-0000-4000-8000-000000000002', 2000, 'Stress-test top-up'),
  ('d4100000-0000-4000-8000-000000000003', 2000, 'Stress-test top-up'),
  -- Hard paywall (20260921150000) bỏ quà đăng ký: user nào phải TẠO được job
  -- thì từ nay phải được nạp tay trong fixture.
  ('d4800000-0000-4000-8000-000000000001', 100, 'Delete-test top-up');

create temporary table billing_operation_jobs(
  user_id uuid not null,
  job_id uuid primary key
) on commit drop;

create temporary table billing_operations(
  seq int primary key,
  kind text not null
) on commit drop;

-- Chuỗi pseudo-random lặp lại được: mỗi thao tác chạy đúng RPC/ledger thật.
create or replace function pg_temp.run_credit_operations(p_count int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_users uuid[] := array[
    'd4100000-0000-4000-8000-000000000001'::uuid,
    'd4100000-0000-4000-8000-000000000002'::uuid,
    'd4100000-0000-4000-8000-000000000003'::uuid
  ];
  v_user uuid;
  v_job public.jobs;
  v_job_id uuid;
  v_pick int;
  v_kind text;
  i int;
begin
  for i in 1..p_count loop
    v_user := v_users[1 + (get_byte(decode(md5(i::text), 'hex'), 1) % 3)];
    v_pick := get_byte(decode(md5(i::text), 'hex'), 0) % 4;

    if v_pick = 0 then
      insert into public.credit_ledger(user_id, delta, reason)
      values(v_user, 1 + (i % 17), 'Random top-up');
      v_kind := 'top_up';
    elsif v_pick = 1 then
      -- `create_job` có hai trần riêng (20260921130000): 3 job mở cùng lúc và
      -- 10 lượt mỗi giờ. Chuỗi 200 thao tác này chạm cả hai. Rơi về top-up
      -- thay vì để chuỗi chết — thứ file này kiểm là SỐ HỌC CREDIT dưới thứ tự
      -- ngẫu nhiên; hai cái trần có test riêng ở 085. Cùng kiểu fallback mà hai
      -- nhánh dưới đã dùng khi không tìm được job.
      --
      -- Bắt exception chứ không kiểm trước: bắt thì đúng với MỌI trần, kể cả
      -- trần thêm vào sau này, và không phải chép lại con số ở hai nơi.
      perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
      begin
        v_job := public.create_clip_job('https://youtu.be/billing-' || i, 1, p_ownership_confirmed => true);
        insert into billing_operation_jobs values(v_user, v_job.id);
        v_kind := 'hold';
      exception when sqlstate 'P0001' then
        insert into public.credit_ledger(user_id, delta, reason)
        values(v_user, 5, 'Random top-up fallback');
        v_kind := 'top_up';
      end;
    elsif v_pick = 2 then
      select job_id into v_job_id from billing_operation_jobs
      where user_id = v_user order by md5(job_id::text || i::text) limit 1;
      if v_job_id is null then
        insert into public.credit_ledger(user_id, delta, reason)
        values(v_user, 3, 'Random top-up fallback');
        v_kind := 'top_up';
      else
        update public.jobs set status = 'running' where id = v_job_id;
        perform public.settle_job_credits(
          v_job_id, 60 * (1 + (i % 15)), 'stress-settle-' || i, null
        );
        -- Đóng job lại sau khi đối soát, đúng như production: `complete_job()`
        -- đặt trạng thái cuối cùng trong CÙNG giao dịch với settle. Không đóng
        -- thì job nằm mãi ở `running` và đụng trần 3 job của `create_job`
        -- (20260921130000) — một chi tiết của fixture, không phải của billing.
        update public.jobs set status = 'done' where id = v_job_id;
        v_kind := 'settle';
      end if;
    else
      select job_id into v_job_id from billing_operation_jobs
      where user_id = v_user order by md5(i::text || job_id::text) limit 1;
      if v_job_id is null then
        insert into public.credit_ledger(user_id, delta, reason)
        values(v_user, 2, 'Random top-up fallback');
        v_kind := 'top_up';
      else
        perform public.refund_job(v_job_id, 'Random refund');
        -- Cùng lý do: `finalize_job_failure()` hoàn tiền VÀ chốt trạng thái.
        update public.jobs set status = 'failed' where id = v_job_id;
        v_kind := 'refund';
      end if;
    end if;

    insert into billing_operations values(i, v_kind);
  end loop;
end;
$$;

select lives_ok(
  $$ select pg_temp.run_credit_operations(200) $$,
  '200 thao tác credit ngẫu nhiên chạy qua ba user'
);
select is((select count(*)::int from billing_operations), 200, 'đã chạy đúng 200 thao tác');
select is((select count(distinct kind)::int from billing_operations), 4, 'chuỗi phủ nạp, giữ, đối soát và hoàn');
select is(
  (select count(*)::int
   from public.profiles p
   where p.id::text like 'd4100000-%'
     and p.credit_balance is distinct from (
       select coalesce(sum(l.delta), 0)::int from public.credit_ledger l where l.user_id = p.id
     )),
  0, 'materialized balance bằng tổng ledger cho mọi user'
);

-- Hàm phải đọc cột O(1), không âm thầm quay lại SUM(ledger).
update public.profiles set credit_balance = 12345
where id = 'd4100000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4100000-0000-4000-8000-000000000001"}';
select is(
  public.credit_balance('d4100000-0000-4000-8000-000000000001'),
  12345, 'credit_balance đọc materialized balance'
);
reset role;

select throws_ok(
  $$ update public.credit_ledger set reason = 'Changed' where user_id = 'd4100000-0000-4000-8000-000000000002' $$,
  '55000', 'Credit ledger entries cannot be changed or deleted.',
  'ledger chặn update'
);
select throws_ok(
  $$ delete from public.credit_ledger where user_id = 'd4100000-0000-4000-8000-000000000002' $$,
  '55000', 'Credit ledger entries cannot be changed or deleted.',
  'ledger chặn delete'
);
select throws_ok(
  $$ update public.credit_ledger set user_id = null where user_id = 'd4100000-0000-4000-8000-000000000002' $$,
  '55000', 'Credit ledger entries cannot be changed or deleted.',
  'không thể gọi trực tiếp đường anonymize của FK'
);

create temporary table account_delete_signup_ledger(
  id uuid primary key
) on commit drop;
-- Dòng ledger seed do chính test tạo. Trước 20260921150000 nó tới từ quà đăng
-- ký của `handle_new_user()`; hard paywall bỏ quà đó, nhưng thứ ca này kiểm là
-- "ledger tài chính sống sót qua lệnh xoá tài khoản và được anonymize" — nó cần
-- MỘT dòng ledger, không cần dòng đó tới từ đâu.
insert into public.credit_ledger (user_id, delta, reason)
values ('d4b00000-0000-4000-8000-000000000001', 30, 'Seed for delete test');

insert into account_delete_signup_ledger(id)
select id
from public.credit_ledger
where user_id = 'd4b00000-0000-4000-8000-000000000001'
  and reason = 'Seed for delete test';

select lives_ok(
  $$ delete from auth.users where id = 'd4b00000-0000-4000-8000-000000000001' $$,
  'xoá tài khoản không bị ledger append-only chặn'
);
select is(
  (select count(*)::int
   from public.credit_ledger l
   join account_delete_signup_ledger f on f.id = l.id
   where l.user_id is null),
  1, 'ledger tài chính còn lại sau khi xoá tài khoản'
);
select is(
  (select l.user_id
   from public.credit_ledger l
   join account_delete_signup_ledger f on f.id = l.id
   limit 1),
  null::uuid, 'ledger của tài khoản đã xoá được anonymize'
);

-- Xoá project là contract cũ. Ledger phải giữ nguyên job_id để vừa append-only
-- vừa không biến một thao tác hợp lệ thành lỗi do ON DELETE SET NULL.
create temporary table deleted_job_result(job_id uuid primary key) on commit drop;
grant select, insert on deleted_job_result to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4800000-0000-4000-8000-000000000001"}';
insert into deleted_job_result
select (public.create_clip_job('https://youtu.be/billing-delete', 1, p_ownership_confirmed => true)).id;
reset role;
update public.jobs set status = 'failed'
where id = (select job_id from deleted_job_result);
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4800000-0000-4000-8000-000000000001"}';
select lives_ok(
  $$ select public.delete_job((select job_id from deleted_job_result)) $$,
  'delete_job vẫn xoá được project đã chốt'
);
reset role;
select is(
  (select job_id from public.credit_ledger
   where user_id = 'd4800000-0000-4000-8000-000000000001' and reason = 'Hold for new job'),
  (select job_id from deleted_job_result),
  'xóa project không sửa khoá đối soát trong ledger'
);

-- User này chưa bao giờ được nạp, nên số dư đã là 0. Trước 20260921150000 phải
-- trừ tay 30 credit quà đăng ký về 0; hard paywall bỏ quà đó nên dòng trừ ấy
-- biến thành số âm.
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4300000-0000-4000-8000-000000000001"}';
select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/billing-not-enough', 1, p_ownership_confirmed => true) $$,
  'P0001', 'Not enough credits: 10 needed, 0 left. Top up on the Credits page.',
  'create_job giữ nguyên lỗi thiếu credit'
);
reset role;

-- rate_limit_hit vẫn phục vụ các route chống spam, nhưng caller không được tự
-- đặt bucket/limit/window để nới quota.
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4900000-0000-4000-8000-000000000001"}';
select lives_ok(
  $$ select public.rate_limit_hit(bucket, max_hits, window_seconds)
     from (values
       ('presets', 60, 3600), ('uploads', 30, 3600), ('jobs', 10, 3600),
       ('retry', 20, 3600), ('draft', 120, 60), ('project-write', 60, 3600),
       ('zip', 20, 3600), ('media', 60, 3600)
     ) as expected(bucket, max_hits, window_seconds) $$,
  'mọi bộ ba chống spam hiện hữu vẫn chạy'
);
select throws_ok(
  $$ select public.rate_limit_hit('jobs', 1000000, 1) $$,
  '22023', 'Invalid rate limit.', 'caller không tăng limit/window của bucket hợp lệ'
);
select throws_ok(
  $$ select public.rate_limit_hit('preview', 300, 86400) $$,
  '22023', 'Invalid rate limit.', 'free user không mượn quota creator'
);
reset role;

-- ========================================================= quota + dedupe
insert into public.jobs(id, user_id, source_url, status, watermark) values
  ('d4400000-0000-4000-8000-000000000001', 'd4200000-0000-4000-8000-000000000001',
   'https://youtu.be/billing-quota', 'done', true),
  ('d4a10000-0000-4000-8000-000000000001', 'd4a00000-0000-4000-8000-000000000001',
   'https://youtu.be/billing-legacy-quota', 'done', true);
insert into public.clips(id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('d4500000-0000-4000-8000-000000000001', 'd4400000-0000-4000-8000-000000000001',
   0, 0, 10, 0, 10),
  ('d4a20000-0000-4000-8000-000000000001', 'd4a10000-0000-4000-8000-000000000001',
   0, 0, 10, 0, 10);
update public.clips set settings = '{}', settings_hash = repeat('e', 64)
where id in ('d4500000-0000-4000-8000-000000000001', 'd4a20000-0000-4000-8000-000000000001');

-- Giả lập counter đã có trước D4. Cả enforcement lẫn account summary phải nhìn
-- thấy nó, không cấp thêm quota chỉ vì bucket đổi tên.
insert into public.rate_limits(user_id, bucket, window_start, count) values
  ('d4a00000-0000-4000-8000-000000000001', 'daily_preview',
   to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 20),
  ('d4a00000-0000-4000-8000-000000000001', 'daily_export',
   to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 5);

set local role authenticated;
set local request.jwt.claims = '{"sub":"d4a00000-0000-4000-8000-000000000001"}';
select is(
  row(
    public.account_summary() #>> '{quota,previews,used}',
    public.account_summary() #>> '{quota,exports,used}'
  )::text,
  '(20,5)', 'account_summary giữ usage của bucket D3 trong ngày deploy'
);
-- Sau khi migration đã copy daily_export -> export, request hiện hành và RPC
-- cũ vẫn có thể chạy xen kẽ. Cả hai phải cùng tăng một counter canonical:
-- lượt thứ 5 được nhận, lượt thứ 6 bị chặn thay vì mỗi alias thấy 5/5.
reset role;
set local role service_role;
update public.rate_limits
set count = 4
where user_id = 'd4a00000-0000-4000-8000-000000000001'
  and bucket = 'daily_export';
insert into public.rate_limits(user_id, bucket, window_start, count)
values(
  'd4a00000-0000-4000-8000-000000000001', 'export',
  to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 4
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d4a00000-0000-4000-8000-000000000001"}';
select is(
  public.rate_limit_hit('export', 5, 86400), true,
  'current export alias nhận lượt thứ 5 sau migrated usage'
);
select is(
  public.rate_limit_hit('daily_export', 5, 86400), false,
  'legacy export alias bị chặn ở lượt thứ 6'
);
reset role;
select is(
  (select count from public.rate_limits
   where user_id = 'd4a00000-0000-4000-8000-000000000001' and bucket = 'export'),
  6, 'legacy/current export calls cùng tăng counter canonical'
);
select is(
  (select count from public.rate_limits
   where user_id = 'd4a00000-0000-4000-8000-000000000001' and bucket = 'daily_export'),
  4, 'legacy export alias không tạo counter tách riêng'
);

select * from finish();
rollback;
