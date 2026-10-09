-- 20261028090000: cmo_add_item — chỉ thêm cho chính mình, kiểm đầu vào, trần 40 mục mở.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(7);

insert into auth.users (id, email) values
  ('e1260000-0000-4000-8000-00000000000a', 'task-a@test.local'),
  ('e1260000-0000-4000-8000-00000000000b', 'task-b@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1260000-0000-4000-8000-00000000000a"}';

select is(
  (select department || '|' || platform || '|' || status || '|' || (body->>'source') || '|' || (body->>'clips')
     from public.cmo_add_item('video', '  Clip the pricing rant  ', current_date + 1, 'Strong hook', '{"clips":3}')),
  'video|Shorts|planned|cmo_chat|3',
  'mục video vào lịch, nền tảng suy ra, đánh dấu nguồn'
);
select is((select platform from public.cmo_add_item('post', 'Launch thread', current_date)), 'X', 'mục X hôm nay');
select throws_ok($$ select public.cmo_add_item('email', 'x', current_date) $$, '22023', 'Pick X, Reddit or video for this task.', 'department lạ bị từ chối');
select throws_ok($$ select public.cmo_add_item('post', 'x', current_date + 30) $$, '22023', 'Pick a day in the next two weeks.', 'ngày quá xa bị từ chối');
select throws_ok($$ select public.cmo_add_item('post', '   ', current_date) $$, '22023', null, 'ý tưởng rỗng bị từ chối');

select lives_ok($$ select public.cmo_add_item('post', 'Filler ' || g, current_date + 2) from generate_series(1, 38) g $$, 'đầy tới 40 mục mở');
select throws_ok($$ select public.cmo_add_item('post', 'One too many', current_date + 3) $$, 'P0001', null, 'mục thứ 41 bị chặn');

select * from finish();
rollback;
