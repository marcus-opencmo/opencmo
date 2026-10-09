-- Hợp đồng worker: fence attempt, replay bất biến và probe retry.
create extension if not exists pgtap with schema extensions;
begin;
set search_path to public, extensions;
select plan(24);
insert into auth.users(id,email) values('b0000000-0000-4000-8000-000000000001','worker-review@test.local');
insert into public.jobs(id,user_id,source_url,status,attempt_id)
values('b1000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','https://youtu.be/test','running','b9000000-0000-4000-8000-000000000001');
insert into public.clips(id,job_id,idx,start_seconds,end_seconds)
values('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',0,1,20);
create temp table fixture as select jsonb_build_array(jsonb_build_object(
  'clip_id','b2000000-0000-4000-8000-000000000001','settings',jsonb_build_object('source_start',1,'source_end',20),
  'settings_hash',repeat('a',64))) revisions;
select ok(to_regprocedure('public.put_artifact(uuid,text,jsonb)') is null, 'không còn overload artifact thiếu fence');
select ok(to_regprocedure('public.create_clip_drafts(uuid,jsonb)') is null, 'không còn overload draft thiếu fence');
select ok((public.put_artifact('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'transcript', '{"v":1}')).version = 1, 'artifact lần đầu');
select ok((public.put_artifact('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'transcript', '{"v":1}')).version = 1, 'artifact replay giữ version');
select throws_ok($q$select public.put_artifact('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001','transcript','{"v":2}')$q$, '22023', null, 'artifact replay khác dữ liệu bị chặn');
select throws_ok($q$select public.put_artifact('b1000000-0000-4000-8000-000000000001',null,'moments','{}')$q$, 'P0001', null, 'artifact null attempt bị chặn');
select throws_ok($q$select public.create_clip_drafts('b1000000-0000-4000-8000-000000000001',null,'[]')$q$, 'P0001', null, 'draft null attempt bị chặn');
select ok(public.create_clip_drafts('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', (select revisions from fixture)) = 1, 'draft khi running');
select ok(public.create_clip_drafts('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', (select revisions from fixture)) = 0, 'draft replay giữ revision');
select throws_ok($q$select public.create_clip_drafts('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001','[]')$q$, '22023', null, 'draft replay khác đầu vào bị chặn');
update public.jobs set status='done' where id='b1000000-0000-4000-8000-000000000001';
select ok(public.put_artifact('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'transcript', '{"v":1}') is not null, 'artifact replay sau complete_job');
select ok(public.create_clip_drafts('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', (select revisions from fixture)) = 0, 'draft replay sau complete_job');
update public.jobs set attempt_id='b9000000-0000-4000-8000-000000000002',status='running' where id='b1000000-0000-4000-8000-000000000001';
select throws_ok($q$select public.put_artifact('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'transcript', '{"v":1}')$q$, 'P0001', null, 'artifact attempt bị thay bị chặn');
select throws_ok($q$select public.create_clip_drafts('b1000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', (select revisions from fixture))$q$, 'P0001', null, 'draft attempt bị thay bị chặn');
select ok((public.put_artifact('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000002','transcript','{"v":2}')).version = 2, 'attempt mới tạo version kế tiếp');
update public.jobs set status='cancelled' where id='b1000000-0000-4000-8000-000000000001';
select throws_ok($q$select public.put_artifact('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000002','moments','{}')$q$, 'P0001', null, 'artifact job cancelled bị chặn');
select throws_ok($q$select public.create_clip_drafts('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000002','[]')$q$, 'P0001', null, 'draft job cancelled bị chặn');
update public.jobs set status='done' where id='b1000000-0000-4000-8000-000000000001';
select ok(public.create_clip_drafts('b1000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000002',(select revisions from fixture)) = 0, 'attempt hiện hành done khởi tạo và giữ draft cũ');
insert into public.media_assets(id,user_id,job_id,storage_path,name)
values('b5000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','media/b0000000-0000-4000-8000-000000000001/b1000000-0000-4000-8000-000000000001/test.mp4','test');
insert into public.tasks(user_id,kind,asset_id,request_id,status,attempt_id)
values('b0000000-0000-4000-8000-000000000001','probe_media','b5000000-0000-4000-8000-000000000001',gen_random_uuid(),'running','b9000000-0000-4000-8000-000000000001');
select ok(public.complete_media_probe('b5000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001',12,1920,1080,true), 'probe chốt lần đầu');
select ok(public.complete_media_probe('b5000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001',12,1920,1080,true), 'probe replay cùng kết quả thành công');
select ok(not public.complete_media_probe('b5000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000001',13,1920,1080,true), 'probe replay khác kết quả bị chặn');
select ok(not public.complete_media_probe('b5000000-0000-4000-8000-000000000001','b9000000-0000-4000-8000-000000000002',12,1920,1080,true), 'probe attempt lạ bị chặn');
set local role authenticated;
-- Kiểm quyền qua catalog, không gọi hàm thật: pgTAP trên Postgres 17 của
-- Supabase segfault backend khi bắt lỗi permission denied của HÀM
-- (GitHub Actions run 34956743124). Cùng cách đã dùng ở 020 và 027.
select is(has_function_privilege('authenticated', 'public.put_artifact(uuid, uuid, text, jsonb)', 'execute'), false, 'authenticated không ghi artifact');
select is(has_function_privilege('authenticated', 'public.create_clip_drafts(uuid, uuid, jsonb)', 'execute'), false, 'authenticated không tạo draft worker');
set local role postgres;
select * from finish();
rollback;
