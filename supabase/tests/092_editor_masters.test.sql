-- Master + transcript của editor mới trong hàng đợi xoá
-- (20260923131338_editor_masters).
--
-- Hai file mỗi clip, trong `renders`, chỉ được nhắc tới ở
-- `media_manifest.masters`. Không có gì khác trỏ vào chúng: `clips` không, `tasks`
-- không. Nhánh `union` ở đây là đường DUY NHẤT chúng được dọn, và nếu nó sai thì
-- lỗi im lặng — project biến mất khỏi giao diện, file vẫn nằm trong hoá đơn.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

delete from public.storage_deletions;

insert into auth.users (id, email) values
  ('ea000000-0000-4000-8000-00000000000a', 'masters-a@test.local');

insert into public.jobs (id, user_id, source_url, status, media_manifest) values
  ('ea100000-0000-4000-8000-00000000000a', 'ea000000-0000-4000-8000-00000000000a',
   'https://example.com/video', 'done',
   jsonb_build_object('masters', jsonb_build_object(
     'ea200000-0000-4000-8000-00000000000a', jsonb_build_object(
       'bucket', 'renders',
       'object', 'ea000000-0000-4000-8000-00000000000a/ea200000-0000-4000-8000-00000000000a/master/att.mp4',
       'transcript', 'ea000000-0000-4000-8000-00000000000a/ea200000-0000-4000-8000-00000000000a/master/att.transcript.json'),
     -- Clip thứ hai không có transcript: video không lời nói vẫn ra master.
     -- `transcript` null không được đẩy một hàng rỗng vào hàng đợi.
     'ea200000-0000-4000-8000-00000000000b', jsonb_build_object(
       'bucket', 'renders',
       'object', 'ea000000-0000-4000-8000-00000000000a/ea200000-0000-4000-8000-00000000000b/master/att.mp4',
       'transcript', null))));

select lives_ok(
  $$ select public.enqueue_job_objects('ea100000-0000-4000-8000-00000000000a') $$,
  'thu thập chạy được trên manifest có masters'
);

select is(
  (select count(*)::int from public.storage_deletions where bucket = 'renders'),
  3,
  'ba object: hai master và một transcript'
);

select ok(
  exists(select 1 from public.storage_deletions
          where bucket = 'renders'
            and path = 'ea000000-0000-4000-8000-00000000000a/ea200000-0000-4000-8000-00000000000a/master/att.mp4'),
  'master của clip đầu vào hàng đợi'
);

select ok(
  exists(select 1 from public.storage_deletions
          where bucket = 'renders'
            and path = 'ea000000-0000-4000-8000-00000000000a/ea200000-0000-4000-8000-00000000000a/master/att.transcript.json'),
  'transcript đi cùng master, không bị bỏ sót'
);

-- Manifest thiếu hẳn `masters` (mọi job trước hôm nay) phải chạy như cũ, không
-- ném lỗi: `jsonb_each` trên một giá trị không phải object là một exception,
-- và nó sẽ chặn cả hàng đợi chứ không chỉ một nhánh.
update public.jobs set media_manifest = jsonb_build_object('masters', 'khong-phai-object')
 where id = 'ea100000-0000-4000-8000-00000000000a';
delete from public.storage_deletions;

select lives_ok(
  $$ select public.enqueue_job_objects('ea100000-0000-4000-8000-00000000000a') $$,
  '`masters` sai kiểu không làm đổ cả lượt thu thập'
);

select is(
  (select count(*)::int from public.storage_deletions where bucket = 'renders'),
  0,
  'không có object nào được bịa ra từ manifest hỏng'
);

select * from finish();
rollback;
