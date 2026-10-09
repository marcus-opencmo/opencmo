-- retry_job đặt lại `attempt` về 0.
--
-- `reclaim_expired_jobs` chỉ requeue khi attempt < 3. Job bị reclaim 2 lần rồi
-- fail, người dùng bấm Retry: lượt claim kế tiếp là attempt 3, và lần hết lease
-- đầu tiên sau đó đánh failed ngay ("interrupted too many times") thay vì chạy
-- lại. Một lượt Retry của người dùng là một lượt chạy mới, được đủ số lần thử.
--
-- Thân hàm giữ nguyên bản 20260917090000, chỉ thêm `attempt = 0`.
-- `create or replace` giữ nguyên grant đã cấp.
create or replace function public.retry_job(p_job_id uuid)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_spent int;
  v_balance int;
  v_status public.job_status;
  v_job public.jobs;
begin
  -- Khoá hồ sơ TRƯỚC khi đọc số dư, đúng thứ tự của `create_job`: hai tab bấm
  -- Retry cùng lúc không được tiêu quá số dư.
  perform 1 from public.profiles where id = v_user for update;

  select status into v_status
  from public.jobs
  where id = p_job_id and user_id = v_user
  for update;

  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_status not in ('failed', 'cancelled') then
    raise exception 'Only a failed project can be run again.' using errcode = '22023';
  end if;

  -- Lần chạy trước có thể đã được hoàn credit (`finalize_job_failure`). Giữ lại
  -- đúng phần còn thiếu để một job không bao giờ bị tính tiền hai lần.
  v_spent := public.job_credits_spent(p_job_id);
  if v_spent < v_hold then
    select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;

    if v_balance < v_hold - v_spent then
      raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
        v_hold - v_spent, v_balance using errcode = 'P0001';
    end if;

    insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (v_user, -(v_hold - v_spent), 'Hold for retry', p_job_id);
  end if;

  update public.jobs
  set status = 'queued',
      stage = 'queued',
      error = null,
      finished_at = null,
      -- attempt_id để null: worker của lần chạy cũ (nếu còn sống) ghi bằng
      -- attempt_id cũ sẽ bị mọi RPC có fence từ chối.
      attempt_id = null,
      lease_until = null,
      heartbeat_at = null,
      attempt_started_at = null,
      call_id = null,
      attempt = 0
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;
