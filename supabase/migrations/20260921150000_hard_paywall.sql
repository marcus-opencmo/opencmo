-- Hard paywall: bỏ hẳn quà đăng ký.
--
-- ⚠ THỨ TỰ TRIỂN KHAI. Migration này làm Polar thành đường sống DUY NHẤT của
-- sản phẩm: đăng ký xong có 0 credit, không mua được thì không làm được gì.
-- Áp nó trước khi năm biến `POLAR_*` sống trên Vercel nghĩa là ai đăng ký cũng
-- gặp tường, và không có cửa nào đi qua. Xem mục Polar ở `VIEC-CAN-LAM.md`.
--
-- Vì sao bỏ: `handle_new_user()` cộng 30 credit cho MỌI hàng `auth.users` mới,
-- mà hàng đó sinh ra ngay lúc người dùng BẤM "gửi link", chưa cần mở hòm thư.
-- Không captcha, không chặn hòm thư dùng một lần, nên 30 credit là giá của một
-- địa chỉ email — thứ mua được theo lô. `VISION.md` §4 đã cập nhật theo.
--
-- Tài khoản đã nhận 30 credit thì GIỮ NGUYÊN. Đòi lại một thứ đã tặng là cách
-- nhanh nhất mất những người dùng đầu tiên, và ledger vốn append-only.

begin;

create or replace function public.signup_credits()
returns int language sql immutable as $$ select 0 $$;

-- Hồ sơ vẫn phải tồn tại ngay khi đăng ký: mọi truy vấn sau đó (số dư, plan,
-- watermark) đều đọc từ đây. Chỉ dòng ledger là biến mất — một dòng delta 0 là
-- rác, và nó sẽ làm "Credit history" mở ra đã có sẵn một mục vô nghĩa.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

commit;
