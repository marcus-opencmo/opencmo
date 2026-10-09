-- A4b: export trong trình duyệt đã gỡ phía server. Không còn RPC nào của nó,
-- cron dọn quota không còn gọi hàm đã mất, và bản xuất chỉ do worker ghi.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('request_client_export', 'complete_client_export', 'cancel_client_export',
                        'expire_abandoned_client_exports')
  ),
  'không còn RPC nào của export trình duyệt'
);
select ok(
  not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and policyname = 'ghi export browser vào thư mục của mình'),
  'trình duyệt không còn policy ghi bucket exports'
);
select ok(
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname = 'đọc export browser trong thư mục của mình'),
  'vẫn đọc được bản xuất trong thư mục của mình'
);
select lives_ok(
  $$ select public.purge_stale_rate_limits() $$,
  'cron dọn quota chạy được khi không còn hàm expire'
);
select ok(
  (select pg_get_functiondef('public.purge_stale_rate_limits()'::regprocedure) not like '%expire_abandoned%'),
  'purge_stale_rate_limits không nhắc tới hàm đã gỡ'
);

-- R1 gỡ hẳn kind của đường cũ khỏi check (sản phẩm chưa deploy, không có hàng lịch sử).
insert into auth.users (id, email) values ('fb000000-0000-4000-8000-00000000000a', 'a4b@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('fb100000-0000-4000-8000-00000000000a', 'fb000000-0000-4000-8000-00000000000a', 'https://a', 60, 'done');
select throws_ok(
  $$ insert into public.tasks(user_id, kind, job_id, status, request_id, payload)
     values ('fb000000-0000-4000-8000-00000000000a', 'client_export', 'fb100000-0000-4000-8000-00000000000a',
             'awaiting_upload', gen_random_uuid(), '{}') $$,
  '23514', null, 'task client_export không còn hợp lệ'
);

select * from finish();
rollback;
