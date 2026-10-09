-- Đóng lại quyền gọi `live_source_paths()`.
--
-- Migration trước viết `revoke execute ... from anon, authenticated` và tưởng
-- thế là xong. Không xong: `create function` mặc định CẤP execute cho vai
-- `public`, mà anon với authenticated đều kế thừa từ public — nên thu quyền của
-- riêng chúng chẳng đổi được gì. Đã kiểm bằng curl với anon key: hàm vẫn chạy
-- và vẫn trả kết quả.
--
-- Hàm này là `security definer` và trả về đường dẫn file nguồn của MỌI người
-- dùng (đường dẫn có chứa user id và tên file họ đặt). RLS vẫn chặn việc đọc
-- nội dung file, nhưng danh sách đó không việc gì phải để lộ.
--
-- Chỉ service role được gọi — nó không đi qua PostgREST role, và cron dọn rác là
-- nơi duy nhất cần hàm này.

revoke execute on function public.live_source_paths() from public;
revoke execute on function public.live_source_paths() from anon, authenticated;
