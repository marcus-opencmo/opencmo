-- Tuỳ chọn đầu ra của job: mode, aspect, layout, captions, caption_preset.
--
-- Chạy dưới vai `authenticated` với JWT giả, cùng luật với 020/050/060: đó là
-- đường PostgREST đi thật. Chạy dưới `postgres` sẽ bỏ qua cả RLS lẫn grant, và
-- test xanh ở đó không chứng minh gì.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(23);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email)
values ('d0000000-0000-4000-8000-00000000000d', 'd@test.local');

insert into public.credit_ledger (user_id, delta, reason)
values ('d0000000-0000-4000-8000-00000000000d', 500, 'Test top-up');

-- `create_job` giới hạn 3 job `queued`/`running` cùng lúc (20260921130000).
-- File này kiểm THAM SỐ của create_job, không kiểm cái trần đó, nên dọn hàng
-- đợi trước mỗi ca tạo job thành công. `security definer` vì client không có
-- policy UPDATE trên `jobs` — mọi ghi đi qua RPC, kể cả ở đây.
create function pg_temp.drain_jobs(p_user uuid) returns void
language sql security definer set search_path = public as $fn$
  update public.jobs set status = 'done' where user_id = p_user and status in ('queued', 'running');
$fn$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"d0000000-0000-4000-8000-00000000000d"}';

-- ------------------------------------------------------------------ cột
select has_column('public', 'jobs', 'mode', 'jobs có cột mode');
select has_column('public', 'jobs', 'aspect', 'jobs có cột aspect');
select has_column('public', 'jobs', 'layout', 'jobs có cột layout');
select has_column('public', 'jobs', 'captions', 'jobs có cột captions');
select has_column('public', 'jobs', 'caption_preset', 'jobs có cột caption_preset');

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
-- --------------------------------------------------------------- mặc định
-- Mặc định phải TRÙNG hành vi trước migration: job cũ không được đổi hình.
select is(
  (public.create_clip_job('https://youtu.be/def', 3, p_ownership_confirmed => true)).mode,
  'clip', 'mặc định là cắt clip'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/def2', 3, p_ownership_confirmed => true)).aspect,
  '9:16', 'mặc định vẫn là 9:16'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/def3', 3, p_ownership_confirmed => true)).layout,
  'auto', 'mặc định layout là auto — fill khi có mặt, fit khi không'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/def4', 3, p_ownership_confirmed => true)).caption_preset,
  'bold', 'mặc định preset phụ đề là bold'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/def5', 3, p_ownership_confirmed => true)).captions,
  true, 'mặc định có phụ đề'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
-- ------------------------------------------------------------- giữ lựa chọn
select is(
  (public.create_clip_job('https://youtu.be/keep', 3, 'auto', null,
                     'clip', '16:9', 'fit', false, 'minimal', p_ownership_confirmed => true)).aspect,
  '16:9', 'create_job giữ tỷ lệ khung người dùng chọn'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/keep2', 3, 'auto', null,
                     'clip', '1:1', 'fit', false, 'minimal', p_ownership_confirmed => true)).layout,
  'fit', 'create_job giữ layout người dùng chọn'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
select is(
  (public.create_clip_job('https://youtu.be/keep3', 3, 'auto', null,
                     'clip', '1:1', 'fill', false, 'clean', p_ownership_confirmed => true)).caption_preset,
  'clean', 'create_job giữ preset phụ đề người dùng chọn'
);

select pg_temp.drain_jobs('d0000000-0000-4000-8000-00000000000d');
-- ------------------------------------------------------------------- full
-- Không cắt thì chỉ có một "clip" — chính là cả video. Tin `p_clips` ở đây thì
-- DB kể một con số, kết quả kể một con số khác.
select is(
  (public.create_clip_job('https://youtu.be/full', 7, 'auto', null, 'full', p_ownership_confirmed => true)).clips_requested,
  1, 'mode full luôn là 1 clip dù client gửi 7'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/full2', 3, 'auto',
       '[{"start":0,"end":10}]'::jsonb, 'full', p_ownership_confirmed => true) $$,
  '22023', null, 'chọn đoạn + mode full là mâu thuẫn, phải báo lỗi'
);

-- -------------------------------------------------------------- giá trị lạ
select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto', null, 'tuỳ-tiện', p_ownership_confirmed => true) $$,
  '22023', null, 'mode lạ bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto', null, 'clip', '4:3', p_ownership_confirmed => true) $$,
  '22023', null, 'tỷ lệ khung lạ bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto', null,
       'clip', '9:16', 'stretch', p_ownership_confirmed => true) $$,
  '22023', null, 'layout lạ bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto', null,
       'clip', '9:16', 'fill', true, 'karaoke', p_ownership_confirmed => true) $$,
  '22023', null, 'preset phụ đề lạ bị từ chối'
);

-- ------------------------------------------------ vòng đời file của mode full
-- Bản tải nguyên bản là một lượt tải rồi xong, không phải thứ quay lại xem cả
-- tuần. Giữ một video 1–2 GB thêm sáu ngày là phần tốn nhất và vô ích nhất.
set local role postgres;

insert into public.jobs (id, user_id, source_url, mode)
values (
  '75000000-0000-4000-8000-000000000075',
  'd0000000-0000-4000-8000-00000000000d',
  'https://example.com/whole', 'full'
);
insert into public.jobs (id, user_id, source_url, mode)
values (
  '76000000-0000-4000-8000-000000000076',
  'd0000000-0000-4000-8000-00000000000d',
  'https://example.com/clips', 'clip'
);

update public.jobs
set status = 'done', finished_at = '2026-09-19 12:00:00+00'
where id in (
  '75000000-0000-4000-8000-000000000075',
  '76000000-0000-4000-8000-000000000076'
);

select is(
  (select expires_at from public.jobs where id = '75000000-0000-4000-8000-000000000075'),
  '2026-09-20 12:00:00+00'::timestamptz,
  'job full hết hạn sau 24 giờ'
);

select is(
  (select expires_at from public.jobs where id = '76000000-0000-4000-8000-000000000076'),
  '2026-09-26 12:00:00+00'::timestamptz,
  'job cắt clip vẫn giữ nguyên bảy ngày'
);

update public.jobs
set status = 'queued', finished_at = null
where id = '75000000-0000-4000-8000-000000000075';

select ok(
  (select expires_at between now() + interval '23 hours' and now() + interval '25 hours'
   from public.jobs where id = '75000000-0000-4000-8000-000000000075'),
  'retry job full mở lại cửa sổ 24 giờ, không phải bảy ngày'
);

-- ----------------------------------------------------- constraint của bảng
-- Hàm không phải chốt duy nhất: `jobs` còn những đường ghi khác (worker, retry).
-- Phải bỏ vai `authenticated`: RLS chặn insert thẳng TRƯỚC khi constraint được
-- đánh giá, nên chạy dưới vai đó chỉ kiểm lại RLS.
set local role postgres;

select throws_ok(
  $$ insert into public.jobs (user_id, source_url, aspect)
     values ('d0000000-0000-4000-8000-00000000000d', 'https://x', '4:3') $$,
  '23514', null, 'constraint chặn aspect lạ ghi thẳng vào bảng'
);

select * from finish();
rollback;
