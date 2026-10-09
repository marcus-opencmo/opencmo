-- Hai chỗ người dùng không thấy gì / phải bấm (02/10):
--
-- 1. Assistant dừng "Continue for 10 more credits?" giữa mọi việc vừa phải:
--    phần giữ đầu chỉ 5 credit (đo production: lượt hold 15–20 = đã bấm 2–3 lần).
--    agent_auto_extend: lượt đang chạy tự giữ thêm agent_extend_credits() khi số
--    dư đủ, tới trần agent_auto_hold_cap() mỗi lượt. Vẫn trừ theo mức dùng thật;
--    phần giữ thừa hoàn lúc chốt lượt. Chạm trần hay hết số dư thì vẫn dừng hỏi.
--
-- 2. Export không có tiến độ: tasks.progress (0–1) do worker ghi qua task_progress,
--    chỉ attempt đang giữ task được ghi (như heartbeat_task).

create or replace function public.agent_auto_hold_cap()
returns int language sql immutable set search_path = public as $$ select 60 $$;

-- Trả phần giữ MỚI; không đổi gì (và không lỗi) khi lượt không chạy, đã chạm
-- trần, hay số dư không đủ — vòng lặp khi đó dừng hỏi như cũ.
create or replace function public.agent_auto_extend(p_turn_id uuid)
returns int language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := least(public.agent_extend_credits(), public.agent_auto_hold_cap() - v_turn.hold_credits);
  if v_turn.status <> 'running' or v_more <= 0 or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  insert into public.credit_ledger(user_id, delta, reason) values (v_user, -v_more, 'Assistant hold');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$$;

revoke execute on function public.agent_auto_extend(uuid) from public, anon;
grant execute on function public.agent_auto_extend(uuid) to authenticated;
grant execute on function public.agent_auto_hold_cap() to authenticated;

-- ------------------------------------------------------------ tiến độ task

alter table public.tasks add column if not exists progress real
  check (progress is null or (progress >= 0 and progress <= 1));

-- Ghi tiến độ của attempt đang giữ task; false khi attempt đã mất quyền.
-- Ghi thẳng (không "chỉ tăng"): attempt mới sau requeue phải bắt đầu lại từ đầu.
create or replace function public.task_progress(p_task_id uuid, p_attempt_id uuid, p_progress real)
returns boolean language sql volatile security definer set search_path = public
as $$
  with touched as (
    update public.tasks
    set progress = least(1, greatest(0, p_progress))
    where id = p_task_id and status = 'running' and attempt_id = p_attempt_id
    returning 1
  )
  select exists (select 1 from touched);
$$;

revoke execute on function public.task_progress(uuid, uuid, real) from public, anon, authenticated;
grant execute on function public.task_progress(uuid, uuid, real) to service_role;
