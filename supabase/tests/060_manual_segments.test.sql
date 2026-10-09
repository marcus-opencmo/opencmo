-- Đoạn video người dùng tự chọn: `jobs.segments` + `create_clip_job(p_segments, p_ownership_confirmed => true)`.
--
-- Chạy dưới vai `authenticated` với JWT giả, cùng luật với 020 và 050: đó là
-- đường PostgREST đi thật. Chạy dưới `postgres` sẽ bỏ qua cả RLS lẫn grant, và
-- test xanh ở đó không chứng minh gì.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select plan(18);

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email)
values ('c0000000-0000-4000-8000-00000000000c', 'c@test.local');

insert into public.credit_ledger (user_id, delta, reason)
values ('c0000000-0000-4000-8000-00000000000c', 100, 'Test top-up');

-- `create_job` giới hạn 3 job `queued`/`running` cùng lúc (20260921130000).
-- File này kiểm THAM SỐ của create_job, không kiểm cái trần đó, nên dọn hàng
-- đợi trước mỗi ca tạo job thành công. `security definer` vì client không có
-- policy UPDATE trên `jobs` — mọi ghi đi qua RPC, kể cả ở đây.
create function pg_temp.drain_jobs(p_user uuid) returns void
language sql security definer set search_path = public as $fn$
  update public.jobs set status = 'done' where user_id = p_user and status in ('queued', 'running');
$fn$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0000000-0000-4000-8000-00000000000c"}';

-- ------------------------------------------------------------- cột segments
select has_column('public', 'jobs', 'segments', 'jobs có cột segments');

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
select is(
  (public.create_clip_job('https://youtu.be/no-seg', 3, p_ownership_confirmed => true)).segments,
  null, 'không chọn đoạn nào thì segments là null — nhánh AI như cũ'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
-- Mảng rỗng KHÔNG phải lỗi: kéo một đoạn rồi xoá nó đi vẫn phải tạo được job.
select is(
  (public.create_clip_job('https://youtu.be/empty', 3, 'auto', '[]'::jsonb, p_ownership_confirmed => true)).segments,
  null, 'mảng rỗng được coi là "để AI chọn"'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
select is(
  (public.create_clip_job('https://youtu.be/empty2', 3, 'auto', '[]'::jsonb, p_ownership_confirmed => true)).clips_requested,
  3, 'mảng rỗng thì vẫn dùng số clip người dùng chọn'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
-- --------------------------------------------------- số clip LÀ số đoạn
select is(
  (public.create_clip_job('https://youtu.be/two', 5, 'auto',
    '[{"start":10,"end":40},{"start":100,"end":130}]'::jsonb, p_ownership_confirmed => true)).clips_requested,
  2, 'số clip suy từ số đoạn, không phải từ p_clips'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
select is(
  jsonb_array_length(
    (public.create_clip_job('https://youtu.be/keep', 5, 'auto',
      '[{"start":10,"end":40},{"start":100,"end":130}]'::jsonb, p_ownership_confirmed => true)).segments
  ),
  2, 'segments được lưu lại nguyên vẹn'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
-- Clip 1 phải là đoạn SỚM NHẤT — đúng thứ tự người dùng nhìn trên thanh bar.
select is(
  ((public.create_clip_job('https://youtu.be/sorted', 5, 'auto',
    '[{"start":100,"end":130},{"start":10,"end":40}]'::jsonb, p_ownership_confirmed => true)).segments -> 0 ->> 'start')::numeric,
  10::numeric, 'segments được sắp theo thời gian trước khi lưu'
);

select pg_temp.drain_jobs('c0000000-0000-4000-8000-00000000000c');
select is(
  (public.create_clip_job('https://youtu.be/len', 5, 'long',
    '[{"start":10,"end":40}]'::jsonb, p_ownership_confirmed => true)).clip_length,
  'long', 'chọn đoạn vẫn giữ được lựa chọn độ dài'
);

-- ------------------------------------------------------------ các ca từ chối
select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":10,"end":40},{"start":30,"end":60}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Your moments overlap. Move them apart and try again.',
  'đoạn chồng lấn bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":40,"end":40}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Each moment must be at least 1 second long.',
  'đoạn dài 0 giây bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":40,"end":10}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Each moment must be at least 1 second long.',
  'đoạn ngược bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":0,"end":300}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Each moment must be 3 minutes or shorter.',
  'đoạn quá 3 phút bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":-5,"end":40}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'A moment cannot start before the video does.',
  'mốc âm bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":10}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Each moment needs a start and end time.',
  'thiếu mốc kết thúc bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       '[{"start":"10","end":"40"}]'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Each moment needs a start and end time.',
  'mốc dạng chuỗi bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto',
       (select jsonb_agg(jsonb_build_object('start', i * 10, 'end', i * 10 + 5))
          from generate_series(0, 10) as i), p_ownership_confirmed => true) $$,
  '22023', 'Pick at most 10 moments.',
  'quá 10 đoạn bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/x', 3, 'auto', '{"start":1}'::jsonb, p_ownership_confirmed => true) $$,
  '22023', 'Pick the moments you want on the timeline.',
  'segments không phải mảng bị từ chối'
);

-- ----------------------------------------------------- constraint của bảng
-- Hàm không phải chốt duy nhất: `jobs` còn những đường ghi khác (worker, retry),
-- và một cột jsonb không kiểm hình dạng là chỗ để rác nằm im tới lúc worker vấp
-- phải nó giữa job.
--
-- Phải bỏ vai `authenticated` ở đây: RLS chặn insert thẳng TRƯỚC khi constraint
-- được đánh giá, nên chạy dưới vai đó chỉ kiểm lại RLS chứ không kiểm constraint.
set local role postgres;

select throws_ok(
  $$ insert into public.jobs (user_id, source_url, segments)
     values ('c0000000-0000-4000-8000-00000000000c', 'https://x',
             '[{"start":"a","end":"b"}]'::jsonb) $$,
  '23514', null, 'constraint chặn segments sai hình dạng ghi thẳng vào bảng'
);

select * from finish();
rollback;
