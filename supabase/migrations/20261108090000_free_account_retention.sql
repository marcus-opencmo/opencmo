-- Tài khoản chưa từng trả tiền bị xoá sau 30 ngày (quyết định 09/10/2026).
--
-- "Đã trả tiền" = có đơn Polar đã thanh toán > 0 và chưa hoàn hết, HOẶC đang có gói
-- active/past_due, HOẶC profile không còn ở gói free, HOẶC được miễn tay (`retention_exempt`,
-- cho tài khoản nội bộ). Người từng trả tiền không bao giờ bị xoá tự động.
--
-- Đồng hồ là `retention_from`, không phải `created_at`: migration này điền now() cho mọi hàng có
-- sẵn, nên tài khoản cũ có đủ 30 ngày kể từ lúc luật lên production.
--
-- Xoá: `purge_unpaid_accounts` đưa mọi file Storage của user (đường dẫn `<uid>/…` ở mọi bucket)
-- vào `storage_deletions` rồi trả uid; cron gọi `auth.admin.deleteUser` — 25 bảng FK cascade xoá
-- hàng DB, vòng dọn Storage có sẵn xoá file.

alter table public.profiles
  add column retention_from timestamptz not null default now(),
  add column retention_exempt boolean not null default false;

-- Người dùng không tự sửa được hai cột này (profiles không có policy update cho cột lạ, nhưng
-- chặn rõ ở mức cột để một policy sau này không mở ra).
revoke update (retention_from, retention_exempt) on public.profiles from authenticated, anon;

create or replace function public.account_is_paid(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.profiles p
      where p.id = p_user and (p.retention_exempt or p.plan <> 'free')
    )
    or exists (
      select 1 from public.polar_purchases o
      where o.user_id = p_user and o.paid_at is not null
        and o.total_amount > 0 and o.refunded_amount < o.total_amount
    )
    or exists (
      select 1 from public.polar_subscriptions s
      where s.user_id = p_user and s.status in ('active', 'past_due')
    );
$$;

revoke all on function public.account_is_paid(uuid) from public, anon, authenticated;
grant execute on function public.account_is_paid(uuid) to service_role;

-- Cho banner trong app: chính mình, không nhận tham số user.
create or replace function public.account_retention()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_from timestamptz;
begin
  if v_user is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if public.account_is_paid(v_user) then
    return jsonb_build_object('paid', true, 'delete_after', null);
  end if;
  select retention_from into v_from from public.profiles where id = v_user;
  return jsonb_build_object('paid', false, 'delete_after', coalesce(v_from, now()) + interval '30 days');
end;
$$;

revoke all on function public.account_retention() from public, anon;
grant execute on function public.account_retention() to authenticated;

create or replace function public.purge_unpaid_accounts(p_limit integer default 50)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500.';
  end if;

  for v_user in
    select p.id
    from public.profiles p
    where p.retention_from + interval '30 days' < now()
      and not public.account_is_paid(p.id)
      -- Đang có việc chạy dở (worker giữ lease): để lượt cron sau.
      and not exists (
        select 1 from public.tasks t
        where t.user_id = p.id and t.status in ('queued', 'running')
      )
    order by p.retention_from
    limit p_limit
    for update of p skip locked
  loop
    insert into public.storage_deletions (bucket, path, user_id)
    select o.bucket_id, o.name, v_user
    from storage.objects o
    where o.bucket_id in ('clips', 'sources', 'renders', 'media', 'exports', 'brand')
      and o.name like v_user::text || '/%'
      and not exists (
        select 1 from public.storage_deletions d where d.bucket = o.bucket_id and d.path = o.name
      );
    return next v_user;
  end loop;
end;
$$;

revoke all on function public.purge_unpaid_accounts(integer) from public, anon, authenticated;
grant execute on function public.purge_unpaid_accounts(integer) to service_role;
