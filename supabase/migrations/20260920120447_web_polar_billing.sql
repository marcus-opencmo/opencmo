-- Receipt, purchase, mapping và entitlement nằm chung một transaction.
begin;
-- Mapping cũ trùng phải đối soát trước, không tự chọn người nhận tiền.
create unique index profiles_polar_customer_unique on public.profiles(polar_customer_id)
  where polar_customer_id is not null;
-- Giữ tombstone customer sau xoá tài khoản để email mới không chiếm mapping.
create table public.polar_customers (
 customer_id text primary key,
 user_id uuid unique references public.profiles(id) on delete set null
);
insert into public.polar_customers(customer_id,user_id)
 select polar_customer_id,id from public.profiles where polar_customer_id is not null;
create table public.polar_webhook_receipts (
  event_id text primary key, event_type text not null, occurred_at timestamptz not null,
  user_id uuid references public.profiles(id) on delete set null,
  result jsonb not null, received_at timestamptz not null default now()
);
create table public.polar_purchases (
  order_id text primary key, customer_id text not null,
  user_id uuid references public.profiles(id) on delete set null,
  product_id text, plan text, credits integer not null default 0 check (credits >= 0),
  granted boolean not null default false,
  total_amount bigint not null default 0 check (total_amount >= 0), currency text,
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  refunded_tax_amount bigint not null default 0 check (refunded_tax_amount >= 0),
  paid_at timestamptz, refunded_at timestamptz
);
create table public.polar_subscriptions (
  subscription_id text primary key, customer_id text not null,
  user_id uuid references public.profiles(id) on delete set null,
  plan text not null check (plan in ('starter','creator')),
  status text not null check (status in ('active','past_due','canceled','revoked')),
  current_period_end timestamptz, provider_updated_at timestamptz not null,
  status_priority integer not null, event_id text not null
);
create index polar_subscriptions_user_idx on public.polar_subscriptions(user_id);
alter table public.polar_webhook_receipts enable row level security;
alter table public.polar_customers enable row level security;
alter table public.polar_purchases enable row level security;
alter table public.polar_subscriptions enable row level security;
revoke all on public.polar_customers, public.polar_webhook_receipts, public.polar_purchases, public.polar_subscriptions from anon, authenticated;
grant all on public.polar_customers, public.polar_webhook_receipts, public.polar_purchases, public.polar_subscriptions to service_role;

create function public.process_polar_event(
 p_event_id text, p_event_type text, p_event_at timestamptz, p_data jsonb,
 p_purchase_plan text, p_credits integer, p_entitlement_plan text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
 v_customer text := coalesce(nullif(p_data->>'customer_id',''),nullif(p_data#>>'{customer,id}',''));
 v_email text := coalesce(p_data#>>'{customer,email}',p_data#>>'{user,email}',p_data->>'customer_email');
 v_id text := nullif(p_data->>'id','');
 v_user uuid; v_link text; v_result jsonb; v_purchase public.polar_purchases%rowtype;
 v_sub jsonb; v_sub_id text; v_status text; v_version timestamptz; v_priority integer;
 v_granted integer := 0; v_rows integer; v_plan text;
begin
 if v_customer is null and nullif(v_email,'') is null then
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
 -- Khoá event, customer rồi profile: dedup và ledger không có cửa sổ cạnh tranh.
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
  if nullif(v_email,'') is null then return jsonb_build_object('ok',true,'skipped','no email on event'); end if;
  if (select count(*) from public.profiles where lower(email)=lower(v_email))<>1 then
   return jsonb_build_object('ok',true,'skipped','no matching account');
  end if;
  select id,polar_customer_id into v_user,v_link from public.profiles where lower(email)=lower(v_email) for update;
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
   -- Chỉ sự kiện này xác nhận tiền đã nhận:
   -- https://polar.sh/docs/api-reference/webhooks/order.paid
   if p_purchase_plan is null or p_purchase_plan not in ('starter','creator') or p_credits is null or p_credits<=0 then
    raise exception 'Invalid paid product.' using errcode='22023';
   end if;
   if not v_purchase.granted then
    -- Giữ khóa cũ để không cấp lại purchase đã xử lý trước migration.
    if exists(select 1 from public.credit_ledger where external_id='polar:'||v_id and user_id is distinct from v_user) then
     raise exception 'Purchase belongs to another account.' using errcode='22023';
    end if;
    insert into public.credit_ledger(user_id,delta,reason,external_id) values(v_user,p_credits,p_purchase_plan||' plan purchase','polar:'||v_id)
    on conflict(external_id) where external_id is not null do nothing;
    get diagnostics v_rows=row_count;
    if v_rows=1 then v_granted:=p_credits; end if;
    update public.polar_purchases set granted=true,credits=p_credits,plan=p_purchase_plan,paid_at=p_event_at where order_id=v_id;
   end if;
   -- Snapshot phải dùng version CỦA subscription, không lấy version order mới.
   v_sub:=p_data->'subscription'; v_sub_id:=nullif(v_sub->>'id',''); v_status:=v_sub->>'status';
   v_version:=coalesce((v_sub->>'modified_at')::timestamptz,(v_sub->>'created_at')::timestamptz,p_event_at);
  else
   -- Tổng partial/full, không phải delta:
   -- https://polar.sh/docs/api-reference/webhooks/order.refunded
   -- Chưa quy thuộc consumption cho purchase: chỉ đối soát đúng order, KHÔNG
   -- trừ credit fungible và không tự suy ra subscription bị mất entitlement.
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
 -- Product subscription chưa map: vẫn ghi purchase nhưng không chiếm version
 -- entitlement bằng plan order hoặc plan cũ, để event lifecycle sửa được sau.
 if v_sub_id is not null and v_status in ('active','past_due','canceled','revoked')
  and (p_event_type<>'order.paid' or p_entitlement_plan is not null) then
  -- active có thể là recovery, không cấp credit:
  -- https://polar.sh/docs/api-reference/webhooks/subscription.active
  -- canceled giữ paid-through, revoked mới xác nhận mất quyền ngay:
  -- https://polar.sh/docs/api-reference/webhooks/subscription.canceled
  -- https://polar.sh/docs/api-reference/webhooks/subscription.revoked
  v_priority:=case v_status when 'active' then 0 when 'past_due' then 1 when 'canceled' then 2 else 3 end;
  perform pg_advisory_xact_lock(hashtextextended('polar:subscription:'||v_sub_id,0));
  if exists(select 1 from public.polar_subscriptions where subscription_id=v_sub_id and (customer_id<>v_customer or user_id is distinct from v_user)) then
   raise exception 'Subscription belongs to another account.' using errcode='22023';
  end if;
  select plan into v_plan from public.polar_subscriptions where subscription_id=v_sub_id;
  v_plan:=coalesce(p_entitlement_plan,v_plan);
  if v_plan is null or v_plan not in ('starter','creator') then raise exception 'Invalid subscription product.' using errcode='22023'; end if;
  insert into public.polar_subscriptions(subscription_id,customer_id,user_id,plan,status,current_period_end,provider_updated_at,status_priority,event_id)
  values(v_sub_id,v_customer,v_user,v_plan,v_status,(v_sub->>'current_period_end')::timestamptz,v_version,v_priority,p_event_id)
  on conflict(subscription_id) do update set plan=excluded.plan,status=excluded.status,
   current_period_end=coalesce(excluded.current_period_end,polar_subscriptions.current_period_end),
   provider_updated_at=excluded.provider_updated_at,status_priority=excluded.status_priority,event_id=excluded.event_id
  where (excluded.provider_updated_at,excluded.status_priority)>(polar_subscriptions.provider_updated_at,polar_subscriptions.status_priority)
   and polar_subscriptions.customer_id=excluded.customer_id and polar_subscriptions.user_id=excluded.user_id;
  -- canceled/past_due giữ quyền tới revoked mới hơn. Provider phải gửi revoked;
  -- webhook retries + receipt bền vững là cơ chế phục hồi khi delivery thất bại.
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
commit;
