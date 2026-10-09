-- Upload video từ máy người dùng.
--
-- Vì sao cần: YouTube chặn IP datacenter (note.md #1) nên đường dán-link đang
-- tắc cho tới khi mua proxy. Groq và Gemini không bị chặn — chỉ yt-dlp bị. Upload
-- vì thế là đường DUY NHẤT đưa sản phẩm tới người dùng lúc này, và nó chính là
-- phương án (b) ở cổng kiểm soát 11/9 trong PLAN.md.
--
-- Không đụng gì tới bảng `jobs`. Nguồn upload đi vào cột `source_url` có sẵn
-- dưới dạng `storage://<đường-dẫn>` — xem UPLOAD.md, quyết định 3.

-- ------------------------------------------------------------ bucket sources

-- Bucket RIÊNG, không dùng chung `clips`, vì vòng đời ngược nhau: clip sống 14
-- ngày cho người dùng tải về, file nguồn xoá NGAY khi job kết thúc. Trộn chung
-- là phải viết logic phân biệt bằng đường dẫn — thứ mà một bucket riêng cho không.
--
-- `file_size_limit` ở đây là trần của bucket. Trần THẬT là min(bucket, toàn dự
-- án), mà trần toàn dự án của gói Free là 50MB — tức trên Free tính năng này chỉ
-- chạy được với file nhỏ, không cần đổi migration khi nâng Pro.
--
-- `allowed_mime_types` chặn ở tầng storage để một file .zip không nằm được trong
-- bucket dù client có gọi sai. Đây là chốt chặn cuối, không phải chốt duy nhất —
-- server action vẫn kiểm phần mở rộng.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sources', 'sources', false, 2147483648, array['video/*'])
on conflict (id) do nothing;

-- ------------------------------------------------------------------ policies
--
-- Đường dẫn là <user_id>/<uuid>.<ext> — giữ đúng quy ước "segment đầu là user
-- id" mà bucket `clips` đang dùng (20260907162807_init.sql).
--
-- Ba policy chứ không phải một: `clips` chỉ cần SELECT vì worker mới là bên ghi,
-- còn ở đây chính TRÌNH DUYỆT ghi file lên. Thiếu policy INSERT thì
-- `createSignedUploadUrl()` bị RLS từ chối ngay ở bước ký, và không ai upload
-- được gì.

create policy "ghi file nguồn vào thư mục của mình"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "đọc file nguồn trong thư mục của mình"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE để người dùng huỷ được lần upload dở dang của chính mình. Đường dọn dẹp
-- chính vẫn là worker (xoá sau khi job xong) và cron (nhặt file mồ côi), cả hai
-- chạy bằng service role nên không phụ thuộc policy này.
create policy "xoá file nguồn trong thư mục của mình"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- --------------------------------------------------- danh sách nguồn còn sống
--
-- Cron dọn file mồ côi cần biết: đường dẫn nào trong bucket `sources` vẫn còn
-- một job trỏ tới. Trả về từ SQL chứ không để route tự ghép, vì route chạy bằng
-- service role — một câu lọc sai ở đó là xoá nhầm file của người đang dùng.
--
-- Chỉ tính job CHƯA kết thúc: job đã done/failed thì worker đã xoá file nguồn
-- rồi, và nếu nó còn nằm lại thì đó đúng là rác cần dọn.
create or replace function public.live_source_paths()
returns table (path text)
language sql
stable
security definer
set search_path = public
as $$
  select substring(j.source_url from 11)
  from public.jobs j
  where j.source_url like 'storage://%'
    and j.status in ('queued', 'running');
$$;

revoke execute on function public.live_source_paths() from anon, authenticated;
