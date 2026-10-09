-- 20261023090000: huỷ một export (E2-d2, học Palmier `manage_exports`).
--
-- Đang chờ: huỷ ngay. Đang chạy: đổi trạng thái `cancelled`; nhịp heartbeat kế tiếp của
-- worker trả false (`heartbeat_task` chỉ gia hạn task `running`), worker giết exporter
-- và không công bố gì. Không có đường nào giết container Modal từ đây.

create or replace function public.cancel_export(p_task_id uuid)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and user_id = v_user and kind in ('render_document', 'export')
  for update;
  if not found then
    raise exception 'Export not found.' using errcode = 'P0002';
  end if;
  if v_task.status = 'cancelled' then
    return v_task;
  end if;
  if v_task.status not in ('queued', 'running') then
    raise exception 'This export has already finished.' using errcode = 'P0001';
  end if;
  update public.tasks
  set status = 'cancelled', error = 'Export cancelled.', lease_until = null, finished_at = now()
  where id = p_task_id
  returning * into v_task;
  return v_task;
end;
$$;

revoke all on function public.cancel_export(uuid) from public, anon;
grant execute on function public.cancel_export(uuid) to authenticated;
