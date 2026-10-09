create extension if not exists pgtap with schema extensions;
begin;
set search_path to public, extensions;
select no_plan();

-- Hơn max_rows của PostgREST: tham chiếu cuối vẫn phải được giữ.
insert into auth.users (id, email) values
 ('e0000000-0000-4000-8000-000000000001', 'cleanup-bounds@test.local');
insert into public.jobs (user_id, source_url, status)
select 'e0000000-0000-4000-8000-000000000001',
 'storage://e0000000-0000-4000-8000-000000000001/live-' || n || '.mp4', 'queued'
from generate_series(1, 1100) n;
select is((select count(*) from public.orphan_keep_paths('sources') where path like 'e0000000-0000-4000-8000-000000000001/%'),
 1100::bigint, 'fixture có hơn 1000 tham chiếu');
select has_function('public', 'orphan_safe_paths', array['text', 'text[]'],
 'RPC đánh giá ứng viên có giới hạn ngay trong DB');
select results_eq(
 $$select path from public.orphan_safe_paths('sources', array['e0000000-0000-4000-8000-000000000001/live-1100.mp4', 'bounds/orphan.mp4'])$$,
 $$values ('bounds/orphan.mp4'::text)$$, 'chỉ trả orphan dù live set hơn 1000');
select throws_ok(
 $$select * from public.orphan_safe_paths('sources', array_fill('x'::text, array[101]))$$,
 '22023', 'Invalid orphan candidates.', 'từ chối batch quá lớn');
select ok(not has_function_privilege('anon', 'public.orphan_safe_paths(text,text[])', 'execute'), 'anon không được gọi');
select ok(not has_function_privilege('authenticated', 'public.orphan_safe_paths(text,text[])', 'execute'), 'user không được gọi');
select ok(has_function_privilege('service_role', 'public.orphan_safe_paths(text,text[])', 'execute'), 'service role được gọi');
update public.jobs set media_manifest = '{"sections":[{"bucket":"sources","object":"bounds/manifest.mp4"}]}'
where source_url = 'storage://e0000000-0000-4000-8000-000000000001/live-1.mp4';
select is((select count(*) from public.orphan_safe_paths('sources',array['bounds/manifest.mp4'])),
 0::bigint,'tham chiếu manifest cũng được giữ');
-- Không lọc sau LIMIT: một trang vừa defer không được che hàng attempts cao.
delete from public.storage_deletions;
insert into public.storage_deletions(bucket,path,attempts)
select 'sources', 'deferred/' || n, 0 from generate_series(1,200) n;
insert into public.storage_deletions(bucket,path,attempts) values ('sources','later/work',9);
create temp table invocation as select clock_timestamp() as started;
select public.defer_object_deletions(array(select id from public.storage_deletions where path like 'deferred/%'));
select results_eq(
 $$select path from public.expired_object_paths(200, (select started from invocation))$$,
 $$values ('later/work'::text)$$, 'trang deferred đầy vẫn tiến tới hàng attempts cao');
-- Cursor bền vững: một trang toàn file live không chặn file phía sau.
insert into storage.objects(bucket_id,name,created_at)
select 'sources','bounds-cursor/' || lpad(n::text,4,'0') || '.mp4', now() - interval '8 hours'
from generate_series(1,201) n;
select has_function('public','orphan_scan_page',array['text','integer'], 'có trang scan với cursor bền vững');
select is((select count(*) from public.orphan_scan_page('sources',100)),100::bigint,'trang đầu có giới hạn');
select is((select min(path) from public.orphan_scan_page('sources',100)),
 'bounds-cursor/0101.mp4','lượt sau tiếp tục sau prefix đã quét');

-- B-roll dùng đúng <uid>/<project>/<file>; artifact lồng sâu vẫn thuộc manifest.
insert into public.jobs(id,user_id,source_url,status) values (
 'e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
 'https://example.com/cleanup-media', 'queued');
insert into public.media_assets(user_id,job_id,storage_path,name,status) values (
 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
 'media/e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/live.mp4',
 'Live B-roll', 'ready');
insert into storage.objects(bucket_id,name,created_at) values
 ('media','e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/orphan.mp4',now()-interval '8 hours'),
 ('media','e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/live.mp4',now()-interval '8 hours'),
 ('media','e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/worker/artifact.mp4',now()-interval '8 hours'),
 ('media','e0000000-0000-4000-8000-000000000001/direct.mp4',now()-interval '8 hours'),
 ('sources','e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/artifact.mp4',now()-interval '8 hours');
insert into public.orphan_scan_cursors(bucket,after_path)
values ('media','e0000000-0000-4000-8000-000000000001/')
on conflict(bucket) do update set after_path = excluded.after_path;
create temp table media_candidates as select path from public.orphan_scan_page('media',100);
select ok(exists(select 1 from media_candidates where path =
 'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/orphan.mp4'),
 'scan tìm được B-roll upload bỏ dở ở ba thành phần');
select ok(exists(select 1 from media_candidates where path =
 'e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/live.mp4'),
 'B-roll live cũng được kiểm tham chiếu sau bước scan');
select results_eq(
 $$select path from public.orphan_safe_paths('media',array(select path from media_candidates))$$,
 $$values ('e0000000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/orphan.mp4'::text)$$,
 'chỉ B-roll không tham chiếu được xoá, B-roll live được giữ');
select ok(not exists(select 1 from media_candidates where path like '%/worker/%' or path like '%/direct.mp4'),
 'media không quét artifact lồng sâu hay đường dẫn sai dạng upload');
select ok(not exists(select 1 from public.orphan_scan_page('sources',100) where path like '%/artifact.mp4'),
 'sources không quét artifact bên trong project');
select * from finish();
rollback;
