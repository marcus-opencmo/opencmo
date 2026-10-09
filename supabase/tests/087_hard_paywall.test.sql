-- Hard paywall (20260921150000): tài khoản mới bắt đầu từ 0.
--
-- Quà đăng ký cũ cộng 30 credit cho MỌI hàng `auth.users` mới, mà hàng đó sinh
-- ra ngay lúc người dùng bấm "gửi link" — chưa cần mở hòm thư. Đó là giá của
-- một địa chỉ email, trả bằng tiền Modal thật.
create extension if not exists pgtap with schema extensions;

begin;
set search_path to public, extensions;
select no_plan();

insert into auth.users(id, email)
values ('e7000000-0000-4000-8000-000000000001', 'paywall@test.local');

select is(public.signup_credits(), 0, 'không tặng credit khi đăng ký');

-- Hồ sơ vẫn PHẢI được tạo: số dư, plan và watermark đều đọc từ đây, và
-- `handle_new_user()` là chỗ duy nhất tạo nó.
select is(
  (select count(*)::int from public.profiles where id = 'e7000000-0000-4000-8000-000000000001'),
  1, 'hồ sơ vẫn được tạo ngay khi đăng ký'
);

select is(
  (select email from public.profiles where id = 'e7000000-0000-4000-8000-000000000001'),
  'paywall@test.local', 'hồ sơ mang đúng email'
);

select is(
  (select credit_balance from public.profiles where id = 'e7000000-0000-4000-8000-000000000001'),
  0, 'số dư khởi điểm là 0'
);

-- Không phải "một dòng delta 0" mà là KHÔNG CÓ DÒNG NÀO: trang Credit history
-- mở ra phải trống, không phải có sẵn một mục vô nghĩa.
select is(
  (select count(*)::int from public.credit_ledger
   where user_id = 'e7000000-0000-4000-8000-000000000001'),
  0, 'không có dòng ledger nào được sinh ra lúc đăng ký'
);

-- Và đó là ý nghĩa thật của "hard": đăng ký xong chưa tạo được job.
set local role authenticated;
set local request.jwt.claims = '{"sub":"e7000000-0000-4000-8000-000000000001"}';

select throws_ok(
  $$ select public.create_clip_job('https://youtu.be/paywall', 1, p_ownership_confirmed => true) $$,
  'P0001', 'Not enough credits: 10 needed, 0 left. Top up on the Credits page.',
  'tài khoản mới không tạo được job cho tới khi mua gói'
);

reset role;

-- Mua gói xong thì mở khoá — đường duy nhất vào sản phẩm phải thật sự thông.
insert into public.credit_ledger(user_id, delta, reason)
values ('e7000000-0000-4000-8000-000000000001', 150, 'Starter purchase');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e7000000-0000-4000-8000-000000000001"}';

select lives_ok(
  $$ select public.create_clip_job('https://youtu.be/paywall-paid', 1, p_ownership_confirmed => true) $$,
  'nạp credit xong thì tạo job được ngay'
);

select * from finish();
rollback;
