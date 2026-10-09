-- OpenCMO — RLS cho mô hình dữ liệu editor.
--
-- Nguyên tắc của cả file, một câu: **client chỉ ĐỌC, và chỉ đọc của mình.**
-- Mọi thao tác ghi đi qua RPC `security definer` ở migration sau. Vì thế các
-- bảng dưới đây KHÔNG có policy insert/update/delete nào cho `authenticated` —
-- thiếu policy nghĩa là RLS từ chối, đó là mặc định ta muốn.
--
-- Hai chi tiết dễ làm sai, ghi lại:
--
-- 1. `(select auth.uid())` chứ không phải `auth.uid()`. Bọc trong subquery thì
--    Postgres tính MỘT lần cho cả câu (InitPlan); viết trần thì hàm chạy lại
--    trên từng hàng. Đây đúng là cảnh báo `auth_rls_initplan` của Supabase
--    advisor và nó đo được trên bảng vài nghìn hàng.
-- 2. Bảng con (`artifacts`, `clip_revisions`, `clip_drafts`) không có `user_id`.
--    Chúng đi ngược về `jobs` qua `clips`. Viết `exists (...)` chứ không `in (...)`
--    để planner dừng ở hàng đầu khớp.

-- --------------------------------------------------------------- bật RLS
alter table public.artifacts      enable row level security;
alter table public.clip_revisions enable row level security;
alter table public.clip_drafts    enable row level security;
alter table public.presets        enable row level security;
alter table public.media_assets   enable row level security;
alter table public.tasks          enable row level security;
alter table public.rate_limits    enable row level security;

-- ------------------------------------------------- policy đọc: có user_id
--
-- `to authenticated` chứ không để trống: policy để trống áp cho cả `anon`, và
-- `auth.uid()` của anon là null nên câu so sánh ra null (không khớp) — đúng
-- nhưng chỉ đúng do may. Ghi rõ vai thì đọc code không phải suy luận.

drop policy if exists "đọc preset của chính mình" on public.presets;
create policy "đọc preset của chính mình"
  on public.presets for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "đọc B-roll của chính mình" on public.media_assets;
create policy "đọc B-roll của chính mình"
  on public.media_assets for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "đọc task của chính mình" on public.tasks;
create policy "đọc task của chính mình"
  on public.tasks for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ------------------------------------------------- policy đọc: bảng con

drop policy if exists "đọc artifact thuộc job của mình" on public.artifacts;
create policy "đọc artifact thuộc job của mình"
  on public.artifacts for select
  to authenticated
  using (exists (
    select 1 from public.jobs j
    where j.id = artifacts.job_id and j.user_id = (select auth.uid())
  ));

drop policy if exists "đọc revision thuộc clip của mình" on public.clip_revisions;
create policy "đọc revision thuộc clip của mình"
  on public.clip_revisions for select
  to authenticated
  using (exists (
    select 1 from public.clips c
    join public.jobs j on j.id = c.job_id
    where c.id = clip_revisions.clip_id and j.user_id = (select auth.uid())
  ));

drop policy if exists "đọc draft thuộc clip của mình" on public.clip_drafts;
create policy "đọc draft thuộc clip của mình"
  on public.clip_drafts for select
  to authenticated
  using (exists (
    select 1 from public.clips c
    join public.jobs j on j.id = c.job_id
    where c.id = clip_drafts.clip_id and j.user_id = (select auth.uid())
  ));

-- `rate_limits` KHÔNG có policy nào. Người dùng không cần biết mình còn bao
-- nhiêu lượt, và đọc được bảng này là đọc được nhịp dùng của người khác.

-- ------------------------------------------------------------- jobs
--
-- Policy insert cuối cùng còn sót: `create_job()` mới là đường tạo job (ràng
-- buộc 1 của apps/web/README.md). Migration credit đã drop nó, giữ câu này để
-- database nào chạy lệch thứ tự cũng về cùng một trạng thái.
drop policy if exists "tạo job cho chính mình" on public.jobs;

-- ------------------------------------------------------------- storage
--
-- Cùng quy ước với bucket `clips` và `sources`: segment đầu của đường dẫn là
-- user id, nên quyền là một phép so chuỗi chứ không phải một truy vấn.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 2147483648, array['video/*'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('renders', 'renders', false, 2147483648)
on conflict (id) do nothing;

-- B-roll: trình duyệt ghi thẳng lên (không qua Next.js — ràng buộc 5 của
-- README), nên cần cả insert lẫn delete để huỷ lượt upload dở.
drop policy if exists "ghi B-roll vào thư mục của mình" on storage.objects;
create policy "ghi B-roll vào thư mục của mình"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "đọc B-roll trong thư mục của mình" on storage.objects;
create policy "đọc B-roll trong thư mục của mình"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "xoá B-roll trong thư mục của mình" on storage.objects;
create policy "xoá B-roll trong thư mục của mình"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Preview/export: CHỈ đọc. Worker (service role) là bên duy nhất ghi vào đây —
-- một file trong `renders/` phải là thứ engine tạo ra, không phải thứ người
-- dùng tải lên rồi gắn nhãn "bản export của tôi".
drop policy if exists "đọc bản render trong thư mục của mình" on storage.objects;
create policy "đọc bản render trong thư mục của mình"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'renders' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ------------------------------------------------------------- quyền hàm
--
-- `create function` cấp execute cho vai `public`, mà anon và authenticated đều
-- kế thừa từ đó (bài học của 20260910150634). Đổi mặc định một lần ở đây để
-- hàm mới KHÔNG tự mở: mỗi RPC ở migration sau phải grant tường minh đúng một
-- vai. Chỉ áp cho hàm tạo về sau, nên câu này phải đứng trước các migration RPC.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

-- Hàm trigger của `clip_revisions` tạo ở migration trước nên nó ra đời trước khi
-- mặc định trên đổi. Gọi thẳng chỉ báo "trigger functions can only be called as
-- triggers", nhưng không có lý do gì để nó nằm trong danh sách hàm ai cũng gọi được.
revoke execute on function public.freeze_clip_revision() from public, anon, authenticated;
