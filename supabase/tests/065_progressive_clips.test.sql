-- Công bố dần, retry và ZIP clip gốc phải giữ ranh giới tenant.
create extension if not exists pgtap with schema extensions;
begin;
set search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values
 ('e0000000-0000-4000-8000-000000000001','progress@test.local'),
 ('e0000000-0000-4000-8000-000000000002','outsider@test.local');
-- Nạp tay: hard paywall (20260921150000) bỏ quà đăng ký, nên tài khoản mới có
-- 0 credit và `retry_job` phía dưới sẽ không giữ nổi phần tạm.
insert into public.credit_ledger(user_id,delta,reason) values
 ('e0000000-0000-4000-8000-000000000001',100,'Test top-up');
insert into public.jobs(id,user_id,source_url,status,attempt_id) values
 ('e1000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','https://youtu.be/first','running','e9000000-0000-4000-8000-000000000001'),
 ('e1000000-0000-4000-8000-000000000002','e0000000-0000-4000-8000-000000000002','https://youtu.be/second','running','e9000000-0000-4000-8000-000000000002');
create temp table fixture as select jsonb_build_object(
 'id','e2000000-0000-4000-8000-000000000001','idx',0,'hook','First','start_seconds',1,'end_seconds',20,'score',8,'reason','Good',
 'storage_path','e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/e9000000-0000-4000-8000-000000000001/00.mp4','preview_path',null) clip;
grant select on fixture to authenticated;
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000099',null),false,'stale attempt fenced before validation');
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip from fixture)),true,'first clip published with nullable preview');
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip from fixture)),true,'identical replay accepted');
select is((select count(*)::int from clips where job_id='e1000000-0000-4000-8000-000000000001'),1,'replay has one immutable clip');
select throws_ok($$select public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip||'{"hook":"changed"}'::jsonb from fixture))$$,'22023','This clip was already published with different content.','changed replay rejected');
select throws_ok($$select public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip||'{"id":"e2000000-0000-4000-8000-000000000099"}'::jsonb from fixture))$$,'22023','A different clip already exists at this position.','position collision rejected');
select throws_ok($$select public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip||'{"storage_path":"other/job/attempt/00.mp4"}'::jsonb from fixture))$$,'22023','Invalid clip storage path.','foreign storage path rejected');
set local role authenticated;
set local request.jwt.claim.sub='e0000000-0000-4000-8000-000000000002';
select ok(not has_function_privilege('authenticated','public.publish_job_clip(uuid,uuid,jsonb)','execute'),'authenticated cannot publish');
select is((select count(*)::int from clips where job_id='e1000000-0000-4000-8000-000000000001'),0,'nonowner cannot read progressive clips');
reset role;
select lives_ok($$select public.finalize_job_failure('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001','Failed later','progress-failure')$$,'later failure finalizes');
select is((select count(*)::int from clips where job_id='e1000000-0000-4000-8000-000000000001'),1,'failure retains ready clip');
set local request.jwt.claim.sub='e0000000-0000-4000-8000-000000000001';
select lives_ok($$select public.retry_job('e1000000-0000-4000-8000-000000000001')$$,'owner retries');
select is((select count(*)::int from clips where job_id='e1000000-0000-4000-8000-000000000001'),1,'retry retains clip');
update jobs set status='running',attempt_id='e9000000-0000-4000-8000-000000000003' where id='e1000000-0000-4000-8000-000000000001';
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000001',(select clip from fixture)),false,'old worker fenced after retry');
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000003',(select clip from fixture)),true,'new attempt can reuse old immutable clip');
select is(public.complete_job_publication('e1000000-0000-4000-8000-000000000001','e9000000-0000-4000-8000-000000000003','Title',30,(select jsonb_build_array(clip) from fixture),
 jsonb_build_array(jsonb_build_object('clip_id','e2000000-0000-4000-8000-000000000001','settings','{}'::jsonb,'settings_hash',repeat('a',64))),'{}'),true,'final publication attaches editor to earlier attempt clip');
select ok((select settings is not null from clips where id='e2000000-0000-4000-8000-000000000001'),'settings gốc ghi cho clip được giữ');
insert into clips(id,job_id,idx,start_seconds,end_seconds,storage_path) values
 ('e2000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',1,20,30,'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/a/01.mp4'),
 ('e2000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000002',0,1,20,'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000002/a/00.mp4');
set local role authenticated;
select is((public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000001')).payload,
 '{"clip_ids":["e2000000-0000-4000-8000-000000000001","e2000000-0000-4000-8000-000000000002"]}'::jsonb,'ZIP snapshots canonical sorted original ids');
select lives_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002']::uuid[],'e3000000-0000-4000-8000-000000000001')$$,'reordered same selection replays');
select is((select count(*)::int from tasks where request_id='e3000000-0000-4000-8000-000000000001'),1,'ZIP replay creates no duplicate');
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000001')$$,'22023','This request id was already used for something else.','changed selection cannot replay');
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003']::uuid[],'e3000000-0000-4000-8000-000000000002')$$,'P0002','One or more clips are not ready to download.','mixed tenant selection rejects entire ZIP');
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000002')$$,'22023','Choose each clip only once.','duplicate selection rejected');
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array_fill('e2000000-0000-4000-8000-000000000001'::uuid,array[11]),'e3000000-0000-4000-8000-000000000002')$$,'22023','Choose at most 10 clips.','ZIP limit is ten');
set local request.jwt.claim.sub='e0000000-0000-4000-8000-000000000002';
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000003')$$,'P0002','Project not found.','nonowner cannot ZIP project');
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000002',array['e2000000-0000-4000-8000-000000000003']::uuid[],'e3000000-0000-4000-8000-000000000001')$$,'22023','This request id was already used for something else.','request id cannot cross tenant');
reset role;
set local request.jwt.claim.sub='e0000000-0000-4000-8000-000000000001';
select is((select count from rate_limits where user_id='e0000000-0000-4000-8000-000000000001' and bucket='export'),1,'only new ZIP consumes canonical export quota');
update rate_limits set count=5 where user_id='e0000000-0000-4000-8000-000000000001' and bucket='export';
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000004')$$,'P0001','You have reached today''s limit for this plan.','ZIP respects daily export quota');
select lives_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002']::uuid[],'e3000000-0000-4000-8000-000000000001')$$,'replay works after daily quota exhausted');
insert into tasks(user_id,kind,job_id,payload,request_id) select 'e0000000-0000-4000-8000-000000000001','zip','e1000000-0000-4000-8000-000000000001','{}',gen_random_uuid() from generate_series(1,19);
select throws_ok($$select public.request_original_zip('e1000000-0000-4000-8000-000000000001',array['e2000000-0000-4000-8000-000000000001']::uuid[],'e3000000-0000-4000-8000-000000000004')$$,'P0001','You already have 20 downloads or renders in progress. Please wait for one to finish.','ZIP respects active task cap');
select ok(has_function_privilege('service_role','public.publish_job_clip(uuid,uuid,jsonb)','execute'),'worker role can publish');
set local request.jwt.claim.sub='e0000000-0000-4000-8000-000000000002';
select lives_ok($$select public.cancel_job('e1000000-0000-4000-8000-000000000002')$$,'owner cancels running project with ready clip');
select is((select count(*)::int from clips where job_id='e1000000-0000-4000-8000-000000000002'),1,'cancellation retains ready clip');
select is(public.publish_job_clip('e1000000-0000-4000-8000-000000000002','e9000000-0000-4000-8000-000000000002',null),false,'cancelled project fences publication');
select * from finish();
rollback;
