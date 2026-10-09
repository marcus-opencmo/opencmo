-- A4b (spec editor-rewrite): gỡ phía server của export trong trình duyệt.
--
-- Từ C3 không còn client nào encode trên máy người dùng: nút Export gọi
-- `request_document_export`, worker vẽ document trên server. Đường cũ (task
-- `client_export` chờ trình duyệt upload → task `finalize` đóng dấu) chỉ còn là
-- chỗ cho một request lạc gọi vào.
--
-- GIỮ `client_export`/`finalize` trong check `tasks.kind` và `awaiting_upload`
-- trong check `status`: production có thể có hàng cũ, và task là lịch sử lẫn
-- mốc quota — xoá giá trị khỏi check thì migration hỏng trên đúng database đó.
--
-- `reserve_upload` vẫn cấp được reservation cho path trong bucket `exports`,
-- nhưng policy ghi `exports` từ trình duyệt bị gỡ dưới đây: reservation đó
-- không mở được lượt upload nào. Để nguyên hàm (dùng chung với upload nguồn và
-- B-roll) thay vì chép lại gần trăm dòng chỉ để bỏ một nhánh đã chết.

begin;

-- Task treo của đường cũ: huỷ và trả quota export như `expire_…` từng làm.
do $$
declare r record;
begin
  for r in
    select id, user_id, created_at
    from public.tasks
    where (kind = 'client_export' and status = 'awaiting_upload')
       or (kind = 'finalize' and status in ('queued', 'running'))
    for update
  loop
    update public.tasks
    set status = 'cancelled',
        error = 'Exports now run on our servers. Export again to get your file.',
        finished_at = now(),
        lease_until = null
    where id = r.id;
    perform public.release_rate_limit_for(r.user_id, 'export', r.created_at);
  end loop;
end;
$$;

-- Cron dọn quota gọi hàm này; bỏ bước expire của đường cũ.
create or replace function public.purge_stale_rate_limits()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rows = row_count;
  delete from public.upload_reservations
   where status = 'reserved' and expires_at < now() - interval '1 day';
  delete from public.polar_webhook_receipts where received_at < now() - interval '90 days';
  return v_rows;
end;
$$;

drop function if exists public.request_client_export(uuid, uuid, uuid);
drop function if exists public.complete_client_export(uuid, bigint, numeric);
drop function if exists public.cancel_client_export(uuid);
drop function if exists public.expire_abandoned_client_exports();

-- Trình duyệt không còn ghi vào `exports`; chỉ worker (service role) ghi bản xuất.
drop policy if exists "ghi export browser vào thư mục của mình" on storage.objects;

commit;
