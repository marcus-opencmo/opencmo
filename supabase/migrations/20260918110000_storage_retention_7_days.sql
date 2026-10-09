-- Giữ video trên Supabase Storage trong bảy ngày sau khi project kết thúc.
--
-- `expires_at` trước đây được tính 14 ngày từ lúc TẠO job. Với job nằm hàng đợi
-- lâu, câu UI "sau khi project hoàn thành" vì thế không đúng. Trigger này đặt
-- lại mốc từ `finished_at` trên mọi đường kết thúc (done/failed/cancelled).

alter table public.jobs
  alter column expires_at set default now() + interval '7 days';

create or replace function public.set_job_storage_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status::text in ('done', 'failed', 'cancelled')
     and new.status is distinct from old.status then
    new.expires_at := coalesce(new.finished_at, now()) + interval '7 days';
  elsif new.status::text in ('queued', 'running')
        and old.status::text in ('done', 'failed', 'cancelled') then
    -- Retry phải có một cửa sổ mới; cron không được dọn source giữa lần chạy.
    new.expires_at := now() + interval '7 days';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_storage_expiry on public.jobs;
create trigger jobs_storage_expiry
before update of status, finished_at on public.jobs
for each row execute function public.set_job_storage_expiry();

revoke execute on function public.set_job_storage_expiry() from public, anon, authenticated;

