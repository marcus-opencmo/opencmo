-- R2 (lộ trình dọn hệ video): worker nhận việc bằng MỘT lượt `claim_next_task`.
--
-- Trước đây worker gọi RPC này một lần cho mỗi kind (6 lượt mỗi vòng rảnh) chỉ
-- để giữ thứ tự ưu tiên, vì câu cũ sắp theo `created_at` thuần. Giờ thứ tự của
-- mảng `p_kinds` (lấy từ `packages/contracts/task-kinds.json`) là thứ tự ưu tiên;
-- trong cùng một kind vẫn đến trước làm trước. Gọi với một phần tử cho đúng kết
-- quả như cũ. `create or replace` giữ nguyên quyền (chỉ service_role).

begin;

create or replace function public.claim_next_task(
  p_kinds text[],
  p_lease_seconds int default 120
)
returns setof public.tasks
language sql
volatile
security definer
set search_path = public
as $$
  update public.tasks
  set status = 'running',
      attempt = attempt + 1,
      attempt_id = gen_random_uuid(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = (
    select id from public.tasks
    where status = 'queued' and kind = any(p_kinds)
    order by array_position(p_kinds, kind), created_at
    -- `skip locked`: tám worker chạy song song không bao giờ nhận trùng một task.
    for update skip locked
    limit 1
  )
  returning *;
$$;

commit;
