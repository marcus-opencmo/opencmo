-- Review R3 (#141): a push subscription that keeps being refused (400/401/403, a rotated VAPID key) was never dropped:
-- push_done only deleted on 404/410, so push_due returned the row every hour forever, ordered by user_id with a limit,
-- and once enough such rows piled up the founders after them were never pushed.
--
-- Now: consecutive failures are counted, a subscription refused three times in a row is dropped (the browser
-- subscribes again when the founder turns push on), and rows that are failing come after healthy ones.

alter table public.push_subscriptions add column if not exists failures smallint not null default 0;

create or replace function public.push_done(p_subscription uuid, p_status integer) returns boolean
  language plpgsql security definer
  set search_path to 'public'
  as $$
begin
  if p_status in (404, 410) then
    delete from public.push_subscriptions where id = p_subscription;
    return false;
  end if;
  if p_status between 200 and 299 then
    update public.push_subscriptions set last_pushed_at = now(), failed_at = null, failures = 0 where id = p_subscription;
    return true;
  end if;
  -- The third refusal in a row: the push service will not take this subscription, so stop retrying it every hour.
  delete from public.push_subscriptions where id = p_subscription and failures >= 2;
  if found then
    return false;
  end if;
  update public.push_subscriptions set failed_at = now(), failures = failures + 1 where id = p_subscription;
  return true;
end;
$$;

create or replace function public.push_due(p_limit integer) returns table(subscription_id uuid, user_id uuid, endpoint text, waiting integer)
  language sql stable security definer
  set search_path to 'public'
  as $$
  select s.id, s.user_id, s.endpoint,
    (select count(*)::integer from public.approvals a where a.user_id = s.user_id and a.status = 'waiting')
  from public.push_subscriptions s
  where public.push_endpoint_allowed(s.endpoint)
    and not exists (select 1 from public.notify_settings n where n.user_id = s.user_id and not n.push)
    and exists (select 1 from public.approvals a where a.user_id = s.user_id and a.status = 'waiting'
                and coalesce(a.released_at, a.created_at) > coalesce(s.last_pushed_at, s.created_at))
  -- Healthy subscriptions first: failing ones cannot crowd them out of the limit.
  order by s.failures, s.user_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- Same grants as before (create or replace keeps them); restated so the intent is in this file.
revoke all on function public.push_done(uuid, integer) from public, anon, authenticated;
revoke all on function public.push_due(integer) from public, anon, authenticated;
grant execute on function public.push_done(uuid, integer) to service_role;
grant execute on function public.push_due(integer) to service_role;
