-- 20261021090000: send_feedback — ghi qua RPC, kiểm đầu vào, clip người khác bị bỏ liên kết.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(7);

insert into auth.users (id, email) values
  ('e1190000-0000-4000-8000-00000000000a', 'fa@test.local'),
  ('e1190000-0000-4000-8000-00000000000b', 'fb@test.local');
insert into public.jobs (id, user_id, source_url, duration_seconds, status) values
  ('e1191000-0000-4000-8000-00000000000b', 'e1190000-0000-4000-8000-00000000000b', 'https://b', 60, 'done');
insert into public.clips (id, job_id, idx, start_seconds, end_seconds, source_start, source_end) values
  ('e1192000-0000-4000-8000-00000000000b', 'e1191000-0000-4000-8000-00000000000b', 0, 1, 20, 1, 20);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1190000-0000-4000-8000-00000000000a"}';

select isnt(public.send_feedback('missing_capability', 'User wanted a ProRes export; only H.264 exists.', null, 'medium'), null, 'ghi được một phản hồi');
select is((select count(*) from public.editor_feedback)::int, 1, 'người dùng thấy phản hồi của mình');
select throws_ok($$ select public.send_feedback('rant', 'x') $$, '22023', 'Unknown feedback category.', 'loại lạ bị từ chối');
select throws_ok($$ select public.send_feedback('failure', '  ') $$, '22023', null, 'tóm tắt rỗng bị từ chối');
select throws_ok($$ insert into public.editor_feedback (user_id, category, summary) values ('e1190000-0000-4000-8000-00000000000a', 'failure', 'x') $$, '42501', null, 'không ghi thẳng vào bảng');
select isnt(public.send_feedback('failure', 'Export failed on a long clip.', null, null, 'e1192000-0000-4000-8000-00000000000b'), null, 'clip của người khác vẫn ghi được');
select is((select clip_id from public.editor_feedback where summary like 'Export failed%'), null, '...nhưng không gắn clip của người khác');

select * from finish();
rollback;
