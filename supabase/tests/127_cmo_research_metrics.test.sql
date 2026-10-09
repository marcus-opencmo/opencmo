-- 20261029090000: W7 + W6-lite — kind mới vào hàng đợi đúng giá, insight/metrics chỉ của chủ.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(9);

insert into auth.users (id, email) values
  ('e1270000-0000-4000-8000-00000000000a', 'rm-a@test.local'),
  ('e1270000-0000-4000-8000-00000000000b', 'rm-b@test.local');
insert into public.credit_ledger (user_id, delta, reason) values ('e1270000-0000-4000-8000-00000000000a', 10, 'test');
insert into public.content_items (id, user_id, department, platform, day, idea, status) values
  ('e1271000-0000-4000-8000-00000000000a', 'e1270000-0000-4000-8000-00000000000a', 'post', 'X', current_date, 'Posted', 'published'),
  ('e1271000-0000-4000-8000-00000000000b', 'e1270000-0000-4000-8000-00000000000a', 'post', 'X', current_date, 'Draft', 'in_review'),
  ('e1271000-0000-4000-8000-00000000000c', 'e1270000-0000-4000-8000-00000000000b', 'post', 'X', current_date, 'Other', 'published');

select is((select credits from public.enqueue_cmo_run_for('e1270000-0000-4000-8000-00000000000a', 'competitor_research', '{}')), 2, 'nghiên cứu giữ 2 credit');
select is(public.credit_balance('e1270000-0000-4000-8000-00000000000a'), 8, 'trừ khi vào hàng');
select is((select credits from public.enqueue_cmo_run_for('e1270000-0000-4000-8000-00000000000a', 'pull_metrics', '{}')), 0, 'số liệu miễn phí');
select throws_ok($$ select public.enqueue_cmo_run_for('e1270000-0000-4000-8000-00000000000a', 'post_everything', '{}') $$, '22023', 'Unknown task.', 'kind lạ bị từ chối');

select is(
  public.cmo_save_metrics('e1270000-0000-4000-8000-00000000000a', '[
    {"item_id":"e1271000-0000-4000-8000-00000000000a","url":"https://x.com/a/status/1","likes":12,"replies":3},
    {"item_id":"e1271000-0000-4000-8000-00000000000b","url":"https://x.com/a/status/2","likes":1},
    {"item_id":"e1271000-0000-4000-8000-00000000000c","url":"https://x.com/b/status/3","likes":9}
  ]'::jsonb),
  1,
  'chỉ ghi bài đã đăng của chính chủ'
);
select is((select likes from public.post_metrics where item_id = 'e1271000-0000-4000-8000-00000000000a'), 12::bigint, 'số đúng');

select isnt((select id from public.cmo_save_insight('e1270000-0000-4000-8000-00000000000a', null, 'competitors', '{"hooks":[]}')), null, 'lưu insight');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1270000-0000-4000-8000-00000000000b"}';
select is((select count(*) from public.cmo_insights), 0::bigint, 'người khác không đọc insight');
select throws_ok($$ select public.cmo_save_metrics('e1270000-0000-4000-8000-00000000000b', '[]') $$, '42501', null, 'người dùng không gọi được RPC worker');

select * from finish();
rollback;
