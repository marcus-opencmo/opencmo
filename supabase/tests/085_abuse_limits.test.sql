-- Siết lạm dụng (20260921130000): ba chốt của route nay nằm trong SQL, và huỷ
-- job đang chạy phải tốn tiền.
--
-- Chạy dưới vai `authenticated` với JWT giả — đó là đường PostgREST đi thật, và
-- cũng chính là đường mà một dòng curl đi vòng qua route. Chạy dưới `postgres`
-- sẽ bỏ qua cả RLS lẫn grant, và test xanh ở đó không chứng minh gì.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;

select no_plan();

-- --------------------------------------------------------------- fixture
insert into auth.users (id, email) values
  ('e5000000-0000-4000-8000-000000000001', 'abuse-a@test.local'),
  ('e5000000-0000-4000-8000-000000000002', 'abuse-b@test.local'),
  ('e5000000-0000-4000-8000-000000000003', 'abuse-c@test.local');

insert into public.credit_ledger (user_id, delta, reason) values
  ('e5000000-0000-4000-8000-000000000001', 500, 'Test top-up'),
  ('e5000000-0000-4000-8000-000000000002', 500, 'Test top-up'),
  ('e5000000-0000-4000-8000-000000000003', 500, 'Test top-up');

-- Dọn hàng đợi mà không cần vai postgres: client không có policy UPDATE trên
-- `jobs`, mọi ghi đi qua RPC — kể cả trong test.
create function pg_temp.drain_jobs(p_user uuid) returns void
language sql security definer set search_path = public as $fn$
  update public.jobs set status = 'done' where user_id = p_user and status in ('queued', 'running');
$fn$;

-- Đặt job sang `running` để kiểm nhánh huỷ-khi-đang-chạy.
create function pg_temp.mark_running(p_job uuid) returns void
language sql security definer set search_path = public as $fn$
  update public.jobs set status = 'running' where id = p_job;
$fn$;

-- `rate_limits` bật RLS và CỐ Ý không có policy nào (20260914091000_web_rls),
-- nên vai `authenticated` đọc ra rỗng chứ không ra lỗi. Đọc qua đây để khẳng
-- định về bộ đếm nói đúng chuyện nó định nói.
create function pg_temp.rate_count(p_user uuid, p_bucket text) returns int
language sql security definer set search_path = public as $fn$
  select count from public.rate_limits
  where user_id = p_user and bucket = p_bucket
  order by window_start desc limit 1;
$fn$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000001"}';

-- ==================================================== host nguồn (chốt SSRF)
--
-- Trước migration này allowlist CHỈ nằm ở `lib/api/source.ts`, nên gọi thẳng
-- `rpc/create_job` nhét được url bất kỳ vào `jobs.source_url`.
select throws_ok(
  $$ select public.create_clip_job('http://169.254.169.254/latest/meta-data/', 1, p_ownership_confirmed => true) $$,
  '22023', 'Paste a public HTTP or HTTPS video link.',
  'endpoint metadata của máy ảo bị từ chối ngay trong SQL'
);

select throws_ok(
  $$ select public.create_clip_job('file:///etc/passwd', 1, p_ownership_confirmed => true) $$,
  '22023', 'Paste a public HTTP or HTTPS video link.',
  'file:// bị từ chối'
);

select lives_ok(
  $$ select public.create_clip_job('https://cdn.example.com/video.mp4', 1, p_ownership_confirmed => true) $$,
  'host HTTPS công khai ngoài YouTube/Vimeo vẫn được nhận'
);

-- `youtube.com.evil.example` bắt đầu bằng một host hợp lệ nhưng không phải nó.
select throws_ok(
  $$ select public.create_clip_job('https://user:pass@example.com/video.mp4', 1, p_ownership_confirmed => true) $$,
  '22023', 'Paste a public HTTP or HTTPS video link.',
  'URL nhúng credential bị từ chối'
);

select throws_ok(
  $$ select public.create_clip_job('ftp://cdn.example.com/video.mp4', 1, p_ownership_confirmed => true) $$,
  '22023', 'Paste a public HTTP or HTTPS video link.',
  'scheme ngoài HTTP(S) bị từ chối'
);

select lives_ok(
  $$ select public.create_clip_job('https://www.youtube.com/watch?v=ok', 1, p_ownership_confirmed => true) $$,
  'link YouTube hợp lệ vẫn qua'
);

-- Route so host bằng `new URL().hostname.toLowerCase()`, nên một link viết hoa
-- qua được route. SQL phải nhận đúng cái route đã nhận, nếu không người dùng
-- nhận "Paste a YouTube or Vimeo link." cho một link hoàn toàn dùng được.
select lives_ok(
  $$ select public.create_clip_job('https://www.YouTube.com/watch?v=ok-upper', 1, p_ownership_confirmed => true) $$,
  'host viết hoa vẫn qua — route đã hạ chữ trước khi so'
);

-- ===================================================== trần job đang chạy
select pg_temp.drain_jobs('e5000000-0000-4000-8000-000000000001');
select lives_ok(
  $$ select public.create_clip_job('https://youtu.be/cap-1', 1, p_ownership_confirmed => true);
     select public.create_clip_job('https://youtu.be/cap-2', 1, p_ownership_confirmed => true);
     select public.create_clip_job('https://youtu.be/cap-3', 1, p_ownership_confirmed => true) $$,
  'ba job mở cùng lúc vẫn tạo được'
);

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/cap-4', 1, p_ownership_confirmed => true) $$,
  'P0001', 'You already have 3 projects in progress. Please wait for one to finish.',
  'job thứ tư bị từ chối — hàng đợi không bị một người chiếm'
);

-- Trần đếm theo job MỞ, không theo tổng số: đóng bớt là tạo tiếp được.
select pg_temp.drain_jobs('e5000000-0000-4000-8000-000000000001');
select lives_ok(
  $$ select public.create_clip_job('https://youtu.be/cap-5', 1, p_ownership_confirmed => true) $$,
  'đóng job cũ thì tạo tiếp được'
);

-- Trần theo TỪNG người: user B không bị user A làm ảnh hưởng.
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000002"}';
select lives_ok(
  $$ select public.create_clip_job('https://youtu.be/other-user', 1, p_ownership_confirmed => true) $$,
  'trần tính riêng từng người'
);
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000001"}';

-- ============================================== rate limit nằm TRONG rpc
--
-- Trước migration này `jobs 10/giờ` chỉ có ở route; gọi thẳng RPC là bỏ qua.
-- User C dùng riêng cho mục này để bộ đếm không lẫn với các ca ở trên.
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000003"}';

create temporary table rate_probe(created int, blocked text) on commit drop;
grant select, insert on rate_probe to authenticated;

do $$
declare i int; v_created int := 0; v_blocked text := null;
begin
  for i in 1..12 loop
    -- Dọn hàng đợi mỗi vòng để chạm trần RATE, không phải trần đồng thời.
    -- Phải qua `pg_temp.drain_jobs`: một UPDATE thẳng ở đây chạy dưới vai
    -- `authenticated`, và `jobs` không có policy UPDATE nào — nó sẽ lặng lẽ
    -- sửa 0 hàng thay vì báo lỗi.
    perform pg_temp.drain_jobs('e5000000-0000-4000-8000-000000000003');
    begin
      perform public.create_clip_job('https://youtu.be/rate-' || i, 1, p_ownership_confirmed => true);
      v_created := v_created + 1;
    exception when others then
      v_blocked := sqlerrm;
      exit;
    end;
  end loop;
  insert into rate_probe values (v_created, v_blocked);
end $$;

select is(
  (select created from rate_probe), 10,
  'đúng 10 job qua được trong một giờ khi gọi thẳng RPC'
);

select is(
  (select blocked from rate_probe),
  'Too many projects started. Please wait a while and try again.',
  'lần thứ 11 bị RPC chặn — rate limit không còn phụ thuộc route'
);

-- Lượt thứ 11 có tăng bộ đếm, nhưng `raise` của create_job cuộn lại cả
-- subtransaction của nó — kể cả dòng `rate_limit_hit` vừa ghi. Nên bộ đếm dừng
-- ở 10: người bị chặn KHÔNG bị tính thêm lượt, và cũng không tự nới thêm.
select is(
  pg_temp.rate_count('e5000000-0000-4000-8000-000000000003', 'jobs'),
  10, 'bộ đếm dừng đúng ở trần; lượt bị từ chối cuộn lại cùng giao dịch'
);

-- ================================== huỷ job đang chạy phải tốn 1 credit
--
-- Hoàn ĐỦ nghĩa là start-rồi-huỷ là một vòng lặp compute miễn phí: worker đã
-- tải và giải mã thật rồi.
set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000002"}';
select pg_temp.drain_jobs('e5000000-0000-4000-8000-000000000002');

create temporary table cancel_probe(label text primary key, balance int) on commit drop;
grant select, insert on cancel_probe to authenticated;

do $$
declare v_job public.jobs; v_before int;
begin
  -- Huỷ khi còn `queued`: chưa tốn gì, hoàn đủ.
  v_before := public.credit_balance('e5000000-0000-4000-8000-000000000002');
  v_job := public.create_clip_job('https://youtu.be/cancel-queued', 1, p_ownership_confirmed => true);
  perform public.cancel_job(v_job.id);
  insert into cancel_probe values
    ('queued', public.credit_balance('e5000000-0000-4000-8000-000000000002') - v_before);

  -- Huỷ khi đã `running`: giữ lại đúng 1 credit.
  v_before := public.credit_balance('e5000000-0000-4000-8000-000000000002');
  v_job := public.create_clip_job('https://youtu.be/cancel-running', 1, p_ownership_confirmed => true);
  perform pg_temp.mark_running(v_job.id);
  perform public.cancel_job(v_job.id);
  insert into cancel_probe values
    ('running', public.credit_balance('e5000000-0000-4000-8000-000000000002') - v_before);
end $$;

select is(
  (select balance from cancel_probe where label = 'queued'),
  0, 'huỷ job còn trong hàng đợi thì hoàn đủ — chưa tốn compute nào'
);

select is(
  (select balance from cancel_probe where label = 'running'),
  -1, 'huỷ job đang chạy giữ lại đúng 1 credit'
);

-- Hai vế được ghi thành hai dòng ledger riêng để đối soát đọc được cả hai.
select is(
  (select count(*)::int from public.credit_ledger
   where user_id = 'e5000000-0000-4000-8000-000000000002'
     and reason = 'Cancelled while running'),
  1, 'phần giữ lại là một dòng ledger riêng, không trừ ngầm vào số hoàn'
);

select * from finish();
rollback;
