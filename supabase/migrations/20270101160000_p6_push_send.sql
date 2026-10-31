-- 20270101160000: P6 C1 (F2), one push per new batch of cards.
--
-- The hourly cron asks which browsers have cards newer than their last push (`push_due`), sends each one push with
-- no payload (the service worker reads the count itself, signed in), then records the push service's answer
-- (`push_done`): 404 or 410 means the browser dropped the subscription, so the row goes.

begin;

alter table public.push_subscriptions add column last_pushed_at timestamptz;

-- Browsers to push (service role): push on for the founder, a card waiting that was raised (or released from the
-- daily budget, `released_at`) after this browser's last push (or after it subscribed), and an endpoint still on
-- the allowed push services.
create or replace function public.push_due(p_limit integer)
returns table (subscription_id uuid, user_id uuid, endpoint text, waiting integer)
language sql stable security definer set search_path = public
as $$
  select s.id, s.user_id, s.endpoint,
    (select count(*)::integer from public.approvals a where a.user_id = s.user_id and a.status = 'waiting')
  from public.push_subscriptions s
  where public.push_endpoint_allowed(s.endpoint)
    and not exists (select 1 from public.notify_settings n where n.user_id = s.user_id and not n.push)
    and exists (select 1 from public.approvals a where a.user_id = s.user_id and a.status = 'waiting'
                and coalesce(a.released_at, a.created_at) > coalesce(s.last_pushed_at, s.created_at))
  order by s.user_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function public.push_due(integer) from public, anon, authenticated;
grant execute on function public.push_due(integer) to service_role;

-- The push service's answer for one send (service role). Returns false when the row was removed.
create or replace function public.push_done(p_subscription uuid, p_status integer)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  if p_status in (404, 410) then
    delete from public.push_subscriptions where id = p_subscription;
    return false;
  end if;
  update public.push_subscriptions
  set last_pushed_at = case when p_status between 200 and 299 then now() else last_pushed_at end,
      failed_at = case when p_status between 200 and 299 then null else now() end
  where id = p_subscription;
  return true;
end;
$$;
revoke all on function public.push_done(uuid, integer) from public, anon, authenticated;
grant execute on function public.push_done(uuid, integer) to service_role;

commit;
