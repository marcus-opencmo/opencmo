-- 20261101090000 (R6): module credit — mọi dòng mới mang ref, hoàn theo tổng của việc,
-- và `cancel_job` không còn hoàn hai lần tiền generation/phụ đề cùng project.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(24);

insert into auth.users (id, email) values ('e1300000-0000-4000-8000-00000000000a', 'r6-a@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1301000-0000-4000-8000-00000000000a', 'e1300000-0000-4000-8000-00000000000a', 'storage://e1300000-0000-4000-8000-00000000000a/talk.mp4', 600, 'running');
insert into public.clips (id, job_id, idx, hook, start_seconds, end_seconds, source_start, source_end) values
  ('e1302000-0000-4000-8000-00000000000a', 'e1301000-0000-4000-8000-00000000000a', 0, 'Hook', 0, 30, 0, 30);
insert into public.media_assets (id, user_id, job_id, storage_path, name, duration, status) values
  ('e1303000-0000-4000-8000-00000000000a', 'e1300000-0000-4000-8000-00000000000a', 'e1301000-0000-4000-8000-00000000000a', 'media/a/broll.mp4', 'broll.mp4', 150, 'ready');
insert into public.credit_ledger (user_id, delta, reason) values ('e1300000-0000-4000-8000-00000000000a', 30, 'test grant');

-- ---------------------------------------------------------------- quyền + luật một cửa
select ok(not has_function_privilege('authenticated', 'public.credit_hold(uuid,text,uuid,integer,text,uuid)', 'execute'),
  'người dùng không tự giữ tiền được');
select ok(not has_function_privilege('authenticated', 'public.credit_refund(uuid,text,uuid,text,uuid)', 'execute'),
  'người dùng không tự hoàn tiền được');
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ilike '%insert into public.credit_ledger%'),
  array['credit_hold', 'credit_settle', 'process_polar_event'],
  'chỉ module credit (và nạp tiền Polar) ghi vào sổ cái'
);
select throws_ok(
  $$ insert into public.credit_ledger (user_id, delta, reason, ref_kind) values ('e1300000-0000-4000-8000-00000000000a', 1, 'x', 'job') $$,
  '23514', null, 'ref_kind không có ref_id bị chặn'
);

-- ---------------------------------------------------------------- hold / settle / refund
-- Job clip đang chạy: giữ 10 như `create_job`.
select is(public.credit_hold('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301000-0000-4000-8000-00000000000a', 10, 'Hold for new job', 'e1301000-0000-4000-8000-00000000000a'),
  10, 'giữ 10');
select is(public.credit_held('job', 'e1301000-0000-4000-8000-00000000000a'), 10, 'đang giữ 10');
select is(public.credit_hold('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301000-0000-4000-8000-00000000000a', 0, 'noop'),
  0, 'giữ 0 không ghi dòng');
select throws_ok(
  $$ select public.credit_hold('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301000-0000-4000-8000-00000000000a', 1000, 'too much') $$,
  'P0001', 'Not enough credits: 1000 needed, 20 left. Top up on the Credits page.', 'thiếu tiền: lỗi tiếng Anh, không ghi gì'
);

-- ---------------------------------------------------------------- generation + phụ đề cùng project
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1300000-0000-4000-8000-00000000000a"}';
create temporary table g as
  select public.create_generation('e1301000-0000-4000-8000-00000000000a', 'e1302000-0000-4000-8000-00000000000a',
    'fake-video', '{"prompt":"a cat","aspectRatio":"9:16","duration":3}', repeat('6', 64),
    'e1304000-0000-4000-8000-000000000001') as r;
create temporary table cap as
  select public.request_media_captions('e1302000-0000-4000-8000-00000000000a', 'e1303000-0000-4000-8000-00000000000a') as v;
reset role;

select is(public.credit_held('generation', (select (r->'generation'->>'id')::uuid from g)), 3, 'generation giữ 3 dưới ref của nó');
select is(public.credit_held('captions', (select (v->>'task_id')::uuid from cap)), 3, 'phụ đề giữ 3 dưới ref của task');
select is(public.job_credits_spent('e1301000-0000-4000-8000-00000000000a'), 10,
  'tiền của job clip không còn lẫn generation/phụ đề cùng project');
select is(public.credit_balance('e1300000-0000-4000-8000-00000000000a'), 14, '30 − 10 − 3 − 3');

-- Huỷ khi đang chạy: hoàn job (10, giữ lại 1 như cũ), rồi trigger của task hoàn generation (3)
-- và phụ đề (3) — mỗi khoản đúng một lần. Trước R6: refund_job hoàn 16 rồi trigger hoàn thêm 6.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1300000-0000-4000-8000-00000000000a"}';
select is((public.cancel_job('e1301000-0000-4000-8000-00000000000a')).status::text, 'cancelled', 'huỷ project');
reset role;
select is(public.credit_balance('e1300000-0000-4000-8000-00000000000a'), 29, '30 − 1 (huỷ khi đang chạy): không hoàn hai lần');
select is(public.credit_held('generation', (select (r->'generation'->>'id')::uuid from g)), 0, 'generation hoàn đủ một lần');
select is(public.credit_held('captions', (select (v->>'task_id')::uuid from cap)), 0, 'phụ đề hoàn đủ một lần');
select is(public.credit_held('job', 'e1301000-0000-4000-8000-00000000000a'), 1, 'job giữ lại đúng 1 credit');
select is(public.credit_refund('e1300000-0000-4000-8000-00000000000a', 'generation', (select (r->'generation'->>'id')::uuid from g), 'again'),
  0, 'hoàn lần hai ghi 0');
select is(
  (select count(*)::int from public.credit_ledger
   where user_id = 'e1300000-0000-4000-8000-00000000000a' and reason <> 'test grant' and ref_kind is null),
  0, 'mọi dòng ghi mới đều mang ref'
);

-- ---------------------------------------------------------------- settle hai chiều
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1301100-0000-4000-8000-00000000000a', 'e1300000-0000-4000-8000-00000000000a', 'storage://e1300000-0000-4000-8000-00000000000a/b.mp4', 600, 'running');
select public.credit_hold('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301100-0000-4000-8000-00000000000a', 10, 'Hold for new job', 'e1301100-0000-4000-8000-00000000000a');
select is(public.credit_settle('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301100-0000-4000-8000-00000000000a', 4, 'Adjusted to real video length'),
  6, 'settle thấp hơn số giữ: hoàn phần thừa');
select is(public.credit_settle('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301100-0000-4000-8000-00000000000a', 7, 'Adjusted to real video length'),
  -3, 'settle cao hơn: thu thêm');
select throws_ok(
  $$ select public.credit_settle('e1300000-0000-4000-8000-00000000000a', 'job', 'e1301100-0000-4000-8000-00000000000a', 500, 'x') $$,
  'P0001', null, 'thu thêm quá số dư bị chặn'
);

-- ---------------------------------------------------------------- CMO: ref = run
create temporary table run as select public.cmo_enqueue('e1300000-0000-4000-8000-00000000000a', 'post_draft', '{}') as r;
select is(
  (select ref_kind || ':' || (ref_id = (select (r).id from run))::text from public.credit_ledger
   where user_id = 'e1300000-0000-4000-8000-00000000000a' and reason = 'CMO hold'),
  'cmo_run:true', 'giữ tiền CMO mang id của lượt'
);
select public.cmo_refund_run((select r from run));
select public.cmo_refund_run((select r from run));
select is(public.credit_held('cmo_run', (select (r).id from run)), 0, 'gọi hoàn CMO hai lần: chỉ hoàn một lần');

select * from finish();
rollback;
