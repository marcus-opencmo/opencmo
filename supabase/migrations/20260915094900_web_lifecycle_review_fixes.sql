-- D1 review: quyền số dư và huỷ/xoá phải an toàn ngay khi RPC được công bố.
-- Invoker giữ RLS cho client; RPC billing definer vẫn đọc đúng ledger nội bộ.
alter function public.credit_balance(uuid) security invoker;
revoke execute on function public.credit_balance(uuid) from public, anon;
grant execute on function public.credit_balance(uuid) to authenticated, service_role;

-- Plan quyết định credit/watermark, không phải thuộc tính client tự chỉnh.
revoke update on public.profiles from anon, authenticated;

create or replace function public.cancel_job(p_job_id uuid)
returns public.jobs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
begin
  -- Cùng thứ tự profiles -> jobs với settle/finalize để tránh deadlock.
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status = 'cancelled' then return v_job; end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'This project has already finished.' using errcode = '22023';
  end if;
  update public.jobs set status = 'cancelled', stage = 'cancelled',
    finished_at = now(), lease_until = null
  where id = p_job_id returning * into v_job;
  perform public.refund_job(p_job_id, 'Refund: project cancelled');
  update public.tasks set status = 'cancelled', finished_at = now(), lease_until = null
  where status in ('queued', 'running') and (
    job_id = p_job_id or clip_id in (select id from public.clips where job_id = p_job_id)
    or asset_id in (select id from public.media_assets where job_id = p_job_id)
  );
  return v_job;
end;
$$;

create or replace function public.delete_job(p_job_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
begin
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status in ('queued', 'running') then
    raise exception 'Stop this project before deleting it.' using errcode = '22023';
  end if;
  if exists (select 1 from public.tasks t where t.status in ('queued', 'running')
    and (t.job_id = p_job_id
      or t.clip_id in (select id from public.clips where job_id = p_job_id)
      or t.asset_id in (select id from public.media_assets where job_id = p_job_id))) then
    raise exception 'Wait for this project’s tasks to finish before deleting it.' using errcode = '22023';
  end if;
  delete from public.jobs where id = p_job_id and user_id = v_user;
  return found;
end;
$$;

revoke execute on function public.cancel_job(uuid), public.delete_job(uuid) from public, anon;
grant execute on function public.cancel_job(uuid), public.delete_job(uuid) to authenticated;

-- Advisor trên Supabase thật: tránh gọi auth.uid() cho từng hàng và cố định
-- search_path cả helper/trigger invoker, không chỉ RPC definer.
drop policy if exists "sửa hồ sơ của chính mình" on public.profiles;
alter policy "đọc hồ sơ của chính mình" on public.profiles using ((select auth.uid()) = id);
alter policy "đọc job của chính mình" on public.jobs using ((select auth.uid()) = user_id);
alter policy "đọc clip thuộc job của mình" on public.clips using (
  exists (select 1 from public.jobs j where j.id = clips.job_id and j.user_id = (select auth.uid()))
);
alter policy "đọc sổ cái của chính mình" on public.credit_ledger using ((select auth.uid()) = user_id);
alter function public.job_hold_credits() set search_path = public;
alter function public.signup_credits() set search_path = public;
alter function public.freeze_clip_revision() set search_path = public;
