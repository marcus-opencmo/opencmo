-- Đường tiền: khớp người mua bằng `customer_external_id`, và giữ
-- `profiles.email` không bị lỗi thời.
--
-- Trước migration này việc khớp tài khoản CHỈ dựa vào email trên webhook. Hai
-- cách hỏng, cùng một hậu quả — tiền vào, credit không bao giờ cộng, và route
-- trả 200 nên Polar không gửi lại:
--
--   1. Người mua gõ ở trang Polar một email khác email đăng nhập.
--   2. Người dùng đổi email trong Supabase Auth. `profiles.email` chỉ được ghi
--      một lần bởi `handle_new_user()`; không có trigger nào đồng bộ về sau.
--
-- (1) đóng bằng `external_id` — link checkout của ta gắn sẵn `profiles.id`.
-- (2) đóng bằng trigger dưới cùng.

begin;

-- ====================================================== process_polar_event
create or replace function public.process_polar_event(
 p_event_id text, p_event_type text, p_event_at timestamptz, p_data jsonb,
 p_purchase_plan text, p_credits integer, p_entitlement_plan text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
 v_customer text := coalesce(nullif(p_data->>'customer_id',''),nullif(p_data#>>'{customer,id}',''));
 v_email text := coalesce(p_data#>>'{customer,email}',p_data#>>'{user,email}',p_data->>'customer_email');
 -- `customer_external_id` do link checkout của ta gắn vào (`app/app/billing`).
 -- Nó là `profiles.id`, nên khớp bằng nó là khớp CHẮC; email chỉ là đường lùi
 -- cho những lần mua không đi qua link của ta.
 v_external text := coalesce(
   nullif(p_data#>>'{customer,external_id}',''),
   nullif(p_data->>'customer_external_id',''),
   nullif(p_data#>>'{customer,metadata,user_id}','')
 );
 v_external_user uuid;
 v_id text := nullif(p_data->>'id','');
 v_user uuid; v_link text; v_result jsonb; v_purchase public.polar_purchases%rowtype;
 v_sub jsonb; v_sub_id text; v_status text; v_version timestamptz; v_priority integer;
 v_granted integer := 0; v_rows integer; v_plan text;
begin
 if v_customer is null and nullif(v_email,'') is null and v_external is null then
  return jsonb_build_object('ok',true,'skipped','no email on event');
 end if;
 if p_event_id is null or p_event_id='' or p_event_at is null or v_id is null or v_customer is null then
  raise exception 'Invalid billing event.' using errcode='22023';
 end if;
 if p_event_type not in ('order.paid','order.refunded','subscription.active','subscription.canceled','subscription.revoked','subscription.past_due') then
  return jsonb_build_object('ok',true,'ignored',p_event_type);
 end if;
 if nullif(p_data#>>'{customer,id}','') is not null and p_data#>>'{customer,id}'<>v_customer then
  raise exception 'Conflicting billing customer.' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('polar:event:'||p_event_id,0));
 select result into v_result from public.polar_webhook_receipts where event_id=p_event_id;
 if found then return v_result || jsonb_build_object('duplicate',true,'credits',0); end if;
 perform pg_advisory_xact_lock(hashtextextended('polar:customer:'||v_customer,0));
 select user_id into v_user from public.polar_customers where customer_id=v_customer;
 if found then
  if v_user is null then return jsonb_build_object('ok',true,'skipped','account no longer exists'); end if;
  perform 1 from public.profiles where id=v_user for update;
  if not found then return jsonb_build_object('ok',true,'skipped','account no longer exists'); end if;
 else
  -- Khớp bằng external_id TRƯỚC. Email là chuỗi người mua tự gõ ở trang Polar;
  -- gõ khác email đăng nhập là tiền vào mà credit không bao giờ cộng, và route
  -- trả 200 nên Polar không gửi lại. `external_id` do ta gắn vào link checkout
  -- nên không có chỗ cho người dùng gõ sai.
  --
  -- Ép kiểu có canh regex: `external_id` là chuỗi tuỳ ý bên Polar, và một giá
  -- trị không phải uuid sẽ ném lỗi 22P02 — tức 500 và Polar retry vĩnh viễn.
  if v_external is not null
     and v_external ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
   select id,polar_customer_id into v_external_user,v_link
   from public.profiles where id=v_external::uuid for update;
   if found then v_user := v_external_user; end if;
  end if;

  if v_user is null then
   if nullif(v_email,'') is null then return jsonb_build_object('ok',true,'skipped','no email on event'); end if;
   if (select count(*) from public.profiles where lower(email)=lower(v_email))<>1 then
    return jsonb_build_object('ok',true,'skipped','no matching account');
   end if;
   select id,polar_customer_id into v_user,v_link from public.profiles where lower(email)=lower(v_email) for update;
  end if;

  if v_link is not null and v_link<>v_customer then return jsonb_build_object('ok',true,'skipped','account already linked'); end if;
  update public.profiles set polar_customer_id=v_customer where id=v_user;
  insert into public.polar_customers(customer_id,user_id) values(v_customer,v_user);
 end if;
 if p_event_type in ('order.paid','order.refunded') then
  insert into public.polar_purchases(order_id,customer_id,user_id,product_id,total_amount,currency)
  values(v_id,v_customer,v_user,p_data->>'product_id',coalesce((p_data->>'total_amount')::bigint,0),p_data->>'currency') on conflict(order_id) do nothing;
  select * into v_purchase from public.polar_purchases where order_id=v_id for update;
  if v_purchase.customer_id<>v_customer or v_purchase.user_id is distinct from v_user then
   raise exception 'Purchase belongs to another account.' using errcode='22023';
  end if;
  if p_event_type='order.paid' then
   if p_purchase_plan is null or p_purchase_plan not in ('starter','creator') or p_credits is null or p_credits<=0 then
    raise exception 'Invalid paid product.' using errcode='22023';
   end if;
   if not v_purchase.granted then
    if exists(select 1 from public.credit_ledger where external_id='polar:'||v_id and user_id is distinct from v_user) then
     raise exception 'Purchase belongs to another account.' using errcode='22023';
    end if;
    insert into public.credit_ledger(user_id,delta,reason,external_id) values(v_user,p_credits,p_purchase_plan||' plan purchase','polar:'||v_id)
    on conflict(external_id) where external_id is not null do nothing;
    get diagnostics v_rows=row_count;
    if v_rows=1 then v_granted:=p_credits; end if;
    update public.polar_purchases set granted=true,credits=p_credits,plan=p_purchase_plan,paid_at=p_event_at where order_id=v_id;
   end if;
   v_sub:=p_data->'subscription'; v_sub_id:=nullif(v_sub->>'id',''); v_status:=v_sub->>'status';
   v_version:=coalesce((v_sub->>'modified_at')::timestamptz,(v_sub->>'created_at')::timestamptz,p_event_at);
  else
   if coalesce((p_data->>'refunded_amount')::bigint,0)<0 or coalesce((p_data->>'refunded_tax_amount')::bigint,0)<0 then
    raise exception 'Invalid refund amount.' using errcode='22023';
   end if;
   update public.polar_purchases set
    refunded_amount=greatest(refunded_amount,coalesce((p_data->>'refunded_amount')::bigint,0)),
    refunded_tax_amount=greatest(refunded_tax_amount,coalesce((p_data->>'refunded_tax_amount')::bigint,0)),
    refunded_at=greatest(refunded_at,p_event_at) where order_id=v_id;
  end if;
 else
  v_sub:=p_data; v_sub_id:=v_id; v_status:=substr(p_event_type,length('subscription.')+1);
  v_version:=coalesce((p_data->>'modified_at')::timestamptz,p_event_at);
 end if;
 if v_sub_id is not null and v_status in ('active','past_due','canceled','revoked')
  and (p_event_type<>'order.paid' or p_entitlement_plan is not null) then
  v_priority:=case v_status when 'active' then 0 when 'past_due' then 1 when 'canceled' then 2 else 3 end;
  perform pg_advisory_xact_lock(hashtextextended('polar:subscription:'||v_sub_id,0));
  if exists(select 1 from public.polar_subscriptions where subscription_id=v_sub_id and (customer_id<>v_customer or user_id is distinct from v_user)) then
   raise exception 'Subscription belongs to another account.' using errcode='22023';
  end if;
  select plan into v_plan from public.polar_subscriptions where subscription_id=v_sub_id;
  v_plan:=coalesce(p_entitlement_plan,v_plan);
  -- A retired product with no stored subscription has no entitlement to change.
  -- This branch is unreachable for paid orders because their plan is validated above.
  if v_plan is null then return jsonb_build_object('ok',true,'skipped','unmapped subscription product'); end if;
  if v_plan not in ('starter','creator') then raise exception 'Invalid subscription product.' using errcode='22023'; end if;
  insert into public.polar_subscriptions(subscription_id,customer_id,user_id,plan,status,current_period_end,provider_updated_at,status_priority,event_id)
  values(v_sub_id,v_customer,v_user,v_plan,v_status,(v_sub->>'current_period_end')::timestamptz,v_version,v_priority,p_event_id)
  on conflict(subscription_id) do update set plan=excluded.plan,status=excluded.status,
   current_period_end=coalesce(excluded.current_period_end,polar_subscriptions.current_period_end),
   provider_updated_at=excluded.provider_updated_at,status_priority=excluded.status_priority,event_id=excluded.event_id
  where (excluded.provider_updated_at,excluded.status_priority)>(polar_subscriptions.provider_updated_at,polar_subscriptions.status_priority)
   and polar_subscriptions.customer_id=excluded.customer_id and polar_subscriptions.user_id=excluded.user_id;
  select plan into v_plan from public.polar_subscriptions where user_id=v_user and status<>'revoked'
  order by case plan when 'creator' then 2 else 1 end desc limit 1;
  update public.profiles set plan=coalesce(v_plan,'free') where id=v_user;
 end if;
 v_result:=jsonb_build_object('ok',true,'credits',v_granted);
 insert into public.polar_webhook_receipts(event_id,event_type,occurred_at,user_id,result) values(p_event_id,p_event_type,p_event_at,v_user,v_result);
 return v_result;
end;
$$;

revoke all on function public.process_polar_event(text,text,timestamptz,jsonb,text,integer,text) from public,anon,authenticated;
grant execute on function public.process_polar_event(text,text,timestamptz,jsonb,text,integer,text) to service_role;

-- ========================================= đồng bộ email từ auth.users
--
-- `handle_new_user()` chỉ chạy lúc INSERT. Đổi email xong thì `profiles.email`
-- trỏ vào hòm thư cũ, và đó chính là chuỗi mà webhook Polar dùng để tìm chủ tài
-- khoản ở nhánh lùi. Giữ nó đúng là một trigger bốn dòng.
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

revoke execute on function public.sync_profile_email() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.sync_profile_email();

commit;
