-- 20270101093000: P6, push endpoints only on the browsers' own push services.
--
-- The server sends a push by POSTing to the stored endpoint, so an endpoint is a URL our server calls. Any https URL
-- would let a founder point that call at an internal host. Only the push services browsers hand out are kept; the
-- sender (C1, lib/notify/push.ts) checks the same list before every send.

begin;

create or replace function public.push_endpoint_allowed(p_endpoint text)
returns boolean language sql immutable set search_path = public
as $$
  select p_endpoint is not null and char_length(p_endpoint) <= 1000
    and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^\s]+$';
$$;
revoke all on function public.push_endpoint_allowed(text) from public, anon;
revoke all on function public.push_endpoint_allowed(text) from authenticated;
grant execute on function public.push_endpoint_allowed(text) to service_role;

delete from public.push_subscriptions where not public.push_endpoint_allowed(endpoint);
alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_check;
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_check check (public.push_endpoint_allowed(endpoint));

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_id uuid;
begin
  if not public.push_endpoint_allowed(p_endpoint) then
    raise exception 'This browser''s push service is not supported.' using errcode = '22023';
  end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{20,200}={0,2}$' or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{8,100}={0,2}$' then
    raise exception 'The push keys are not valid.' using errcode = '22023';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = v_user and endpoint <> p_endpoint) >= 10 then
    raise exception 'Push is on in 10 browsers already. Turn it off in one first.' using errcode = 'P0001';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_user, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, failed_at = null
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

commit;
